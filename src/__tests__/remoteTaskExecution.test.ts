import { __test__getProviderAttemptExecutionBlocker } from '../runtime/remoteTaskExecution';

describe('remoteTaskExecution credential blockers', () => {
  test('allows Codex attempts when a transferable API key is present', () => {
    const blocker = __test__getProviderAttemptExecutionBlocker({
      provider: 'codex',
      role: 'primary',
      runConfig: {} as any,
      credential: {
        provider: 'codex',
        requestedStoredSource: 'user',
        resolvedLayer: 'user',
        resolvedMethod: 'user_profile',
        canExecute: true,
        apiKey: 'sk-worker',
        fallbackUsed: false
      }
    } as any);

    expect(blocker).toBeNull();
  });

  test('blocks Codex local OAuth auth because remote workers cannot reuse host ~/.codex tokens', () => {
    const blocker = __test__getProviderAttemptExecutionBlocker({
      provider: 'codex',
      role: 'primary',
      runConfig: {} as any,
      credential: {
        provider: 'codex',
        requestedStoredSource: 'user',
        resolvedLayer: 'local',
        resolvedMethod: 'auth_json_tokens',
        canExecute: true,
        fallbackUsed: false
      }
    } as any);

    expect(blocker).toContain('OAuth tokens');
    expect(blocker).toContain('remote workers');
  });

  test('reuses explicit credential failure reasons for non-executable attempts', () => {
    const blocker = __test__getProviderAttemptExecutionBlocker({
      provider: 'codex',
      role: 'primary',
      runConfig: {} as any,
      credential: {
        provider: 'codex',
        requestedStoredSource: 'user',
        resolvedLayer: 'none',
        resolvedMethod: 'none',
        canExecute: false,
        fallbackUsed: false,
        reason: 'No executable credential is available for provider codex'
      }
    } as any);

    expect(blocker).toBe('No executable credential is available for provider codex');
  });
});
