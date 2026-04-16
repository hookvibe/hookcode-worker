import type {
  WorkerProviderKey,
  WorkerProviderRuntimeEntry,
  WorkerProviderRuntimeStatuses,
  WorkerRuntimeState
} from '../protocol';

// Keep worker-side provider runtime bookkeeping in one place so incremental prepare progress stays consistent across websocket updates and heartbeat snapshots. docs/en/developer/plans/7i9tp61el8rrb4r7j5xj/task_plan.md 7i9tp61el8rrb4r7j5xj
export const WORKER_PROVIDER_KEYS: WorkerProviderKey[] = ['codex', 'claude_code', 'gemini_cli'];

const cloneProviderStatuses = (value?: WorkerProviderRuntimeStatuses | null): WorkerProviderRuntimeStatuses => {
  const next: WorkerProviderRuntimeStatuses = {};
  for (const provider of WORKER_PROVIDER_KEYS) {
    if (!value?.[provider]) continue;
    next[provider] = { ...value[provider] };
  }
  return next;
};

const resolvePreparedProviders = (statuses: WorkerProviderRuntimeStatuses): WorkerProviderKey[] =>
  WORKER_PROVIDER_KEYS.filter((provider) => statuses[provider]?.status === 'ready');

const resolvePreparingProviders = (statuses: WorkerProviderRuntimeStatuses): WorkerProviderKey[] =>
  WORKER_PROVIDER_KEYS.filter((provider) => statuses[provider]?.status === 'preparing');

const resolveLastPrepareError = (statuses: WorkerProviderRuntimeStatuses): string | undefined => {
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
  preparedProviders: resolvePreparedProviders(providerStatuses),
  preparingProviders: resolvePreparingProviders(providerStatuses),
  lastPrepareError: resolveLastPrepareError(providerStatuses) ?? overrides?.lastPrepareError
});

export const updateWorkerProviderRuntimeEntry = (
  runtimeState: WorkerRuntimeState | undefined,
  provider: WorkerProviderKey,
  nextEntry: WorkerProviderRuntimeEntry,
  overrides?: Partial<WorkerRuntimeState>
): WorkerRuntimeState => {
  const providerStatuses = cloneProviderStatuses(runtimeState?.providerStatuses);
  providerStatuses[provider] = nextEntry;
  return buildWorkerRuntimeState(providerStatuses, {
    ...runtimeState,
    ...overrides
  });
};

export const markWorkerProvidersPreparing = (
  runtimeState: WorkerRuntimeState | undefined,
  providers: WorkerProviderKey[],
  startedAt: string
): WorkerRuntimeState => {
  let nextState = runtimeState;
  for (const provider of providers) {
    nextState = updateWorkerProviderRuntimeEntry(
      nextState,
      provider,
      {
        status: 'preparing',
        startedAt,
        finishedAt: undefined,
        error: undefined
      },
      { lastPrepareAt: startedAt, lastPrepareError: undefined }
    );
  }
  return nextState ?? { preparedProviders: [], preparingProviders: [], lastPrepareAt: startedAt };
};

export const markWorkerProviderReady = (
  runtimeState: WorkerRuntimeState | undefined,
  provider: WorkerProviderKey,
  params: { startedAt?: string; finishedAt: string }
): WorkerRuntimeState =>
  updateWorkerProviderRuntimeEntry(
    runtimeState,
    provider,
    {
      status: 'ready',
      startedAt: params.startedAt ?? runtimeState?.providerStatuses?.[provider]?.startedAt,
      finishedAt: params.finishedAt,
      error: undefined
    },
    { lastPrepareAt: params.finishedAt }
  );

export const markWorkerProviderError = (
  runtimeState: WorkerRuntimeState | undefined,
  provider: WorkerProviderKey,
  params: { startedAt?: string; finishedAt: string; error: string }
): WorkerRuntimeState =>
  updateWorkerProviderRuntimeEntry(
    runtimeState,
    provider,
    {
      status: 'error',
      startedAt: params.startedAt ?? runtimeState?.providerStatuses?.[provider]?.startedAt,
      finishedAt: params.finishedAt,
      error: params.error
    },
    { lastPrepareAt: params.finishedAt }
  );
