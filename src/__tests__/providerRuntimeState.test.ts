import {
  markWorkerProviderError,
  markWorkerProviderReady,
  markWorkerProvidersPreparing
} from '../runtime/providerRuntimeState';

describe('providerRuntimeState helpers', () => {
  test('tracks preparing and ready providers independently', () => {
    // Keep worker-side provider status transitions stable so the backend can render live Codex/Claude/Gemini progress per provider. docs/en/developer/plans/7i9tp61el8rrb4r7j5xj/task_plan.md 7i9tp61el8rrb4r7j5xj
    const started = markWorkerProvidersPreparing(undefined, ['codex', 'gemini_cli'], '2026-04-15T00:00:00.000Z');
    expect(started.preparingProviders).toEqual(['codex', 'gemini_cli']);
    expect(started.providerStatuses?.codex?.status).toBe('preparing');
    expect(started.providerStatuses?.gemini_cli?.status).toBe('preparing');

    const completed = markWorkerProviderReady(started, 'codex', {
      startedAt: '2026-04-15T00:00:00.000Z',
      finishedAt: '2026-04-15T00:00:05.000Z'
    });
    expect(completed.preparedProviders).toEqual(['codex']);
    expect(completed.preparingProviders).toEqual(['gemini_cli']);
    expect(completed.providerStatuses?.codex?.status).toBe('ready');
  });

  test('preserves successful providers when another provider fails', () => {
    const preparing = markWorkerProvidersPreparing(undefined, ['codex', 'claude_code'], '2026-04-15T00:00:00.000Z');
    const codexReady = markWorkerProviderReady(preparing, 'codex', {
      startedAt: '2026-04-15T00:00:00.000Z',
      finishedAt: '2026-04-15T00:00:03.000Z'
    });
    const withError = markWorkerProviderError(codexReady, 'claude_code', {
      startedAt: '2026-04-15T00:00:01.000Z',
      finishedAt: '2026-04-15T00:00:04.000Z',
      error: 'npm exited with code 1'
    });

    expect(withError.preparedProviders).toEqual(['codex']);
    expect(withError.preparingProviders).toEqual([]);
    expect(withError.providerStatuses?.claude_code?.status).toBe('error');
    expect(withError.lastPrepareError).toContain('npm exited with code 1');
  });
});
