import { spawn } from 'child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { stopChildProcessTree } from './crossPlatformSpawn';
import { buildMergedProcessEnv, createAsyncLineLogger, normalizeHttpBaseUrl } from './providerRuntime';

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toSafeJsonLine = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ type: 'hookcode_runtime_error', error: String(error) });
  }
};

const parseJsonIfPossible = (line: string): Record<string, unknown> | null => {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const captureTail = (current: string, next: string, maxLen = 2_000): string => {
  const merged = `${current}\n${String(next ?? '')}`.trim();
  return merged.length <= maxLen ? merged : merged.slice(merged.length - maxLen);
};

const resolveOutputPath = (repoDir: string, outputLastMessageFile: string): string =>
  path.isAbsolute(outputLastMessageFile) ? outputLastMessageFile : path.join(repoDir, outputLastMessageFile);

const runCliProcess = async (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdinText?: string;
  signal?: AbortSignal;
  redact?: (text: string) => string;
  logLine?: (line: string) => Promise<void>;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}): Promise<{ stdoutTail: string; stderrTail: string; exitCode: number | null; signal: NodeJS.Signals | null }> => {
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const logger = createAsyncLineLogger({ logLine: params.logLine, redact: params.redact, maxQueueSize: 800 });
  let stdoutTail = '';
  let stderrTail = '';

  const stdoutRl = readline.createInterface({ input: child.stdout });
  const stderrRl = readline.createInterface({ input: child.stderr });

  stdoutRl.on('line', (line) => {
    stdoutTail = captureTail(stdoutTail, line);
    logger.enqueue(line, { important: true });
    params.onStdoutLine?.(line);
  });

  stderrRl.on('line', (line) => {
    stderrTail = captureTail(stderrTail, line);
    logger.enqueue(line, { important: true });
    params.onStderrLine?.(line);
  });

  const abort = () => {
    if (child.killed) return;
    stopChildProcessTree(child, 'SIGTERM');
    setTimeout(() => {
      if (!child.killed) stopChildProcessTree(child, 'SIGKILL');
    }, 1_500).unref();
  };

  if (params.signal) {
    if (params.signal.aborted) abort();
    else params.signal.addEventListener('abort', abort, { once: true });
  }

  try {
    if (child.stdin) {
      if (typeof params.stdinText === 'string') {
        child.stdin.write(params.stdinText);
      }
      child.stdin.end();
    }

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', (error) => reject(error));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    stdoutRl.close();
    stderrRl.close();
    await logger.flushBestEffort(250);

    return {
      stdoutTail,
      stderrTail,
      exitCode: exit.code,
      signal: exit.signal
    };
  } finally {
    if (params.signal) {
      params.signal.removeEventListener('abort', abort);
    }
  }
};

const buildCodexArgs = (params: {
  repoDir: string;
  workspaceDir: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write';
  resumeThreadId?: string;
  outputLastMessageFile: string;
  outputSchemaFile?: string;
}) => {
  const outputPath = resolveOutputPath(params.repoDir, params.outputLastMessageFile);
  const args = params.resumeThreadId ? ['exec', 'resume', params.resumeThreadId] : ['exec'];
  args.push('--json', '--skip-git-repo-check', '-C', params.workspaceDir, '-o', outputPath, '-s', params.sandbox);
  if (params.model) args.push('-m', params.model);
  if (params.sandbox === 'workspace-write') {
    args.push('--add-dir', path.join(params.repoDir, '.git'));
  }
  if (params.outputSchemaFile) {
    args.push('--output-schema', params.outputSchemaFile);
  }
  return args;
};

const CODEX_ENV_KEYS_TO_STRIP = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const;

const buildCodexConfigToml = (apiBaseUrl?: string): string | null => {
  if (!apiBaseUrl) return null;
  return [
    'model_provider = "custom"',
    'disable_response_storage = true',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    `base_url = ${JSON.stringify(apiBaseUrl)}`
  ].join('\n');
};

const prepareIsolatedCodexHome = async (params: { apiKey?: string; apiBaseUrl?: string; parentDir: string }) => {
  const apiKey = trimString(params.apiKey);
  const apiBaseUrl = normalizeHttpBaseUrl(params.apiBaseUrl);
  const runtimeRootDir = path.join(params.parentDir, '.hookcode-runtime');
  await mkdir(runtimeRootDir, { recursive: true });
  const homeDir = await mkdtemp(path.join(runtimeRootDir, 'codex-home-'));
  const codexDir = path.join(homeDir, '.codex');
  await mkdir(codexDir, { recursive: true });

  if (apiKey) {
    await writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2), 'utf8');
  }

  const configToml = buildCodexConfigToml(apiBaseUrl);
  if (configToml) {
    await writeFile(path.join(codexDir, 'config.toml'), `${configToml}\n`, 'utf8');
  }

  return {
    homeDir,
    apiBaseUrl,
    hasApiKey: Boolean(apiKey)
  };
};

export const runCodexExecWithSdk = async (params: {
  repoDir: string;
  workspaceDir?: string;
  promptFile: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write';
  modelReasoningEffort: string;
  resumeThreadId?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  outputSchema?: unknown;
  outputLastMessageFile: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  redact?: (text: string) => string;
  logLine?: (line: string) => Promise<void>;
  __internal?: {
    runCliProcess?: typeof runCliProcess;
    prepareIsolatedCodexHome?: typeof prepareIsolatedCodexHome;
  };
}): Promise<{ threadId: string | null; finalResponse: string }> => {
  const prompt = await readFile(params.promptFile, 'utf8');
  const workspaceDir = params.workspaceDir ?? params.repoDir;
  const outputPath = resolveOutputPath(params.repoDir, params.outputLastMessageFile);
  const schemaPath = params.outputSchema ? path.join(workspaceDir, '.hookcode-codex-output-schema.json') : undefined;
  if (schemaPath) {
    await writeFile(schemaPath, JSON.stringify(params.outputSchema, null, 2), 'utf8');
  }

  const runCli = params.__internal?.runCliProcess ?? runCliProcess;
  const isolatedCodexHome = await (params.__internal?.prepareIsolatedCodexHome ?? prepareIsolatedCodexHome)({
    apiKey: params.apiKey,
    apiBaseUrl: params.apiBaseUrl,
    parentDir: workspaceDir
  });
  const runtimeEnvOverrides: Record<string, string | undefined> = {
    ...params.env,
    HOME: isolatedCodexHome.homeDir,
    USERPROFILE: isolatedCodexHome.homeDir
  };
  const mergedEnv = buildMergedProcessEnv(runtimeEnvOverrides);
  for (const key of CODEX_ENV_KEYS_TO_STRIP) {
    if (mergedEnv) delete mergedEnv[key];
  }
  if (params.logLine) {
    await params.logLine(
      `[codex] using isolated CLI home (apiBaseUrl=${isolatedCodexHome.apiBaseUrl ?? 'default'}, auth=${isolatedCodexHome.hasApiKey ? 'api_key' : 'none'}).`
    );
  }

  const runOnce = async (resumeThreadId?: string): Promise<{ threadId: string | null; finalResponse: string }> => {
    let threadId: string | null = null;
    let finalResponse = '';
    let terminalError = '';

    const { stdoutTail, stderrTail, exitCode, signal } = await runCli({
      command: 'codex',
      args: buildCodexArgs({
        repoDir: params.repoDir,
        workspaceDir,
        model: params.model,
        sandbox: params.sandbox,
        resumeThreadId,
        outputLastMessageFile: params.outputLastMessageFile,
        outputSchemaFile: schemaPath
      }),
      cwd: workspaceDir,
      env: mergedEnv,
      stdinText: prompt,
      signal: params.signal,
      redact: params.redact,
      logLine: params.logLine,
      onStdoutLine: (line) => {
        const parsed = parseJsonIfPossible(line);
        if (!parsed) return;
        if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
          threadId = parsed.thread_id.trim();
        }
        if (
          (parsed.type === 'item.updated' || parsed.type === 'item.completed') &&
          isRecord(parsed.item) &&
          parsed.item.type === 'agent_message' &&
          typeof parsed.item.text === 'string'
        ) {
          finalResponse = parsed.item.text;
        }
        if (parsed.type === 'turn.failed') {
          terminalError = String(isRecord(parsed.error) ? parsed.error.message ?? 'codex turn failed' : 'codex turn failed');
        }
        if (parsed.type === 'error') {
          terminalError = String(parsed.message ?? 'codex stream error');
        }
      }
    });

    try {
      finalResponse = await readFile(outputPath, 'utf8');
    } catch {}

    if (signal) throw new Error(`codex terminated by signal ${signal}`);
    if (exitCode !== 0) {
      const detail = [terminalError, stderrTail, stdoutTail].filter(Boolean).join('\n');
      throw new Error(`codex exited with code ${exitCode}${detail ? `\n${detail}` : ''}`);
    }
    if (terminalError) throw new Error(terminalError);
    return { threadId: threadId ?? resumeThreadId ?? null, finalResponse };
  };

  try {
    return await runOnce(trimString(params.resumeThreadId) || undefined);
  } catch (error) {
    if (!trimString(params.resumeThreadId)) throw error;
    if (params.logLine) {
      await params.logLine('[codex] resume failed; starting a new session');
    }
    return await runOnce(undefined);
  } finally {
    if (schemaPath) {
      await rm(schemaPath, { force: true }).catch(() => undefined);
    }
    await rm(isolatedCodexHome.homeDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const runClaudeCodeExecWithSdk = async (params: {
  repoDir: string;
  workspaceDir?: string;
  promptFile: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write';
  networkAccess: boolean;
  resumeSessionId?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  outputLastMessageFile: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  redact?: (text: string) => string;
  logLine?: (line: string) => Promise<void>;
}): Promise<{ threadId: string | null; finalResponse: string }> => {
  const prompt = await readFile(params.promptFile, 'utf8');
  const workspaceDir = params.workspaceDir ?? params.repoDir;
  const outputPath = resolveOutputPath(params.repoDir, params.outputLastMessageFile);
  const baseTools = ['Read', 'Grep', 'Glob'];
  if (params.sandbox === 'workspace-write') baseTools.push('Edit', 'Write', 'Bash');
  if (params.networkAccess) baseTools.push('WebFetch', 'WebSearch');

  const apiBaseUrl = normalizeHttpBaseUrl(params.apiBaseUrl);
  const runtimeEnvOverrides: Record<string, string | undefined> = {
    ...params.env,
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl, ANTHROPIC_API_URL: apiBaseUrl } : {})
  };
  if ((params.apiKey ?? '').trim()) runtimeEnvOverrides.ANTHROPIC_API_KEY = params.apiKey;
  const mergedEnv = buildMergedProcessEnv(runtimeEnvOverrides);

  const runOnce = async (resumeSessionId?: string): Promise<{ threadId: string | null; finalResponse: string }> => {
    let threadId: string | null = null;
    let finalResponse = '';
    let resultError: string | null = null;
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      baseTools.join(','),
      ...(params.model ? ['--model', params.model] : []),
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ...(params.sandbox === 'workspace-write' ? ['--add-dir', path.join(params.repoDir, '.git')] : [])
    ];

    const { stdoutTail, stderrTail, exitCode, signal } = await runCliProcess({
      command: 'claude',
      args,
      cwd: workspaceDir,
      env: mergedEnv,
      stdinText: prompt,
      signal: params.signal,
      redact: params.redact,
      logLine: params.logLine,
      onStdoutLine: (line) => {
        const parsed = parseJsonIfPossible(line);
        if (!parsed) return;
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
        if (sessionId && !threadId) threadId = sessionId;
        if (parsed.type === 'result') {
          if (parsed.subtype === 'success') {
            finalResponse = typeof parsed.result === 'string' ? parsed.result : '';
          } else {
            const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
            resultError = errors.length > 0 ? String(errors[0]) : 'claude code execution failed';
          }
        }
      }
    });

    await writeFile(outputPath, finalResponse ?? '', 'utf8');

    if (signal) throw new Error(`claude terminated by signal ${signal}`);
    if (exitCode !== 0) {
      const detail = [resultError, stderrTail, stdoutTail].filter(Boolean).join('\n');
      throw new Error(`claude exited with code ${exitCode}${detail ? `\n${detail}` : ''}`);
    }
    if (resultError) throw new Error(resultError);
    return { threadId: threadId ?? resumeSessionId ?? null, finalResponse };
  };

  const resumeId = trimString(params.resumeSessionId);
  if (resumeId) {
    try {
      return await runOnce(resumeId);
    } catch {
      if (params.logLine) {
        await params.logLine('[claude_code] resume failed; starting a new session');
      }
    }
  }
  return await runOnce(undefined);
};

export const runGeminiCliExecWithCli = async (params: {
  repoDir: string;
  workspaceDir?: string;
  promptFile: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write';
  networkAccess: boolean;
  resumeSessionId?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  outputLastMessageFile: string;
  geminiHomeDir: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  redact?: (text: string) => string;
  logLine?: (line: string) => Promise<void>;
}): Promise<{ threadId: string | null; finalResponse: string }> => {
  const prompt = await readFile(params.promptFile, 'utf8');
  const workspaceDir = params.workspaceDir ?? params.repoDir;
  const outputPath = resolveOutputPath(params.repoDir, params.outputLastMessageFile);

  await mkdir(params.geminiHomeDir, { recursive: true });
  const localGeminiDir = path.join(os.homedir(), '.gemini');
  const isolatedGeminiDir = path.join(params.geminiHomeDir, '.gemini');
  await mkdir(isolatedGeminiDir, { recursive: true });
  for (const fileName of ['oauth_creds.json', 'google_accounts.json']) {
    try {
      await copyFile(path.join(localGeminiDir, fileName), path.join(isolatedGeminiDir, fileName));
    } catch {}
  }

  const allowedTools = ['list_directory', 'read_file', 'glob', 'search_file_content'];
  if (params.sandbox === 'workspace-write') allowedTools.push('write_file', 'replace', 'run_shell_command');
  if (params.networkAccess) allowedTools.push('web_fetch', 'google_web_search');

  const apiBaseUrl = normalizeHttpBaseUrl(params.apiBaseUrl);
  const runtimeEnvOverrides: Record<string, string | undefined> = {
    ...params.env,
    ...(apiBaseUrl ? { GOOGLE_GEMINI_BASE_URL: apiBaseUrl } : {}),
    HOME: params.geminiHomeDir,
    USERPROFILE: params.geminiHomeDir
  };
  if ((params.apiKey ?? '').trim()) runtimeEnvOverrides.GEMINI_API_KEY = params.apiKey;
  const mergedEnv = buildMergedProcessEnv(runtimeEnvOverrides);

  const runOnce = async (resumeSessionId?: string): Promise<{ threadId: string | null; finalResponse: string }> => {
    let threadId: string | null = null;
    let finalResponse = '';
    let streamError = '';
    const args = [
      '--prompt',
      prompt,
      '--output-format',
      'stream-json',
      '--approval-mode',
      params.sandbox === 'workspace-write' || params.networkAccess ? 'yolo' : 'default',
      '--allowed-tools',
      allowedTools.join(','),
      ...(params.model ? ['--model', params.model] : []),
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ...(params.sandbox === 'workspace-write' ? ['--include-directories', path.join(params.repoDir, '.git')] : [])
    ];

    const { stdoutTail, stderrTail, exitCode, signal } = await runCliProcess({
      command: 'gemini',
      args,
      cwd: workspaceDir,
      env: mergedEnv,
      signal: params.signal,
      redact: params.redact,
      logLine: params.logLine,
      onStdoutLine: (line) => {
        const parsed = parseJsonIfPossible(line);
        if (!parsed) return;
        if (parsed.type === 'init' && typeof parsed.session_id === 'string' && !threadId) {
          threadId = parsed.session_id.trim();
        }
        if (parsed.type === 'result' && isRecord(parsed.result)) {
          const output =
            typeof parsed.result.output === 'string'
              ? parsed.result.output
              : typeof parsed.result.text === 'string'
                ? parsed.result.text
                : '';
          if (output.trim()) finalResponse = output.trimEnd();
        }
        if (parsed.type === 'error') {
          streamError = String(parsed.message ?? parsed.error ?? 'gemini stream error');
        }
      }
    });

    await writeFile(outputPath, finalResponse ?? '', 'utf8');

    if (signal) throw new Error(`gemini terminated by signal ${signal}`);
    if (exitCode !== 0) {
      const detail = [streamError, stderrTail, stdoutTail].filter(Boolean).join('\n');
      throw new Error(`gemini exited with code ${exitCode}${detail ? `\n${detail}` : ''}`);
    }
    if (streamError) throw new Error(streamError);
    return { threadId: threadId ?? resumeSessionId ?? null, finalResponse };
  };

  const resumeId = trimString(params.resumeSessionId);
  if (resumeId) {
    try {
      return await runOnce(resumeId);
    } catch {
      if (params.logLine) {
        await params.logLine('[gemini_cli] resume failed; starting a new session');
      }
    }
  }
  return await runOnce(undefined);
};

export const __test__toSafeJsonLine = toSafeJsonLine;
