import path from 'path';
import type { WorkerKind } from './protocol';
import { readWorkerCredentials, type WorkerCredentials } from './credentials';
import { resolveWorkerWorkDirRoot } from './workDir';

export interface WorkerConfig {
  backendUrl: string;
  apiKey: string;
  workerName: string;
  workerKind: WorkerKind;
  preview: boolean;
  pollIntervalMs: number;
  maxConcurrency: number;
  runtimeInstallDir: string;
  workspaceRootDir: string;
  controlPollIntervalMs: number;
  cancelKillTimeoutMs: number;
  noopOnMissingCommand: boolean;
  execCommandTemplate?: string;
}

export interface WorkerRuntimeOptions {
  workDirRoot: string;
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

export const resolveWorkerRuntimeOptions = (env: NodeJS.ProcessEnv = process.env): WorkerRuntimeOptions => {
  const cwd = process.cwd();
  const workDirRoot = resolveWorkerWorkDirRoot(cwd, trimString(env.HOOKCODE_WORK_DIR));
  return { workDirRoot };
};

export const parseWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
  credentials?: WorkerCredentials | null,
  options?: WorkerRuntimeOptions
): WorkerConfig => {
  const runtimeOptions = options ?? resolveWorkerRuntimeOptions(env);
  const storedCredentials = credentials ?? readWorkerCredentials(runtimeOptions.workDirRoot);

  const backendUrl = trimString(storedCredentials?.backendUrl).replace(/\/+$/, '');
  const apiKey = trimString(storedCredentials?.apiKey) || trimString(env.HOOKCODE_WORKER_API_KEY);
  if (!backendUrl || !apiKey) {
    throw new Error('Worker credentials are not configured. Provide HOOKCODE_WORKER_API_KEY and backend URL, or run "hookcode-worker configure".');
  }

  const workerKind: WorkerKind = 'remote';
  const runtimeInstallDir = path.join(runtimeOptions.workDirRoot, 'runtime');
  const workspaceRootDir = path.join(runtimeOptions.workDirRoot, 'workspaces');
  const execCommandTemplate = trimString(env.HOOKCODE_WORKER_EXEC_COMMAND) || undefined;

  return {
    backendUrl,
    apiKey,
    workerName: trimString(env.HOOKCODE_WORKER_NAME) || 'HookCode Worker',
    workerKind,
    preview: parseBoolean(env.HOOKCODE_WORKER_PREVIEW),
    pollIntervalMs: parsePositiveInt(env.HOOKCODE_WORKER_POLL_INTERVAL_MS, 2_000),
    maxConcurrency: parsePositiveInt(env.HOOKCODE_WORKER_MAX_CONCURRENCY, 1),
    runtimeInstallDir,
    workspaceRootDir,
    controlPollIntervalMs: parsePositiveInt(env.HOOKCODE_WORKER_CONTROL_POLL_MS, 2_000),
    cancelKillTimeoutMs: parsePositiveInt(env.HOOKCODE_WORKER_CANCEL_KILL_TIMEOUT_MS, 5_000),
    noopOnMissingCommand: parseBoolean(env.HOOKCODE_WORKER_NOOP_ON_MISSING_COMMAND),
    execCommandTemplate
  };
};

export const readWorkerConfig = parseWorkerConfig;
