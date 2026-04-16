import { hostname } from 'os';
import { BackendInternalApiClient } from './backend/internalApiClient';
import { parseWorkerConfig, WorkerConfig } from './config';
import { readPackageVersion } from './packageInfo';
import type { WorkerCapabilities, WorkerPollRequest, WorkerProviderKey, WorkerRuntimeState } from './protocol';
import { detectHostCapabilities } from './runtime/hostCapabilities';
import {
  prepareRuntimeProviders,
  resolvePreparedProviders,
  resolveTaskProvidersFromContext
} from './runtime/prepareRuntime';
import { markWorkerProviderReady } from './runtime/providerRuntimeState';
import { WorkerTaskExecutionError } from './runtime/executionError';
import { runTaskExecution } from './runtime/taskExecution';

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
  private readonly activeTasks = new Map<string, ActiveTaskEntry>();
  private runtimeState: WorkerRuntimeState;
  private capabilities: WorkerCapabilities;
  private shuttingDown = false;
  private pollLoopRunning = false;

  constructor(config: WorkerConfig = parseWorkerConfig()) {
    this.config = config;
    this.client = new BackendInternalApiClient(config.backendUrl, config.apiKey);
    this.runtimeState = resolvePreparedProviders().reduce<WorkerRuntimeState>(
      (state, provider) =>
        markWorkerProviderReady(state, provider, {
          finishedAt: new Date().toISOString()
        }),
      {
        preparedProviders: [],
        preparingProviders: [],
        lastPrepareAt: undefined,
        lastPrepareError: undefined
      }
    );
    this.capabilities = detectHostCapabilities(this.config.preview, this.runtimeState);
  }

  async start(): Promise<void> {
    console.log('[worker] starting poll loop', { backend: this.config.backendUrl, maxConcurrency: this.config.maxConcurrency });
    this.pollLoopRunning = true;
    void this.pollLoop();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.pollLoopRunning = false;

    // Abort every active task and wait for them to settle.
    const inflight: Promise<void>[] = [];
    for (const [taskId, entry] of this.activeTasks) {
      entry.abortReason = 'manual_stop';
      entry.abortController.abort();
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
      await Promise.race([Promise.all(inflight), sleep(10_000)]);
    }
  }

  private currentActiveTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }

  private refreshCapabilities(): void {
    this.capabilities = detectHostCapabilities(this.config.preview, this.runtimeState);
  }

  private hasCapacity(): boolean {
    return this.activeTasks.size < this.config.maxConcurrency;
  }

  private buildPollRequest(): WorkerPollRequest {
    this.refreshCapabilities();
    return {
      version: readPackageVersion(),
      platform: process.platform,
      arch: process.arch,
      hostname: hostname(),
      capabilities: this.capabilities,
      activeTaskIds: this.currentActiveTaskIds(),
      maxConcurrency: this.config.maxConcurrency,
      providers: this.runtimeState.preparedProviders as WorkerProviderKey[] | undefined
    };
  }

  // ── Poll Loop ──

  private async pollLoop(): Promise<void> {
    while (this.pollLoopRunning && !this.shuttingDown) {
      try {
        if (this.hasCapacity()) {
          const response = await this.client.pollForTask(this.buildPollRequest());
          if (response.task?.taskId) {
            this.startTask(response.task.taskId).catch((err) =>
              console.error('[worker] startTask unexpected error', { taskId: response.task!.taskId, error: getErrorMessage(err) })
            );
          }
        } else {
          // At capacity — send heartbeat instead of polling for new tasks.
          await this.client.heartbeat({
            activeTaskIds: this.currentActiveTaskIds(),
            providers: this.runtimeState.preparedProviders as WorkerProviderKey[] | undefined
          });
        }
      } catch (error) {
        console.warn('[worker] poll failed, retrying...', getErrorMessage(error));
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  // ── Task Lifecycle ──

  private cancelTask(taskId: string): void {
    const activeTask = this.activeTasks.get(taskId);
    if (!activeTask) return;
    activeTask.abortReason = 'manual_stop';
    activeTask.abortController.abort();
  }

  private async prepareRuntime(providers?: string[]): Promise<void> {
    this.runtimeState = await prepareRuntimeProviders(
      this.config.runtimeInstallDir,
      providers,
      this.runtimeState,
      (runtimeState) => {
        this.runtimeState = runtimeState;
        this.refreshCapabilities();
      }
    );
    this.refreshCapabilities();
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

  private async startTask(taskId: string): Promise<void> {
    if (this.activeTasks.has(taskId)) return;

    const activeTask: ActiveTaskEntry = { abortController: new AbortController() };
    this.activeTasks.set(taskId, activeTask);

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
    }
  }
}
