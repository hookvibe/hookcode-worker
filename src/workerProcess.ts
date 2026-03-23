import { hostname } from 'os';
import WebSocket from 'ws';
import { BackendInternalApiClient } from './backend/internalApiClient';
import { parseWorkerConfig, WorkerConfig } from './config';
import { readPackageVersion } from './packageInfo';
import {
  BackendToWorkerMessage,
  isBackendToWorkerMessage,
  WorkerCapabilities,
  WorkerRuntimeState,
  WorkerToBackendMessage
} from './protocol';
import { detectHostCapabilities } from './runtime/hostCapabilities';
import {
  applyWorkerVendorNodePath,
  prepareRuntimeProviders,
  resolvePreparedProviders,
  resolveTaskProvidersFromContext
} from './runtime/prepareRuntime';
import { WorkerTaskExecutionError } from './runtime/executionError';
import { runTaskExecution } from './runtime/taskExecution';
import { executeTaskWorkspaceOperation, TaskWorkspaceError } from './runtime/taskWorkspace';
import { resolveTaskWorkspaceDir } from './runtime/taskCommand';

interface ActiveTaskEntry {
  abortController: AbortController;
  abortReason?: 'manual_stop' | 'deleted';
  pollTimer?: NodeJS.Timeout;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class WorkerProcess {
  private readonly config: WorkerConfig;
  private readonly client: BackendInternalApiClient;
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private readonly pendingTaskIds: string[] = [];
  private readonly activeTasks = new Map<string, ActiveTaskEntry>();
  private runtimeState: WorkerRuntimeState;
  private preparingRuntimePromise: Promise<void> | null = null;
  private capabilities: WorkerCapabilities;
  private shuttingDown = false;

  constructor(config: WorkerConfig = parseWorkerConfig()) {
    this.config = config;
    this.client = new BackendInternalApiClient(config.backendUrl, config.workerId, config.workerToken);
    this.reconnectDelayMs = config.reconnectMinMs;
    applyWorkerVendorNodePath(config.runtimeInstallDir);
    this.runtimeState = {
      preparedProviders: resolvePreparedProviders(),
      preparingProviders: [],
      lastPrepareAt: undefined,
      lastPrepareError: undefined
    };
    this.capabilities = detectHostCapabilities(this.config.preview, this.runtimeState);
  }

  async start(): Promise<void> {
    // Keep the standalone worker alive across initial dial failures so local/remote executors retry instead of exiting with code 1. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
    await this.connect();
  }

  /**
   * Gracefully shut down the worker: abort all active tasks, clear the queue,
   * close the WebSocket, and stop all timers.  Returns after all active tasks
   * have settled so that finalization messages are sent before the process
   * exits.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Clear pending queue so no new tasks start.
    this.pendingTaskIds.length = 0;

    // Abort every active task and wait for them to settle.
    const inflight: Promise<void>[] = [];
    for (const [taskId, entry] of this.activeTasks) {
      entry.abortReason = 'manual_stop';
      entry.abortController.abort();
      // startTask's try-catch-finally will handle finalization and removal
      // from activeTasks; we just need to wait for that to complete.
      inflight.push(
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (!this.activeTasks.has(taskId)) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        })
      );
    }
    if (inflight.length > 0) {
      // Give tasks a reasonable window to finalize.
      await Promise.race([Promise.all(inflight), sleep(10_000)]);
    }

    // Tear down heartbeat and WebSocket.
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  private currentActiveTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }

  private refreshCapabilities(): void {
    this.capabilities = detectHostCapabilities(this.config.preview, this.runtimeState);
  }

  private send(payload: WorkerToBackendMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private sendHello(): void {
    this.refreshCapabilities();
    this.send({
      type: 'hello',
      version: readPackageVersion(),
      platform: process.platform,
      arch: process.arch,
      hostname: hostname(),
      capabilities: this.capabilities,
      runtimeState: this.runtimeState,
      maxConcurrency: this.config.maxConcurrency,
      activeTaskIds: this.currentActiveTaskIds()
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: 'heartbeat',
        runtimeState: this.runtimeState,
        activeTaskIds: this.currentActiveTaskIds()
      });
    }, this.config.heartbeatIntervalMs);
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve) => {
      let opened = false;
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const socket = new WebSocket(this.config.wsUrl);
      this.socket = socket;

      socket.once('open', () => {
        opened = true;
        this.reconnectDelayMs = this.config.reconnectMinMs;
        this.sendHello();
        this.startHeartbeat();
        resolveOnce();
      });

      socket.on('message', (raw) => {
        void this.handleSocketMessage(raw);
      });

      socket.on('close', () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.socket = null;
        // Resolve startup even when the first dial fails so the process stays alive and retries in the background. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
        resolveOnce();
        void this.scheduleReconnect();
      });

      socket.on('error', (error) => {
        console.error('[worker] websocket error', error);
        if (!opened) {
          return;
        }
      });
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.shuttingDown) return;
    await sleep(this.reconnectDelayMs);
    if (this.shuttingDown) return;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.reconnectMaxMs);
    try {
      await this.connect();
    } catch (error) {
      console.error('[worker] reconnect failed', error);
      void this.scheduleReconnect();
    }
  }

  private async handleSocketMessage(raw: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isBackendToWorkerMessage(parsed)) return;

    const message = parsed as BackendToWorkerMessage;
    if (message.type === 'assignTask') {
      this.enqueueTask(message.taskId);
      return;
    }
    if (message.type === 'cancelTask') {
      this.cancelTask(message.taskId);
      return;
    }
    if (message.type === 'prepareRuntime') {
      await this.prepareRuntime(message.providers);
      return;
    }
    if (message.type === 'ping') {
      this.sendHello();
      return;
    }
    if (message.type === 'workspaceRequest') {
      await this.handleWorkspaceRequest(message);
    }
  }

  private enqueueTask(taskId: string): void {
    if (this.activeTasks.has(taskId) || this.pendingTaskIds.includes(taskId)) return;
    this.pendingTaskIds.push(taskId);
    void this.drainQueue();
  }

  private cancelTask(taskId: string): void {
    const queuedIndex = this.pendingTaskIds.indexOf(taskId);
    if (queuedIndex >= 0) {
      this.pendingTaskIds.splice(queuedIndex, 1);
      return;
    }
    const activeTask = this.activeTasks.get(taskId);
    if (!activeTask) return;
    activeTask.abortReason = 'manual_stop';
    activeTask.abortController.abort();
  }

  private async prepareRuntime(providers?: string[]): Promise<void> {
    const targetProviders = providers && providers.length > 0 ? providers : ['codex', 'claude_code', 'gemini_cli'];

    // If an install is already running, wait for it to finish first.
    // After it completes, check whether the requested providers are now
    // satisfied.  If any are still missing, a follow-up install pass will
    // run (serialised by the module-level mutex in prepareRuntimeProviders).
    if (this.preparingRuntimePromise) {
      await this.preparingRuntimePromise;
      const alreadyPrepared = this.runtimeState.preparedProviders ?? [];
      const stillMissing = targetProviders.filter((p) => !alreadyPrepared.includes(p));
      if (stillMissing.length === 0) return;
      // Fall through to trigger a follow-up install for the missing providers.
    }

    this.runtimeState = {
      ...this.runtimeState,
      preparingProviders: targetProviders,
      lastPrepareAt: new Date().toISOString(),
      lastPrepareError: undefined
    };
    this.send({ type: 'runtimePrepareStarted', providers: targetProviders });

    this.preparingRuntimePromise = (async () => {
      try {
        this.runtimeState = await prepareRuntimeProviders(this.config.runtimeInstallDir, targetProviders, this.runtimeState);
        this.refreshCapabilities();
        this.send({ type: 'runtimePrepareFinished', providers: targetProviders, runtimeState: this.runtimeState });
      } catch (error) {
        this.runtimeState = {
          ...this.runtimeState,
          preparingProviders: [],
          lastPrepareAt: new Date().toISOString(),
          lastPrepareError: getErrorMessage(error)
        };
        this.send({
          type: 'runtimePrepareFinished',
          providers: targetProviders,
          runtimeState: this.runtimeState,
          error: this.runtimeState.lastPrepareError
        });
      } finally {
        this.preparingRuntimePromise = null;
      }
    })();

    return this.preparingRuntimePromise;
  }

  private async handleWorkspaceRequest(message: Extract<BackendToWorkerMessage, { type: 'workspaceRequest' }>): Promise<void> {
    try {
      const context = await this.client.getTaskContext(message.taskId);
      const task = (context.task ?? {}) as Record<string, unknown>;
      const taskGroupId =
        (typeof task.taskGroupId === 'string' ? task.taskGroupId.trim() : '') ||
        (typeof task.groupId === 'string' ? task.groupId.trim() : '');
      const ensuredGroupId = taskGroupId ? taskGroupId : (await this.client.ensureGroupId(message.taskId)).groupId ?? undefined;
      const workspaceDir = resolveTaskWorkspaceDir(this.config.workspaceRootDir, task, { groupId: ensuredGroupId ?? undefined });
      const result = await executeTaskWorkspaceOperation({
        repoDir: workspaceDir,
        action: message.action,
        paths: message.payload?.paths,
        message: message.payload?.message
      });
      this.send({
        type: 'workspaceResponse',
        requestId: message.requestId,
        taskId: message.taskId,
        success: true,
        result: result as Record<string, unknown>
      });
    } catch (error) {
      const workspaceError = error instanceof TaskWorkspaceError ? error : null;
      this.send({
        type: 'workspaceResponse',
        requestId: message.requestId,
        taskId: message.taskId,
        success: false,
        error: {
          code: workspaceError?.code ?? 'WORKSPACE_REQUEST_FAILED',
          message: workspaceError?.message ?? getErrorMessage(error)
        }
      });
    }
  }

  private startTaskControlPolling(taskId: string, activeTask: ActiveTaskEntry): void {
    activeTask.pollTimer = setInterval(() => {
      void (async () => {
        try {
          const state = await this.client.getTaskControlState(taskId);
          if (!state) {
            activeTask.abortReason = 'deleted';
            activeTask.abortController.abort();
            return;
          }
          if (state.stopRequested) {
            activeTask.abortReason = 'manual_stop';
            activeTask.abortController.abort();
          }
        } catch (error) {
          console.warn('[worker] control-state polling failed', { taskId, error: getErrorMessage(error) });
        }
      })();
    }, this.config.controlPollIntervalMs);
  }

  private stopTaskControlPolling(activeTask: ActiveTaskEntry): void {
    if (!activeTask.pollTimer) return;
    clearInterval(activeTask.pollTimer);
    activeTask.pollTimer = undefined;
  }

  private async drainQueue(): Promise<void> {
    while (!this.shuttingDown && this.activeTasks.size < this.config.maxConcurrency && this.pendingTaskIds.length > 0) {
      const taskId = this.pendingTaskIds.shift();
      if (!taskId) return;
      this.startTask(taskId).catch((err) => console.error('[worker] startTask unexpected error', { taskId, error: getErrorMessage(err) }));
    }
  }

  private async startTask(taskId: string): Promise<void> {
    if (this.activeTasks.has(taskId)) return;

    const activeTask: ActiveTaskEntry = { abortController: new AbortController() };
    this.activeTasks.set(taskId, activeTask);
    this.send({ type: 'taskAccepted', taskId });
    this.sendHello();

    const startedAt = Date.now();
    try {
      const context = await this.client.getTaskContext(taskId);
      const providers = resolveTaskProvidersFromContext({
        task: context.task ?? undefined,
        robotsInRepo: context.robotsInRepo ?? []
      });
      await this.prepareRuntime(providers);
      this.startTaskControlPolling(taskId, activeTask);
      const result = await runTaskExecution({
        client: this.client,
        config: this.config,
        context,
        taskId,
        signal: activeTask.abortController.signal,
        stopReason: activeTask.abortReason,
        prepareRuntime: (p) => this.prepareRuntime(p)
      });
      if (!result.handledByBackend) {
        // Skip duplicate finalization when the local worker delegated execution back to backend inline mode. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
        await this.client.finalizeTask(taskId, {
          status: 'succeeded',
          outputText: result.outputText,
          gitStatus: result.gitStatus,
          providerCommentUrl: result.providerCommentUrl,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      const executionError = error instanceof WorkerTaskExecutionError ? error : null;
      await this.client.finalizeTask(taskId, {
        status: 'failed',
        message: getErrorMessage(error),
        providerCommentUrl: executionError?.providerCommentUrl,
        gitStatus: executionError?.gitStatus,
        durationMs: Date.now() - startedAt,
        stopReason: activeTask.abortReason
      });
    } finally {
      this.stopTaskControlPolling(activeTask);
      this.activeTasks.delete(taskId);
      this.send({
        type: 'heartbeat',
        runtimeState: this.runtimeState,
        activeTaskIds: this.currentActiveTaskIds()
      });
      void this.drainQueue();
    }
  }
}
