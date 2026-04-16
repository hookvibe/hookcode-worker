export type WorkerKind = 'local' | 'remote';
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
  // Carry provider-level install progress so the backend can surface live Codex/Claude/Gemini readiness instead of one opaque runtime flag. docs/en/developer/plans/7i9tp61el8rrb4r7j5xj/task_plan.md 7i9tp61el8rrb4r7j5xj
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

export type WorkerHelloMessage = {
  type: 'hello';
  version?: string;
  platform?: string;
  arch?: string;
  hostname?: string;
  capabilities?: WorkerCapabilities;
  runtimeState?: WorkerRuntimeState;
  maxConcurrency?: number;
  activeTaskIds?: string[];
};

export type WorkerHeartbeatMessage = {
  type: 'heartbeat';
  runtimeState?: WorkerRuntimeState;
  activeTaskIds?: string[];
};

export type WorkerTaskAcceptedMessage = {
  type: 'taskAccepted';
  taskId: string;
};

export type WorkerRuntimePrepareStartedMessage = {
  type: 'runtimePrepareStarted';
  providers?: WorkerProviderKey[];
  runtimeState?: WorkerRuntimeState;
};

export type WorkerRuntimePrepareFinishedMessage = {
  type: 'runtimePrepareFinished';
  providers?: WorkerProviderKey[];
  runtimeState?: WorkerRuntimeState;
  error?: string;
};

export type WorkerWorkspaceResponseMessage = {
  type: 'workspaceResponse';
  requestId: string;
  taskId: string;
  success: boolean;
  result?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
  };
};

export type WorkerToBackendMessage =
  | WorkerHelloMessage
  | WorkerHeartbeatMessage
  | WorkerTaskAcceptedMessage
  | WorkerRuntimePrepareStartedMessage
  | WorkerRuntimePrepareFinishedMessage
  | WorkerWorkspaceResponseMessage;

export type WorkerAssignTaskMessage = {
  type: 'assignTask';
  taskId: string;
};

export type WorkerPrepareRuntimeMessage = {
  type: 'prepareRuntime';
  providers?: WorkerProviderKey[];
};

export type WorkerCancelTaskMessage = {
  type: 'cancelTask';
  taskId: string;
};

export type WorkerPingMessage = {
  type: 'ping';
};

export type WorkerWorkspaceRequestMessage = {
  type: 'workspaceRequest';
  requestId: string;
  taskId: string;
  action: 'snapshot' | 'stage' | 'unstage' | 'discard' | 'delete_untracked' | 'commit';
  payload?: {
    paths?: string[];
    message?: string;
  };
};

export type BackendToWorkerMessage =
  | WorkerAssignTaskMessage
  | WorkerPrepareRuntimeMessage
  | WorkerCancelTaskMessage
  | WorkerPingMessage
  | WorkerWorkspaceRequestMessage;

export const isBackendToWorkerMessage = (value: unknown): value is BackendToWorkerMessage => {
  // Parse only the small worker control protocol so reconnects stay resilient to malformed backend frames. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
  if (!value || typeof value !== 'object') return false;
  const type = String((value as { type?: unknown }).type ?? '');
  return (
    type === 'assignTask' ||
    type === 'prepareRuntime' ||
    type === 'cancelTask' ||
    type === 'ping' ||
    type === 'workspaceRequest'
  );
};
