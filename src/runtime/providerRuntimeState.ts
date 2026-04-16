import type {
  WorkerProviderKey,
  WorkerProviderRuntimeStatuses,
  WorkerRuntimeState
} from '../protocol';

// Centralize worker-side provider availability derivation so hello/heartbeat payloads stay consistent with task-execution guards. docs/en/developer/plans/7i9tp61el8rrb4r7j5xj/task_plan.md 7i9tp61el8rrb4r7j5xj
export const WORKER_PROVIDER_KEYS: WorkerProviderKey[] = ['codex', 'claude_code', 'gemini_cli'];

const cloneProviderStatuses = (value?: WorkerProviderRuntimeStatuses | null): WorkerProviderRuntimeStatuses => {
  const next: WorkerProviderRuntimeStatuses = {};
  for (const provider of WORKER_PROVIDER_KEYS) {
    if (!value?.[provider]) continue;
    next[provider] = { ...value[provider] };
  }
  return next;
};

const resolveAvailableProviders = (statuses: WorkerProviderRuntimeStatuses): WorkerProviderKey[] =>
  WORKER_PROVIDER_KEYS.filter((provider) => statuses[provider]?.status === 'ready');

const resolveLastCheckError = (statuses: WorkerProviderRuntimeStatuses): string | undefined => {
  const errors = WORKER_PROVIDER_KEYS
    .map((provider) => statuses[provider]?.error?.trim())
    .filter(Boolean);
  return errors.length ? errors.join(' | ') : undefined;
};

export const normalizeWorkerProviderKey = (value: unknown): WorkerProviderKey | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return WORKER_PROVIDER_KEYS.find((provider) => provider === normalized) ?? null;
};

export const buildWorkerRuntimeState = (
  providerStatuses: WorkerProviderRuntimeStatuses,
  overrides?: Partial<WorkerRuntimeState>
): WorkerRuntimeState => ({
  ...overrides,
  providerStatuses,
  availableProviders: resolveAvailableProviders(providerStatuses),
  lastCheckedAt: overrides?.lastCheckedAt,
  lastCheckError: resolveLastCheckError(providerStatuses) ?? overrides?.lastCheckError
});

export const cloneWorkerRuntimeState = (runtimeState?: WorkerRuntimeState | null): WorkerRuntimeState | undefined => {
  if (!runtimeState) return undefined;
  return buildWorkerRuntimeState(cloneProviderStatuses(runtimeState.providerStatuses), {
    ...runtimeState
  });
};
