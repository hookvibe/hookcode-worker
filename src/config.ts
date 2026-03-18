import path from 'path';
import type { WorkerKind } from './protocol';
import { readWorkerCredentials, type WorkerCredentials } from './credentials';
import { resolveWorkerWorkDirRoot } from './workDir';

export interface WorkerConfig {
  backendUrl: string;
  wsUrl: string;
  workerId: string;
  workerToken: string;
  workerName: string;
  workerKind: WorkerKind;
  preview: boolean;
  heartbeatIntervalMs: number;
  maxConcurrency: number;
  runtimeInstallDir: string;
  workspaceRootDir: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  controlPollIntervalMs: number;
  cancelKillTimeoutMs: number;
  noopOnMissingCommand: boolean;
  execCommandTemplate?: string;
}

export interface WorkerRuntimeOptions {
  workDirRoot: string;
  bindCode?: string;
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const parsePositiveInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value ?? '');
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  const raw = trimString(value).toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

export const buildWorkerWsUrl = (backendUrl: string, workerId: string, workerToken: string): string => {
  const wsBase = backendUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '');
  const params = new URLSearchParams({ workerId, token: workerToken });
  return `${wsBase}/workers/connect?${params.toString()}`;
};

export const resolveWorkerRuntimeOptions = (env: NodeJS.ProcessEnv = process.env): WorkerRuntimeOptions => {
  const cwd = process.cwd();
  const workDirRoot = resolveWorkerWorkDirRoot(cwd, trimString(env.HOOKCODE_WORK_DIR));
  return {
    workDirRoot,
    bindCode: trimString(env.HOOKCODE_WORKER_BIND_CODE) || undefined
  };
};

export const parseWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
  credentials?: WorkerCredentials | null,
  options?: WorkerRuntimeOptions
): WorkerConfig => {
  const runtimeOptions = options ?? resolveWorkerRuntimeOptions(env);
  const storedCredentials = credentials ?? readWorkerCredentials(runtimeOptions.workDirRoot);
  const backendUrl = trimString(storedCredentials?.backendUrl).replace(/\/+$/, '');
  const workerId = trimString(storedCredentials?.workerId);
  const workerToken = trimString(storedCredentials?.workerToken);
  if (!backendUrl || !workerId || !workerToken) {
    throw new Error('Worker credentials are not configured. Run "hookcode-worker configure" first or provide HOOKCODE_WORKER_BIND_CODE.');
  }

  const workerKind: WorkerKind = trimString(env.HOOKCODE_WORKER_KIND) === 'remote' ? 'remote' : 'local';
  // Keep runtime installs and sticky workspaces colocated under HOOKCODE_WORK_DIR so worker storage is managed from a single root. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
  const runtimeInstallDir = path.join(runtimeOptions.workDirRoot, 'runtime');
  const workspaceRootDir = path.join(runtimeOptions.workDirRoot, 'workspaces');
  const execCommandTemplate = trimString(env.HOOKCODE_WORKER_EXEC_COMMAND) || undefined;

  return {
    backendUrl,
    wsUrl: buildWorkerWsUrl(backendUrl, workerId, workerToken),
    workerId,
    workerToken,
    workerName: trimString(env.HOOKCODE_WORKER_NAME) || 'HookCode Worker',
    workerKind,
    preview: parseBoolean(env.HOOKCODE_WORKER_PREVIEW),
    heartbeatIntervalMs: parsePositiveInt(env.HOOKCODE_WORKER_HEARTBEAT_MS, 10_000),
    maxConcurrency: parsePositiveInt(env.HOOKCODE_WORKER_MAX_CONCURRENCY, workerKind === 'local' ? 2 : 1),
    // Keep runtime vendor installs outside the package tree so the shipped worker stays small and first-run installs remain cacheable. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
    runtimeInstallDir,
    // Reuse one workspace per task group to mimic runner-style sticky workdirs without depending on backend filesystem access. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
    workspaceRootDir,
    reconnectMinMs: parsePositiveInt(env.HOOKCODE_WORKER_RECONNECT_MIN_MS, 1_000),
    reconnectMaxMs: parsePositiveInt(env.HOOKCODE_WORKER_RECONNECT_MAX_MS, 15_000),
    controlPollIntervalMs: parsePositiveInt(env.HOOKCODE_WORKER_CONTROL_POLL_MS, 2_000),
    cancelKillTimeoutMs: parsePositiveInt(env.HOOKCODE_WORKER_CANCEL_KILL_TIMEOUT_MS, 5_000),
    noopOnMissingCommand: parseBoolean(env.HOOKCODE_WORKER_NOOP_ON_MISSING_COMMAND),
    execCommandTemplate
  };
};

export const readWorkerConfig = parseWorkerConfig;
