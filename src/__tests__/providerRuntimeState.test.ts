import { buildWorkerRuntimeState, cloneWorkerRuntimeState } from '../runtime/providerRuntimeState';

describe('providerRuntimeState helpers', () => {
  test('derives available providers from ready entries', () => {
    const runtimeState = buildWorkerRuntimeState(
      {
        codex: { status: 'ready', checkedAt: '2026-04-16T00:00:00.000Z', version: '0.120.0' },
        claude_code: { status: 'idle', checkedAt: '2026-04-16T00:00:00.000Z' },
        gemini_cli: { status: 'error', checkedAt: '2026-04-16T00:00:00.000Z', error: 'gemini probe failed' }
      },
      { lastCheckedAt: '2026-04-16T00:00:00.000Z' }
    );

    expect(runtimeState.availableProviders).toEqual(['codex']);
    expect(runtimeState.lastCheckError).toContain('gemini probe failed');
  });

  test('clones provider status metadata without mutating the source', () => {
    const original = buildWorkerRuntimeState(
      {
        codex: { status: 'ready', checkedAt: '2026-04-16T00:00:00.000Z', path: '/usr/local/bin/codex' }
      },
      { lastCheckedAt: '2026-04-16T00:00:00.000Z' }
    );

    const cloned = cloneWorkerRuntimeState(original);
    expect(cloned).toEqual(original);
    expect(cloned?.providerStatuses?.codex).not.toBe(original.providerStatuses?.codex);
  });
});
