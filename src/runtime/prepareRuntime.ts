import type { WorkerProviderKey, WorkerRuntimeState } from '../protocol';
import {
  markWorkerProviderError,
  markWorkerProviderReady,
  normalizeWorkerProviderKey,
  WORKER_PROVIDER_KEYS
} from './providerRuntimeState';

const PROVIDER_PACKAGES: Record<WorkerProviderKey, string[]> = {
  codex: ['@openai/codex-sdk'],
  claude_code: ['@anthropic-ai/claude-agent-sdk'],
  gemini_cli: ['@google/gemini-cli']
};

const packageIsResolvable = (pkg: string): boolean => {
  try {
    require.resolve(pkg);
    return true;
  } catch (error: unknown) {
    // ESM-only packages (e.g. @openai/codex-sdk) throw ERR_PACKAGE_PATH_NOT_EXPORTED
    // because their exports map has no "require" condition.  The package IS
    // installed — it just cannot be loaded via require().  Treat this as success.
    if (error instanceof Error && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return true;
    }
    return false;
  }
};

export const resolvePreparedProviders = (): WorkerProviderKey[] => {
  return Object.entries(PROVIDER_PACKAGES)
    .filter(([, packages]) => packages.every((pkg) => packageIsResolvable(pkg)))
    .map(([provider]) => provider as WorkerProviderKey);
};

/**
 * Verify that required provider SDKs are available as direct dependencies.
 * Since provider SDKs are now installed as direct dependencies of the worker
 * package, this function simply checks resolvability without installing anything.
 */
export const prepareRuntimeProviders = async (
  _vendorDir: string,
  providers?: string[],
  priorState?: WorkerRuntimeState,
  onStateChange?: (runtimeState: WorkerRuntimeState) => void
): Promise<WorkerRuntimeState> => {
  const targets = Array.from(
    new Set((providers ?? WORKER_PROVIDER_KEYS).map((provider) => normalizeWorkerProviderKey(provider)).filter(Boolean))
  ) as WorkerProviderKey[];

  const alreadyPrepared = resolvePreparedProviders();

  let runtimeState: WorkerRuntimeState = {
    providerStatuses: priorState?.providerStatuses,
    preparedProviders: alreadyPrepared,
    preparingProviders: [],
    lastPrepareAt: new Date().toISOString(),
    lastPrepareError: undefined
  };

  for (const provider of targets) {
    const ts = new Date().toISOString();
    if (alreadyPrepared.includes(provider)) {
      runtimeState = markWorkerProviderReady(runtimeState, provider, { finishedAt: ts });
    } else {
      runtimeState = markWorkerProviderError(runtimeState, provider, {
        finishedAt: ts,
        error: `provider SDK not installed as dependency: ${PROVIDER_PACKAGES[provider]?.join(', ') ?? provider}`
      });
    }
    onStateChange?.(runtimeState);
  }

  return runtimeState;
};

export const resolveTaskProvidersFromContext = (context: {
  task?: Record<string, unknown> | null;
  robotsInRepo?: Array<Record<string, unknown>>;
}): WorkerProviderKey[] => {
  const robotId = typeof context.task?.robotId === 'string' ? context.task.robotId : '';
  const robot = Array.isArray(context.robotsInRepo)
    ? context.robotsInRepo.find((entry) => String(entry?.id ?? '') === robotId)
    : undefined;
  const provider = typeof robot?.modelProvider === 'string' ? robot.modelProvider : 'codex';
  const routingConfig =
    robot?.modelProviderConfig && typeof robot.modelProviderConfig === 'object' && !Array.isArray(robot.modelProviderConfig)
      ? (robot.modelProviderConfig as Record<string, unknown>).routingConfig
      : null;
  const fallbackProvider =
    routingConfig && typeof routingConfig === 'object' && !Array.isArray(routingConfig)
      ? String((routingConfig as Record<string, unknown>).fallbackProvider ?? '').trim()
      : '';
  const providers = [provider, fallbackProvider]
    .map((entry) => normalizeWorkerProviderKey(entry))
    .filter(Boolean) as WorkerProviderKey[];
  return providers.length > 0 ? Array.from(new Set(providers)) : ['codex'];
};
