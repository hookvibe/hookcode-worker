export type WorkerKind = 'remote';
export type WorkerProviderKey = 'codex' | 'claude_code' | 'gemini_cli';
export type WorkerProviderRuntimeStatus = 'idle' | 'preparing' | 'ready' | 'error';

export interface WorkerProviderRuntimeEntry {
  status: WorkerProviderRuntimeStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export type WorkerProviderRuntimeStatuses = Partial<Record<WorkerProviderKey, WorkerProviderRuntimeEntry>>;

export interface WorkerRuntimeState {
  providerStatuses?: WorkerProviderRuntimeStatuses;
  preparedProviders?: WorkerProviderKey[];
  preparingProviders?: WorkerProviderKey[];
  lastPrepareAt?: string;
  lastPrepareError?: string;
}

export interface WorkerCapabilities {
  preview?: boolean;
  runtimes?: Array<{ language: string; version?: string; path?: string }>;
  providers?: WorkerProviderKey[];
}

// ── HTTP Pull Protocol ──

/** POST /workers/internal/poll — request body */
export interface WorkerPollRequest {
  version?: string;
  platform?: string;
  arch?: string;
  hostname?: string;
  capabilities?: WorkerCapabilities;
  activeTaskIds?: string[];
  maxConcurrency?: number;
  providers?: WorkerProviderKey[];
}

/** POST /workers/internal/poll — response body */
export interface WorkerPollResponse {
  /** null when no task is available */
  task: { taskId: string } | null;
}

/** POST /workers/internal/heartbeat — request body */
export interface WorkerHeartbeatRequest {
  activeTaskIds?: string[];
  providers?: WorkerProviderKey[];
}

/** POST /workers/internal/tasks/:id/accept — request body */
export interface WorkerTaskAcceptRequest {
  taskId: string;
}

/** POST /workers/internal/tasks/:id/finalize — request body */
export interface WorkerTaskFinalizeRequest {
  taskId: string;
  status: 'succeeded' | 'failed';
  message?: string;
  providerCommentUrl?: string;
  outputText?: string;
  gitStatus?: unknown;
  durationMs?: number;
  stopReason?: 'manual_stop' | 'deleted' | 'runtime_limit';
}
