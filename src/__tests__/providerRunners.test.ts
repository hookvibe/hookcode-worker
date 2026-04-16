import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { runCodexExecWithSdk } from '../runtime/providerRunners';

describe('providerRunners codex isolation', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  const makeTempDir = async () => await fs.mkdtemp(path.join(os.tmpdir(), 'hookcode-worker-provider-runners-'));

  afterEach(() => {
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;

    if (originalOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;

    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;

    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  });

  test('runCodexExecWithSdk isolates Codex CLI home and writes HookCode credentials into auth/config files', async () => {
    const repoDir = await makeTempDir();
    try {
      const promptFile = path.join(repoDir, 'prompt.txt');
      const outputFile = path.join(repoDir, 'codex-output.txt');
      await fs.writeFile(promptFile, 'hello', 'utf8');

      process.env.OPENAI_API_KEY = 'host-env-key';
      process.env.OPENAI_BASE_URL = 'https://host.invalid/v1';
      process.env.CODEX_HOME = '/tmp/host-codex-home';
      process.env.XDG_CONFIG_HOME = '/tmp/host-xdg-config';

      let capturedHomeDir = '';
      let capturedEnv: Record<string, string> | undefined;
      let capturedArgs: string[] = [];
      let capturedConfigToml = '';
      let capturedAuthJson = '';

      const result = await runCodexExecWithSdk({
        repoDir,
        promptFile,
        model: 'gpt-5.4',
        sandbox: 'read-only',
        modelReasoningEffort: 'medium',
        apiKey: 'worker-api-key',
        apiBaseUrl: 'http://proxy.example/v1',
        outputLastMessageFile: 'codex-output.txt',
        __internal: {
          runCliProcess: async ({ env, args, onStdoutLine }) => {
            capturedEnv = env;
            capturedArgs = args;
            capturedHomeDir = String(env?.HOME ?? '');
            capturedConfigToml = await fs.readFile(path.join(capturedHomeDir, '.codex', 'config.toml'), 'utf8');
            capturedAuthJson = await fs.readFile(path.join(capturedHomeDir, '.codex', 'auth.json'), 'utf8');

            onStdoutLine?.('{"type":"thread.started","thread_id":"thread-1"}');
            onStdoutLine?.('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}');
            await fs.writeFile(outputFile, 'hi', 'utf8');

            return { stdoutTail: '', stderrTail: '', exitCode: 0, signal: null };
          }
        }
      });

      expect(result).toEqual({ threadId: 'thread-1', finalResponse: 'hi' });
      expect(capturedArgs).toEqual(expect.arrayContaining(['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.4']));
      expect(capturedHomeDir).toContain('.hookcode-runtime');
      expect(path.basename(capturedHomeDir)).toContain('codex-home-');
      expect(capturedEnv?.HOME).toBe(capturedHomeDir);
      expect(capturedEnv?.USERPROFILE).toBe(capturedHomeDir);
      expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(capturedEnv?.OPENAI_BASE_URL).toBeUndefined();
      expect(capturedEnv?.CODEX_HOME).toBeUndefined();
      expect(capturedEnv?.XDG_CONFIG_HOME).toBeUndefined();
      expect(capturedConfigToml).toContain('model_provider = "custom"');
      expect(capturedConfigToml).toContain('base_url = "http://proxy.example/v1"');
      expect(capturedAuthJson).toContain('"OPENAI_API_KEY": "worker-api-key"');
      await expect(fs.stat(capturedHomeDir)).rejects.toThrow();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  test('runCodexExecWithSdk does not leak host Codex/OpenAI auth into isolated runs without HookCode credentials', async () => {
    const repoDir = await makeTempDir();
    try {
      const promptFile = path.join(repoDir, 'prompt.txt');
      const outputFile = path.join(repoDir, 'codex-output.txt');
      await fs.writeFile(promptFile, 'hello', 'utf8');

      process.env.OPENAI_API_KEY = 'host-env-key';
      process.env.OPENAI_BASE_URL = 'https://host.invalid/v1';
      process.env.CODEX_HOME = '/tmp/host-codex-home';
      process.env.XDG_CONFIG_HOME = '/tmp/host-xdg-config';

      let capturedHomeDir = '';
      let capturedEnv: Record<string, string> | undefined;
      let hasAuthJson = false;
      let hasConfigToml = false;

      const result = await runCodexExecWithSdk({
        repoDir,
        promptFile,
        model: 'gpt-5.4',
        sandbox: 'read-only',
        modelReasoningEffort: 'medium',
        outputLastMessageFile: 'codex-output.txt',
        __internal: {
          runCliProcess: async ({ env, onStdoutLine }) => {
            capturedEnv = env;
            capturedHomeDir = String(env?.HOME ?? '');
            hasAuthJson = await fs
              .stat(path.join(capturedHomeDir, '.codex', 'auth.json'))
              .then(() => true)
              .catch(() => false);
            hasConfigToml = await fs
              .stat(path.join(capturedHomeDir, '.codex', 'config.toml'))
              .then(() => true)
              .catch(() => false);

            onStdoutLine?.('{"type":"thread.started","thread_id":"thread-2"}');
            await fs.writeFile(outputFile, '', 'utf8');

            return { stdoutTail: '', stderrTail: '', exitCode: 0, signal: null };
          }
        }
      });

      expect(result).toEqual({ threadId: 'thread-2', finalResponse: '' });
      expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(capturedEnv?.OPENAI_BASE_URL).toBeUndefined();
      expect(capturedEnv?.CODEX_HOME).toBeUndefined();
      expect(capturedEnv?.XDG_CONFIG_HOME).toBeUndefined();
      expect(hasAuthJson).toBe(false);
      expect(hasConfigToml).toBe(false);
      await expect(fs.stat(capturedHomeDir)).rejects.toThrow();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});
