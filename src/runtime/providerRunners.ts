import { spawn } from 'child_process';
import { createRequire } from 'module';
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { stopChildProcessTree } from './crossPlatformSpawn';
import { buildMergedProcessEnv, createAsyncLineLogger, normalizeHttpBaseUrl } from './providerRuntime';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
const nodeRequire = createRequire(__filename);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toSafeJsonLine = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ type: 'hookcode_runtime_error', error: String(error) });
  }
};

const isPathWithinRoot = (rootDir: string, filePath: string): boolean => {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
};

const resolveGeminiCliEntrypoint = async (): Promise<string> => {
  const pkgJsonPath = nodeRequire.resolve('@google/gemini-cli/package.json');
  const pkgDir = path.dirname(pkgJsonPath);
  const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as { bin?: string | Record<string, string> };
  const binRel =
    typeof pkg.bin === 'string'
      ? pkg.bin
      : typeof pkg.bin?.gemini === 'string'
        ? pkg.bin.gemini
        : pkg.bin && typeof pkg.bin === 'object'
          ? Object.values(pkg.bin)[0]
          : '';
  if (!binRel) {
    throw new Error('gemini_cli entrypoint not found in @google/gemini-cli package.json');
  }
  return path.resolve(pkgDir, binRel);
};

const buildPolicyToml = (allowTools: string[]): string => {
  const toolsToml = allowTools.map((tool) => `"${String(tool).replace(/"/g, '\\"')}"`).join(', ');
  return [
    'version = "1.0"',
    '',
    '[[rules]]',
    'id = "hookcode-auto-allow-core-tools"',
    'description = "HookCode: auto-allow the configured core tools for non-interactive executions."',
    `tools = [${toolsToml}]`,
    'decision = "allow"',
    ''
  ].join('\n');
};

const parseJsonIfPossible = (line: string): unknown | null => {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const getCodexThreadOptions = (params: {
  repoDir: string;
  workspaceDir?: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write';
  modelReasoningEffort: string;
  includeModelReasoningEffort?: boolean;
}) => {
  const options: Record<string, unknown> = {
    model: params.model,
    sandboxMode: params.sandbox,
    workingDirectory: params.workspaceDir ?? params.repoDir,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    additionalDirectories: params.sandbox === 'workspace-write' ? [path.join(params.repoDir, '.git')] : undefined
  };
  if (params.includeModelReasoningEffort !== false) {
    options.modelReasoningEffort = params.modelReasoningEffort;
  }
  return options;
};

const UNKNOWN_REASONING_PARAM_PATTERN =
  /unknown parameter:\s*['"]reasoning['"]|["']param["']\s*:\s*["']reasoning["']/i;
const INVALID_REASONING_VALUE_PATTERN =
  /reasoning.*(invalid|unsupported|not supported|must be one of|invalid enum|expected one of)|invalid.*reasoning/i;

const isUnsupportedReasoningError = (message: string): boolean =>
  UNKNOWN_REASONING_PARAM_PATTERN.test(message) || INVALID_REASONING_VALUE_PATTERN.test(message);

const getNextReasoningEffortFallback = (value: string): string | null => {
  if (value === 'xhigh') return 'high';
  if (value === 'high') return 'medium';
  if (value === 'medium') return 'low';
  return null;
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
}): Promise<{ threadId: string | null; finalResponse: string }> => {
  const prompt = await readFile(params.promptFile, 'utf8');
  const { Codex } = (await dynamicImport('@openai/codex-sdk')) as { Codex: any };
  const codexInitOptions: Record<string, unknown> = {
    baseUrl: normalizeHttpBaseUrl(params.apiBaseUrl ?? ''),
    env: buildMergedProcessEnv(params.env)
  };
  if ((params.apiKey ?? '').trim()) codexInitOptions.apiKey = params.apiKey;
  const codex = new Codex(codexInitOptions);

  const runOnce = async (reasoningEffort: string, resumeThreadId?: string): Promise<{ threadId: string | null; finalResponse: string }> => {
    const threadOptions = getCodexThreadOptions({
      repoDir: params.repoDir,
      workspaceDir: params.workspaceDir,
      model: params.model,
      sandbox: params.sandbox,
      modelReasoningEffort: reasoningEffort
    });
    const resumeId = String(resumeThreadId ?? '').trim();
    const thread = resumeId
      ? (() => {
          try {
            return codex.resumeThread(resumeId, threadOptions);
          } catch {
            return codex.startThread(threadOptions);
          }
        })()
      : codex.startThread(threadOptions);

    const logger = createAsyncLineLogger({ logLine: params.logLine, redact: params.redact, maxQueueSize: 500 });
    const streamAbort = new AbortController();
    if (params.signal) {
      if (params.signal.aborted) streamAbort.abort(params.signal.reason);
      else params.signal.addEventListener('abort', () => streamAbort.abort(params.signal?.reason), { once: true });
    }

    const turnOptions: Record<string, unknown> = { signal: streamAbort.signal };
    if (params.outputSchema) turnOptions.outputSchema = params.outputSchema;
    const { events } = await thread.runStreamed(prompt, turnOptions);
    const iterator = events[Symbol.asyncIterator]();
    let threadId: string | null = null;
    let finalResponse = '';
    let terminalError = '';

    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value as Record<string, unknown>;

        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          threadId = event.thread_id.trim();
        }
        if (
          (event.type === 'item.updated' || event.type === 'item.completed') &&
          isRecord(event.item) &&
          event.item.type === 'agent_message' &&
          typeof event.item.text === 'string'
        ) {
          finalResponse = event.item.text;
        }
        if (event.type === 'turn.failed') {
          terminalError = String(isRecord(event.error) ? event.error.message ?? 'codex turn failed' : 'codex turn failed');
        }
        if (event.type === 'error') {
          terminalError = String(event.message ?? 'codex stream error');
        }

        logger.enqueue(JSON.stringify(event), {
          important:
            event.type === 'thread.started' ||
            event.type === 'turn.completed' ||
            event.type === 'turn.failed' ||
            event.type === 'error'
        });

        if (terminalError) {
          if (!streamAbort.signal.aborted) streamAbort.abort(new Error('codex_stream_terminal_event'));
          break;
        }
      }
    } finally {
      const returnFn = iterator.return?.bind(iterator);
      if (returnFn) {
        await Promise.race([
          Promise.resolve(returnFn(undefined as never)).then(() => undefined).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 300))
        ]);
      }
      await logger.flushBestEffort(250);
    }

    const outputPath = path.isAbsolute(params.outputLastMessageFile)
      ? params.outputLastMessageFile
      : path.join(params.repoDir, params.outputLastMessageFile);
    await writeFile(outputPath, finalResponse ?? '', 'utf8');

    if (terminalError) throw new Error(terminalError);
    return { threadId: threadId ?? thread.id ?? null, finalResponse };
  };

  let reasoningEffort = params.modelReasoningEffort || 'medium';
  while (true) {
    try {
      return await runOnce(reasoningEffort, params.resumeThreadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isUnsupportedReasoningError(message)) throw error;
      const nextReasoning = getNextReasoningEffortFallback(reasoningEffort);
      if (!nextReasoning) throw error;
      if (params.logLine) {
        await params.logLine(`[codex] remote API rejected reasoning effort ${reasoningEffort}; retrying with ${nextReasoning}.`);
      }
      reasoningEffort = nextReasoning;
    }
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
  const { query } = (await dynamicImport('@anthropic-ai/claude-agent-sdk')) as { query: Function };
  const abortController = new AbortController();
  if (params.signal) {
    if (params.signal.aborted) abortController.abort(params.signal.reason);
    else params.signal.addEventListener('abort', () => abortController.abort(params.signal?.reason), { once: true });
  }

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
  const workspaceRoot = params.workspaceDir ?? params.repoDir;
  const resolveWorkspacePath = (rawPath: string): string => (path.isAbsolute(rawPath) ? rawPath : path.join(workspaceRoot, rawPath));

  const runOnce = async (resumeSessionId?: string): Promise<{ threadId: string | null; finalResponse: string }> => {
    const logger = createAsyncLineLogger({ logLine: params.logLine, redact: params.redact, maxQueueSize: 500 });
    let threadId: string | null = null;
    let finalResponse = '';
    let resultError: string | null = null;

    const stream = query({
      prompt,
      options: {
        abortController,
        cwd: workspaceRoot,
        env: mergedEnv,
        model: params.model || undefined,
        tools: baseTools,
        allowedTools: baseTools,
        permissionMode: 'dontAsk',
        persistSession: true,
        resume: resumeSessionId ? resumeSessionId : undefined,
        forkSession: false,
        sandbox:
          params.sandbox === 'workspace-write'
            ? {
                enabled: true,
                autoAllowBashIfSandboxed: true,
                allowUnsandboxedCommands: false
              }
            : { enabled: true },
        additionalDirectories: params.sandbox === 'workspace-write' ? [path.join(params.repoDir, '.git')] : undefined,
        canUseTool: async (toolName: string, input: unknown) => {
          if (!baseTools.includes(toolName)) {
            return { behavior: 'deny', message: 'Tool is not allowed by this robot configuration.' };
          }

          if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') && isRecord(input) && typeof input.file_path === 'string') {
            if (!isPathWithinRoot(workspaceRoot, resolveWorkspacePath(input.file_path))) {
              return { behavior: 'deny', message: 'File access outside the task-group workspace is not allowed.' };
            }
          }

          if ((toolName === 'Grep' || toolName === 'Glob') && isRecord(input) && typeof input.path === 'string') {
            const resolvedPath = input.path ? resolveWorkspacePath(input.path) : '';
            if (resolvedPath && !isPathWithinRoot(workspaceRoot, resolvedPath)) {
              return { behavior: 'deny', message: 'Search path outside the task-group workspace is not allowed.' };
            }
          }

          if (toolName === 'Bash' && isRecord(input) && input.dangerouslyDisableSandbox === true) {
            return { behavior: 'deny', message: 'Dangerously disabling sandbox is not allowed.', interrupt: true };
          }

          return { behavior: 'allow' };
        }
      }
    }) as AsyncIterable<unknown>;

    try {
      for await (const message of stream) {
        const payload = isRecord(message) ? message : {};
        const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
        if (sessionId && !threadId) threadId = sessionId;

        if (payload.type === 'result') {
          if (payload.subtype === 'success') {
            finalResponse = typeof payload.result === 'string' ? payload.result : '';
          } else {
            const errors = Array.isArray(payload.errors) ? payload.errors : [];
            resultError = errors.length > 0 ? String(errors[0]) : 'claude code execution failed';
          }
        }

        logger.enqueue(toSafeJsonLine(message), {
          important:
            payload.type === 'result' ||
            (payload.type === 'system' && payload.subtype === 'init') ||
            payload.type === 'auth_status'
        });
        if (resultError) break;
      }
    } finally {
      await logger.flushBestEffort(250);
    }

    const outputPath = path.isAbsolute(params.outputLastMessageFile)
      ? params.outputLastMessageFile
      : path.join(params.repoDir, params.outputLastMessageFile);
    await writeFile(outputPath, finalResponse ?? '', 'utf8');

    if (resultError) throw new Error(resultError);
    return { threadId, finalResponse };
  };

  const resumeId = String(params.resumeSessionId ?? '').trim();
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
  const resolvedEntrypoint = await resolveGeminiCliEntrypoint();
  const workspaceDir = params.workspaceDir ?? params.repoDir;
  const coreTools = ['list_directory', 'read_file', 'glob', 'search_file_content'];
  if (params.sandbox === 'workspace-write') coreTools.push('write_file', 'replace', 'run_shell_command');
  if (params.networkAccess) coreTools.push('web_fetch', 'google_web_search');

  await mkdir(params.geminiHomeDir, { recursive: true });
  const localGeminiDir = path.join(os.homedir(), '.gemini');
  const isolatedGeminiDir = path.join(params.geminiHomeDir, '.gemini');
  await mkdir(isolatedGeminiDir, { recursive: true });
  for (const fileName of ['oauth_creds.json', 'google_accounts.json']) {
    try {
      await copyFile(path.join(localGeminiDir, fileName), path.join(isolatedGeminiDir, fileName));
    } catch {}
  }

  const systemSettingsPath = path.join(params.geminiHomeDir, 'hookcode-gemini-system-settings.json');
  await writeFile(
    systemSettingsPath,
    JSON.stringify(
      {
        tools: { core: coreTools, exclude: [] },
        hooks: { enabled: false }
      },
      null,
      2
    ),
    'utf8'
  );

  const policyDir = path.join(isolatedGeminiDir, 'policies');
  await mkdir(policyDir, { recursive: true });
  await writeFile(path.join(policyDir, 'hookcode.toml'), buildPolicyToml(coreTools), 'utf8');

  const apiBaseUrl = normalizeHttpBaseUrl(params.apiBaseUrl);
  const runtimeEnvOverrides: Record<string, string | undefined> = {
    ...params.env,
    ...(apiBaseUrl ? { GOOGLE_GEMINI_BASE_URL: apiBaseUrl } : {}),
    HOME: params.geminiHomeDir,
    USERPROFILE: params.geminiHomeDir,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath
  };
  if ((params.apiKey ?? '').trim()) runtimeEnvOverrides.GEMINI_API_KEY = params.apiKey;
  const mergedEnv = buildMergedProcessEnv(runtimeEnvOverrides);

  const runOnce = async (resumeSessionId?: string): Promise<{ threadId: string | null; finalResponse: string }> => {
    const child = spawn(process.execPath, [
      resolvedEntrypoint,
      '--output-format',
      'stream-json',
      ...(params.model ? ['--model', params.model] : []),
      ...(resumeSessionId ? ['--resume', resumeSessionId] : [])
    ], {
      cwd: workspaceDir,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const logger = createAsyncLineLogger({ logLine: params.logLine, redact: params.redact, maxQueueSize: 800 });
    let threadId: string | null = null;
    let finalResponse = '';
    let stderrTail = '';
    let stdoutTail = '';

    const captureTail = (current: string, next: string, maxLen: number) => {
      const merged = `${current}\n${next}`.trim();
      return merged.length <= maxLen ? merged : merged.slice(merged.length - maxLen);
    };

    const stdoutRl = readline.createInterface({ input: child.stdout });
    const stderrRl = readline.createInterface({ input: child.stderr });

    stdoutRl.on('line', (line) => {
      const raw = String(line ?? '');
      stdoutTail = captureTail(stdoutTail, raw, 2000);
      logger.enqueue(raw, { important: raw.includes('"type":"init"') || raw.includes('"type":"result"') });
      const parsed = parseJsonIfPossible(raw);
      if (!isRecord(parsed)) return;
      if (parsed.type === 'init' && typeof parsed.session_id === 'string' && !threadId) {
        threadId = parsed.session_id.trim();
      }
      if (parsed.type === 'result' && isRecord(parsed.result)) {
        const output = typeof parsed.result.output === 'string' ? parsed.result.output : typeof parsed.result.text === 'string' ? parsed.result.text : '';
        if (output.trim()) finalResponse = output.trimEnd();
      }
    });

    stderrRl.on('line', (line) => {
      const raw = String(line ?? '');
      stderrTail = captureTail(stderrTail, raw, 2000);
      logger.enqueue(raw, { important: true });
    });

    const abort = () => {
      if (!child.killed) {
        stopChildProcessTree(child, 'SIGTERM');
      }
      setTimeout(() => {
        if (!child.killed) stopChildProcessTree(child, 'SIGKILL');
      }, 1500).unref();
    };

    if (params.signal) {
      if (params.signal.aborted) abort();
      else params.signal.addEventListener('abort', abort, { once: true });
    }

    try {
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('error', (error) => reject(error));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });

      stdoutRl.close();
      stderrRl.close();

      const outputPath = path.isAbsolute(params.outputLastMessageFile)
        ? params.outputLastMessageFile
        : path.join(params.repoDir, params.outputLastMessageFile);
      await writeFile(outputPath, finalResponse ?? '', 'utf8');

      if (exit.signal) throw new Error(`gemini_cli terminated by signal ${exit.signal}`);
      if (exit.code !== 0) {
        const detail = [stderrTail, stdoutTail].filter(Boolean).join('\n');
        throw new Error(`gemini_cli exited with code ${exit.code}${detail ? `\n${detail}` : ''}`);
      }

      return { threadId, finalResponse };
    } finally {
      await logger.flushBestEffort(250);
    }
  };

  const resumeId = String(params.resumeSessionId ?? '').trim();
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
