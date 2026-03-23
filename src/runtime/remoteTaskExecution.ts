import { spawn } from 'child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { BackendInternalApiClient, type RemoteExecutionBundle } from '../backend/internalApiClient';
import type { WorkerConfig } from '../config';
import { stopChildProcessTree, xSpawnSync } from './crossPlatformSpawn';
import { WorkerTaskExecutionError } from './executionError';
import { prepareRuntimeProviders, resolvePreparedProviders } from './prepareRuntime';
import { runClaudeCodeExecWithSdk, runCodexExecWithSdk, runGeminiCliExecWithCli } from './providerRunners';
import { RepoChangeTracker } from './repoChangeTracker';
import {
  addTaskTokenUsage,
  extractClaudeCodeExecTokenUsageDeltaFromLine,
  extractCodexExecTokenUsageDeltaFromLine,
  extractGeminiCliExecTokenUsageDeltaFromLine,
  type TaskTokenUsage
} from './taskTokenUsage';

type DependencyFailureMode = 'soft' | 'hard';
type HookcodeConfig = {
  version: 1;
  dependency?: {
    failureMode: DependencyFailureMode;
    runtimes: Array<{
      language: 'node' | 'python' | 'java' | 'ruby' | 'go';
      version?: string;
      install?: string;
      workdir?: string;
    }>;
  };
};

type GitStatusSnapshot = {
  branch: string;
  headSha: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  pushRemote?: string;
  pushWebUrl?: string;
};

type GitWorkingTree = {
  staged: string[];
  unstaged: string[];
  untracked: string[];
};

type GitStatusDelta = {
  branchChanged: boolean;
  headChanged: boolean;
};

type GitStatusPush = {
  status: 'pushed' | 'unpushed' | 'unknown' | 'error' | 'not_applicable';
  reason?: string;
  targetBranch?: string;
  targetWebUrl?: string;
  targetHeadSha?: string;
};

type GitStatus = {
  enabled: boolean;
  capturedAt?: string;
  baseline?: GitStatusSnapshot;
  final?: GitStatusSnapshot;
  delta?: GitStatusDelta;
  workingTree?: GitWorkingTree;
  push?: GitStatusPush;
  errors?: string[];
};

export interface RemoteTaskExecutionSuccess {
  outputText?: string;
  gitStatus?: Record<string, unknown>;
  providerCommentUrl?: string;
}

const BLOCKED_CHARS = /[;&|`$(){}]/;
const GIT_TRANSIENT_NETWORK_ERROR_PATTERN =
  /(openssl ssl_read|unexpected eof while reading|recv failure|rpc failed; curl|http\/2 stream|gnutls_handshake|failed to connect|connection timed out|operation timed out|connection reset|connection was reset|could not resolve host|tlsv1 alert)/i;

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const shDoubleQuote = (value: string): string => {
  const input = String(value);
  if (process.platform === 'win32') {
    return `"${input.replace(/"/g, '""')}"`;
  }
  return `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')}"`;
};

const buildGitProxyFlags = (): string => {
  const proxy = trimString(process.env.GIT_HTTP_PROXY);
  return proxy ? `-c http.proxy=${shDoubleQuote(proxy)} -c https.proxy=${shDoubleQuote(proxy)}` : '';
};

const redactUrlAuthInText = (text: string): string =>
  text.replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1$2:***@');

const redactTokensInText = (text: string): string =>
  text
    .replace(/\bglpat-[A-Za-z0-9_-]{12,}\b/g, 'glpat-***')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, 'AIza***')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***');

const redactSensitiveText = (text: string): string => redactTokensInText(redactUrlAuthInText(text));

const resolveAbortMessage = (stopReason?: 'manual_stop' | 'deleted'): string =>
  stopReason === 'deleted' ? 'Task was deleted while the worker was executing it.' : 'Task execution stopped by worker cancellation.';

const writeBufferedOutput = (
  writeLine: ((line: string) => void) | undefined,
  chunk: Buffer | string,
  buffer: { value: string }
) => {
  const text = `${buffer.value}${String(chunk)}`.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split(/\n/);
  buffer.value = lines.pop() ?? '';
  if (!writeLine) return;
  for (const line of lines) {
    if (line) writeLine(line);
  }
};

const flushBufferedOutput = (writeLine: ((line: string) => void) | undefined, buffer: { value: string }) => {
  const safeLine = buffer.value.replace(/\r/g, '\n').trimEnd();
  buffer.value = '';
  if (writeLine && safeLine) writeLine(safeLine);
};

const ensureProviderRuntimesPrepared = async (params: {
  config: WorkerConfig;
  bundle: RemoteExecutionBundle;
  writeLine: (line: string) => void;
  prepareRuntime?: (providers: string[]) => Promise<void>;
}) => {
  const providers = Array.from(new Set(params.bundle.attempts.map((attempt) => trimString(attempt.provider)).filter(Boolean)));
  if (!providers.length) return;

  params.writeLine(`[worker] ensuring provider runtimes: ${providers.join(', ')}`);

  // Use the WorkerProcess-level prepareRuntime callback when available.
  // This routes through the process-wide mutex and keeps runtimeState in sync
  // with heartbeat reporting.  Falls back to the module-level serialised
  // prepareRuntimeProviders() for direct invocations outside WorkerProcess.
  if (params.prepareRuntime) {
    await params.prepareRuntime(providers);
  } else {
    await prepareRuntimeProviders(params.config.runtimeInstallDir, providers);
  }

  // Lightweight verification — resolvePreparedProviders() just calls
  // require.resolve() without triggering another install pass.
  const preparedProviders = resolvePreparedProviders();
  const missingProviders = providers.filter((provider) => !preparedProviders.includes(provider));
  if (missingProviders.length > 0) {
    throw new Error(`worker runtime prepare failed for providers: ${missingProviders.join(', ')}`);
  }
};

const streamCommand = async (params: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  killTimeoutMs: number;
  writeLine?: (line: string) => void;
}): Promise<{ stdout: string; stderr: string; outputText?: string }> => {
  const stdoutBuffer = { value: '' };
  const stderrBuffer = { value: '' };
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const tail: string[] = [];

  const rememberLine = (line: string) => {
    tail.push(line);
    if (tail.length > 80) tail.shift();
    params.writeLine?.(line);
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.command, {
      cwd: params.cwd,
      env: params.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let killedByAbort = false;
    let killTimer: NodeJS.Timeout | null = null;
    const stopChild = () => {
      if (killedByAbort) return;
      killedByAbort = true;
      stopChildProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        stopChildProcessTree(child, 'SIGKILL');
      }, params.killTimeoutMs);
    };

    if (params.signal.aborted) stopChild();
    else params.signal.addEventListener('abort', stopChild, { once: true });

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdoutChunks.push(text);
      writeBufferedOutput(rememberLine, chunk, stdoutBuffer);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderrChunks.push(text);
      writeBufferedOutput(rememberLine, chunk, stderrBuffer);
    });
    child.once('error', (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      flushBufferedOutput(rememberLine, stdoutBuffer);
      flushBufferedOutput(rememberLine, stderrBuffer);
      if (killedByAbort) {
        reject(new Error(`Task execution aborted (${signal ?? 'signal'})`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Command exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}${tail.length ? `\n${tail.join('\n')}` : ''}`
          )
        );
        return;
      }
      resolve();
    });
  });

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    outputText: tail.join('\n') || undefined
  };
};

const captureCommand = async (params: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  await new Promise((resolve) => {
    const child = spawn(params.command, {
      cwd: params.cwd,
      env: params.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', () => resolve({ exitCode: 1, stdout, stderr }));
    child.once('close', (code) => resolve({ exitCode: typeof code === 'number' ? code : 1, stdout, stderr }));
  });

const parseHookcodeConfig = async (repoDir: string): Promise<HookcodeConfig | null> => {
  const configPath = path.join(repoDir, '.hookcode.yml');
  let rawText = '';
  try {
    rawText = await readFile(configPath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = parseYaml(rawText) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid .hookcode.yml: root must be an object');
  }
  if (parsed.version !== 1) {
    throw new Error('Invalid .hookcode.yml: version must be 1');
  }

  const dependencyRaw =
    parsed.dependency && typeof parsed.dependency === 'object' && !Array.isArray(parsed.dependency)
      ? (parsed.dependency as Record<string, unknown>)
      : undefined;
  if (!dependencyRaw) {
    return { version: 1 };
  }

  const runtimesRaw = Array.isArray(dependencyRaw.runtimes) ? dependencyRaw.runtimes : [];
  const runtimes = runtimesRaw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid .hookcode.yml: dependency.runtimes entries must be objects');
    }
    const runtime = entry as Record<string, unknown>;
    const language = trimString(runtime.language) as 'node' | 'python' | 'java' | 'ruby' | 'go';
    if (!['node', 'python', 'java', 'ruby', 'go'].includes(language)) {
      throw new Error(`Invalid .hookcode.yml: unsupported runtime language "${language || '<empty>'}"`);
    }
    return {
      language,
      version: trimString(runtime.version) || undefined,
      install: trimString(runtime.install) || undefined,
      workdir: trimString(runtime.workdir) || undefined
    };
  });

  const failureMode = trimString(dependencyRaw.failureMode) === 'hard' ? 'hard' : 'soft';
  return {
    version: 1,
    dependency: {
      failureMode,
      runtimes
    }
  };
};

const ALLOWED_PATTERNS: Record<'node' | 'python' | 'java' | 'ruby' | 'go', RegExp[]> = {
  node: [/^npm ci(\s+--[\w-]+)*$/, /^npm install(\s+--[\w-]+)*$/, /^yarn install(\s+--[\w-]+)*$/, /^pnpm install(\s+--[\w-]+)*$/],
  python: [/^pip install -r requirements\.txt(\s+--[\w-]+)*$/, /^pip install -e \.(\s+--[\w-]+)*$/, /^poetry install(\s+--[\w-]+)*$/],
  java: [/^mvn dependency:resolve(\s+-[\w]+)*$/, /^gradle dependencies(\s+--[\w-]+)*$/],
  ruby: [/^bundle install(\s+--[\w-]+)*$/, /^gem install bundler$/],
  go: [/^go mod download(\s+--[\w-]+)*$/, /^go mod tidy(\s+--[\w-]+)*$/]
};

const validateInstallCommand = (
  language: 'node' | 'python' | 'java' | 'ruby' | 'go',
  command: string,
  allowCustomInstall?: boolean
): { valid: boolean; reason?: string } => {
  const trimmed = trimString(command);
  if (!trimmed) return { valid: false, reason: 'install command is empty' };
  if (BLOCKED_CHARS.test(trimmed)) return { valid: false, reason: 'install command contains blocked characters' };
  if (ALLOWED_PATTERNS[language].some((pattern) => pattern.test(trimmed))) return { valid: true };
  if (allowCustomInstall) return { valid: true };
  return { valid: false, reason: 'install command is not in allowlist' };
};

const resolveWorkdir = (repoDir: string, workdir?: string): { ok: true; dir: string } | { ok: false; reason: string } => {
  const trimmed = trimString(workdir);
  if (!trimmed) return { ok: true, dir: repoDir };
  if (path.isAbsolute(trimmed)) return { ok: false, reason: 'workdir must be a relative path' };
  const resolved = path.resolve(repoDir, trimmed);
  const relative = path.relative(repoDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'workdir must stay within the repository root' };
  }
  return { ok: true, dir: resolved };
};

const findRuntime = (language: 'node' | 'python' | 'java' | 'ruby' | 'go'): boolean => {
  const probes: Record<typeof language, Array<{ cmd: string; args: string[] }>> = {
    node: [{ cmd: 'node', args: ['--version'] }],
    python:
      process.platform === 'win32'
        ? [
            { cmd: 'python', args: ['--version'] },
            { cmd: 'py', args: ['-3', '--version'] },
            { cmd: 'python3', args: ['--version'] }
          ]
        : [
            { cmd: 'python3', args: ['--version'] },
            { cmd: 'python', args: ['--version'] }
          ],
    java: [{ cmd: 'java', args: ['--version'] }],
    ruby: [{ cmd: 'ruby', args: ['--version'] }],
    go: [{ cmd: 'go', args: ['version'] }]
  };
  return probes[language].some((probe) => {
    const result = xSpawnSync(probe.cmd, probe.args, { stdio: 'ignore' });
    return !result.error && result.status === 0;
  });
};

const installDependencies = async (params: {
  client: BackendInternalApiClient;
  taskId: string;
  config: HookcodeConfig | null;
  repoDir: string;
  signal: AbortSignal;
  killTimeoutMs: number;
  writeLine: (line: string) => void;
  failureMode?: DependencyFailureMode;
  allowCustomInstall?: boolean;
}) => {
  const runtimeList = params.config?.dependency?.runtimes ?? [];
  if (!runtimeList.length) {
    await params.client.patchDependencyResult(params.taskId, { status: 'skipped', steps: [], totalDuration: 0 });
    return;
  }

  const steps: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();
  const failureMode = params.failureMode ?? params.config?.dependency?.failureMode ?? 'soft';

  for (const runtime of runtimeList) {
    if (!findRuntime(runtime.language)) {
      const message = `Runtime "${runtime.language}" is required but not installed`;
      params.writeLine(`[worker] ${message}`);
      const step = {
        language: runtime.language,
        command: runtime.install,
        workdir: runtime.workdir,
        status: failureMode === 'hard' ? 'failed' : 'skipped',
        error: failureMode === 'hard' ? message : undefined,
        reason: 'runtime_missing'
      };
      steps.push(step);
      if (failureMode === 'hard') {
        const result = { status: 'failed', steps, totalDuration: Date.now() - startedAt };
        await params.client.patchDependencyResult(params.taskId, result);
        throw new Error(message);
      }
      continue;
    }

    const install = trimString(runtime.install);
    if (!install) {
      steps.push({ language: runtime.language, status: 'skipped', reason: 'no_install_command', workdir: runtime.workdir });
      continue;
    }

    const validation = validateInstallCommand(runtime.language, install, params.allowCustomInstall);
    if (!validation.valid) {
      const message = `Install command blocked: ${validation.reason ?? 'invalid command'}`;
      params.writeLine(`[worker] ${message}`);
      const step = {
        language: runtime.language,
        command: install,
        workdir: runtime.workdir,
        status: failureMode === 'hard' ? 'failed' : 'skipped',
        error: failureMode === 'hard' ? message : undefined,
        reason: 'command_blocked'
      };
      steps.push(step);
      if (failureMode === 'hard') {
        const result = { status: 'failed', steps, totalDuration: Date.now() - startedAt };
        await params.client.patchDependencyResult(params.taskId, result);
        throw new Error(message);
      }
      continue;
    }

    const workdirResolved = resolveWorkdir(params.repoDir, runtime.workdir);
    if (!workdirResolved.ok) {
      const message = `Invalid workdir for ${runtime.language}: ${workdirResolved.reason}`;
      params.writeLine(`[worker] ${message}`);
      const step = {
        language: runtime.language,
        command: install,
        workdir: runtime.workdir,
        status: failureMode === 'hard' ? 'failed' : 'skipped',
        error: failureMode === 'hard' ? message : undefined,
        reason: 'workdir_invalid'
      };
      steps.push(step);
      if (failureMode === 'hard') {
        const result = { status: 'failed', steps, totalDuration: Date.now() - startedAt };
        await params.client.patchDependencyResult(params.taskId, result);
        throw new Error(message);
      }
      continue;
    }

    params.writeLine(`[worker] installing ${runtime.language} dependencies: ${install}`);
    const stepStartedAt = Date.now();
    try {
      await streamCommand({
        command: install,
        cwd: workdirResolved.dir,
        signal: params.signal,
        killTimeoutMs: params.killTimeoutMs,
        writeLine: params.writeLine
      });
      steps.push({
        language: runtime.language,
        command: install,
        workdir: runtime.workdir,
        status: 'success',
        duration: Date.now() - stepStartedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({
        language: runtime.language,
        command: install,
        workdir: runtime.workdir,
        status: failureMode === 'hard' ? 'failed' : 'skipped',
        duration: Date.now() - stepStartedAt,
        error: message
      });
      if (failureMode === 'hard') {
        const result = { status: 'failed', steps, totalDuration: Date.now() - startedAt };
        await params.client.patchDependencyResult(params.taskId, result);
        throw error;
      }
    }
  }

  const hasFailed = steps.some((step) => step.status === 'failed');
  const hasSuccess = steps.some((step) => step.status === 'success');
  const hasSkipped = steps.some((step) => step.status === 'skipped');
  const status = hasFailed ? 'failed' : hasSuccess && hasSkipped ? 'partial' : hasSuccess ? 'success' : 'skipped';
  await params.client.patchDependencyResult(params.taskId, {
    status,
    steps,
    totalDuration: Date.now() - startedAt
  });
};

const splitNameOnly = (raw: string): string[] =>
  String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const parseAheadBehind = (raw: string): { ahead: number; behind: number } | null => {
  const parts = trimString(raw).split(/\s+/);
  if (parts.length < 2) return null;
  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
};

const buildWorkingTree = (params: { stagedRaw: string; unstagedRaw: string; untrackedRaw: string }): GitWorkingTree => ({
  staged: splitNameOnly(params.stagedRaw),
  unstaged: splitNameOnly(params.unstagedRaw),
  untracked: splitNameOnly(params.untrackedRaw)
});

const computeGitStatusDelta = (baseline?: GitStatusSnapshot, final?: GitStatusSnapshot): GitStatusDelta | null => {
  if (!baseline || !final) return null;
  return {
    branchChanged: Boolean(baseline.branch && final.branch && baseline.branch !== final.branch),
    headChanged: Boolean(baseline.headSha && final.headSha && baseline.headSha !== final.headSha)
  };
};

const computeGitPushState = (params: {
  delta: GitStatusDelta | null;
  final?: GitStatusSnapshot;
  pushTargetSha?: string;
  error?: string;
}): GitStatusPush => {
  if (params.error) return { status: 'error', reason: params.error };
  if (!params.delta || !params.final) return { status: 'unknown', reason: 'missing_final_snapshot' };
  if (!params.delta.headChanged) return { status: 'not_applicable', reason: 'no_local_commit' };
  if (!params.pushTargetSha) return { status: 'unpushed', reason: 'push_target_missing' };
  if (params.pushTargetSha === params.final.headSha) return { status: 'pushed' };
  return { status: 'unpushed', reason: 'push_target_behind' };
};

const normalizeGitRemoteUrl = (raw: string): string =>
  String(raw ?? '')
    .trim()
    .replace(/(https?:\/\/)([^@/\s]+)@/i, '$1')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

const toRepoWebUrl = (raw: string): string => {
  const normalized = normalizeGitRemoteUrl(raw);
  if (!normalized) return '';
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return normalized;
  const scpMatch = /^git@([^:]+):(.+)$/.exec(normalized);
  if (scpMatch) return `https://${scpMatch[1]}/${scpMatch[2].replace(/\/+$/, '')}`;
  const sshMatch = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(normalized);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2].replace(/\/+$/, '')}`;
  return normalized;
};

const collectGitStatusSnapshot = async (repoDir: string): Promise<{
  snapshot?: GitStatusSnapshot;
  workingTree?: GitWorkingTree;
  pushTargetSha?: string;
  errors: string[];
}> => {
  const errors: string[] = [];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const gitProxyFlags = buildGitProxyFlags();

  const runGit = async (command: string) => captureCommand({ command, cwd: repoDir, env });

  const branchRes = await runGit('git rev-parse --abbrev-ref HEAD');
  const branch = branchRes.exitCode === 0 ? trimString(branchRes.stdout) : '';
  if (!branch && branchRes.exitCode !== 0) errors.push(`branch: ${trimString(branchRes.stderr) || 'command_failed'}`);

  const headRes = await runGit('git rev-parse HEAD');
  const headSha = headRes.exitCode === 0 ? trimString(headRes.stdout) : '';
  if (!headSha && headRes.exitCode !== 0) errors.push(`head: ${trimString(headRes.stderr) || 'command_failed'}`);

  const upstreamRes = await runGit('git rev-parse --abbrev-ref --symbolic-full-name @{u}');
  const upstream = upstreamRes.exitCode === 0 ? trimString(upstreamRes.stdout) : '';

  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstream) {
    const aheadBehindRes = await runGit('git rev-list --left-right --count HEAD...@{u}');
    if (aheadBehindRes.exitCode === 0) {
      const parsed = parseAheadBehind(aheadBehindRes.stdout);
      if (parsed) {
        ahead = parsed.ahead;
        behind = parsed.behind;
      } else {
        errors.push('aheadBehind: parse_failed');
      }
    } else {
      errors.push(`aheadBehind: ${trimString(aheadBehindRes.stderr) || 'command_failed'}`);
    }
  }

  const pushRemoteRes = await runGit('git remote get-url --push origin');
  const pushRemoteRaw = pushRemoteRes.exitCode === 0 ? trimString(pushRemoteRes.stdout) : '';
  const pushRemote = pushRemoteRaw ? normalizeGitRemoteUrl(pushRemoteRaw) : '';
  const pushWebUrl = pushRemoteRaw ? toRepoWebUrl(pushRemoteRaw) : '';
  if (!pushRemote && pushRemoteRes.exitCode !== 0) {
    errors.push(`pushRemote: ${trimString(pushRemoteRes.stderr) || 'command_failed'}`);
  }

  let pushTargetSha: string | undefined;
  if (pushRemoteRaw && branch && branch !== 'HEAD') {
    const lsRemoteRes = await runGit(`git ${gitProxyFlags} ls-remote --heads ${shDoubleQuote(pushRemoteRaw)} ${shDoubleQuote(branch)}`);
    if (lsRemoteRes.exitCode === 0) {
      const firstLine = trimString(lsRemoteRes.stdout).split(/\r?\n/)[0] ?? '';
      const sha = firstLine.split(/\s+/)[0] ?? '';
      if (sha) pushTargetSha = sha;
    } else {
      errors.push(`pushTarget: ${trimString(lsRemoteRes.stderr) || 'command_failed'}`);
    }
  }

  const stagedRes = await runGit('git diff --name-only --cached');
  const unstagedRes = await runGit('git diff --name-only');
  const untrackedRes = await runGit('git ls-files --others --exclude-standard');
  const workingTree = buildWorkingTree({
    stagedRaw: stagedRes.exitCode === 0 ? stagedRes.stdout : '',
    unstagedRaw: unstagedRes.exitCode === 0 ? unstagedRes.stdout : '',
    untrackedRaw: untrackedRes.exitCode === 0 ? untrackedRes.stdout : ''
  });

  const snapshot =
    branch && headSha
      ? {
          branch,
          headSha,
          upstream: upstream || undefined,
          ahead,
          behind,
          pushRemote: pushRemote || undefined,
          pushWebUrl: pushWebUrl || undefined
        }
      : undefined;

  return { snapshot, workingTree, pushTargetSha, errors };
};

const updateProviderRoutingAttempt = (
  providerRouting: Record<string, unknown>,
  provider: string,
  patch: Record<string, unknown>
): Record<string, unknown> => {
  const attempts = Array.isArray(providerRouting.attempts) ? providerRouting.attempts : [];
  return {
    ...providerRouting,
    attempts: attempts.map((attempt) =>
      attempt && typeof attempt === 'object' && (attempt as Record<string, unknown>).provider === provider
        ? { ...(attempt as Record<string, unknown>), ...patch }
        : attempt
    )
  };
};

const writeWorkspaceFiles = async (workspaceDir: string, files: RemoteExecutionBundle['workspaceFiles']) => {
  await mkdir(path.join(workspaceDir, '.codex', 'skills'), { recursive: true });
  await mkdir(path.join(workspaceDir, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(workspaceDir, '.gemini', 'skills'), { recursive: true });
  for (const file of files) {
    const targetPath = path.join(workspaceDir, file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.contents, 'utf8');
  }
};

const buildClaudeWorkspacePromptPrefix = (workspaceDir: string, repoFolderName: string): string =>
  [
    'TASK GROUP WORKSPACE CONTEXT',
    `Workspace root (cwd): ${workspaceDir}`,
    `Repository folder: ${repoFolderName}`,
    'Always treat the workspace root as the current working directory.',
    `When accessing repo files, include the repository folder in paths (for example, "${repoFolderName}/README.md").`,
    ''
  ].join('\n');

const parseCodexOutputSchema = async (workspaceDir: string, writeLine: (line: string) => void): Promise<unknown | undefined> => {
  try {
    const raw = await readFile(path.join(workspaceDir, 'codex-schema.json'), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeLine('[worker] codex-schema.json must be a JSON object; skipping outputSchema.');
      return undefined;
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    writeLine(`[worker] failed to parse codex-schema.json; skipping outputSchema: ${error?.message || error}`);
    return undefined;
  }
};

const configureRepoLocalGitProxy = async (repoDir: string) => {
  const proxy = trimString(process.env.GIT_HTTP_PROXY);
  if (!proxy) return;
  await captureCommand({
    command: `git config --local http.proxy ${shDoubleQuote(proxy)} && git config --local https.proxy ${shDoubleQuote(proxy)}`,
    cwd: repoDir,
    env: process.env as Record<string, string>
  });
};

const cloneRepo = async (params: {
  bundle: RemoteExecutionBundle;
  repoDir: string;
  workspaceDir: string;
  writeLine: (line: string) => void;
  signal: AbortSignal;
  killTimeoutMs: number;
}) => {
  const gitProxyFlags = buildGitProxyFlags();
  const runCloneCommand = async (options?: { branch?: string; forceHttp11?: boolean }) => {
    const segments = [
      'git',
      gitProxyFlags,
      options?.forceHttp11 ? '-c http.version=HTTP/1.1' : '',
      'clone',
      options?.branch ? `--branch ${shDoubleQuote(options.branch)}` : '',
      shDoubleQuote(params.bundle.git.cloneUrl),
      shDoubleQuote(params.repoDir)
    ].filter(Boolean);
    await streamCommand({
      command: segments.join(' '),
      cwd: params.workspaceDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as Record<string, string>,
      signal: params.signal,
      killTimeoutMs: params.killTimeoutMs,
      writeLine: params.writeLine
    });
  };

  const checkoutRef = trimString(params.bundle.checkout?.ref);
  if (checkoutRef) {
    try {
      params.writeLine(`[worker] cloning repository (branch ${checkoutRef}) ${params.bundle.git.displayCloneUrl}`);
      await runCloneCommand({ branch: checkoutRef });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (GIT_TRANSIENT_NETWORK_ERROR_PATTERN.test(message)) {
        params.writeLine('[worker] branch clone hit a transient git transport error; retrying with HTTP/1.1');
        await rm(params.repoDir, { recursive: true, force: true });
        await runCloneCommand({ branch: checkoutRef, forceHttp11: true });
        return;
      }
      params.writeLine(`[worker] branch clone failed; falling back to default clone: ${message}`);
      await rm(params.repoDir, { recursive: true, force: true });
    }
  }

  params.writeLine(`[worker] cloning repository ${params.bundle.git.displayCloneUrl}`);
  try {
    await runCloneCommand();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!GIT_TRANSIENT_NETWORK_ERROR_PATTERN.test(message)) throw error;
    params.writeLine('[worker] default clone hit a transient git transport error; retrying with HTTP/1.1');
    await rm(params.repoDir, { recursive: true, force: true });
    await runCloneCommand({ forceHttp11: true });
  }
};

const prepareRepository = async (params: {
  bundle: RemoteExecutionBundle;
  repoDir: string;
  workspaceDir: string;
  writeLine: (line: string) => void;
  signal: AbortSignal;
  killTimeoutMs: number;
}): Promise<{ reuseWorkspace: boolean }> => {
  const checkoutRef = trimString(params.bundle.checkout?.ref);
  const gitDir = path.join(params.repoDir, '.git');
  let repoDirExists = false;
  let workspaceReady = false;
  try {
    await stat(params.repoDir);
    repoDirExists = true;
  } catch {
    repoDirExists = false;
  }
  if (repoDirExists) {
    try {
      await stat(gitDir);
      workspaceReady = true;
    } catch {
      workspaceReady = false;
    }
  }
  if (repoDirExists && !workspaceReady) {
    params.writeLine('[worker] workspace directory exists without git metadata; recreating workspace');
    await rm(params.repoDir, { recursive: true, force: true });
  }

  const reuseWorkspace = workspaceReady && params.bundle.hasPriorTaskGroupTask;
  const allowNetworkPull = !reuseWorkspace;

  if (!workspaceReady) {
    await cloneRepo(params);
  }

  await configureRepoLocalGitProxy(params.repoDir);
  await streamCommand({
    command: `git remote set-url origin ${shDoubleQuote(params.bundle.git.cloneUrl)} && git remote set-url --push origin ${shDoubleQuote(params.bundle.git.pushUrl)}`,
    cwd: params.repoDir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as Record<string, string>,
    signal: params.signal,
    killTimeoutMs: params.killTimeoutMs,
    writeLine: params.writeLine
  });

  const gitProxyFlags = buildGitProxyFlags();
  if (checkoutRef) {
    try {
      params.writeLine(`[worker] checking out branch ${checkoutRef}`);
      await streamCommand({
        command: `git checkout ${shDoubleQuote(checkoutRef)}`,
        cwd: params.repoDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as Record<string, string>,
        signal: params.signal,
        killTimeoutMs: params.killTimeoutMs,
        writeLine: params.writeLine
      });
      if (allowNetworkPull) {
        await streamCommand({
          command: `git ${gitProxyFlags} pull --no-rebase origin ${shDoubleQuote(checkoutRef)}`,
          cwd: params.repoDir,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as Record<string, string>,
          signal: params.signal,
          killTimeoutMs: params.killTimeoutMs,
          writeLine: params.writeLine
        });
      } else {
        params.writeLine('[worker] skipping git pull for existing task-group workspace');
      }
    } catch (error) {
      params.writeLine(`[worker] checkout/pull failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (allowNetworkPull) {
    try {
      params.writeLine('[worker] updating default branch');
      await streamCommand({
        command: `git ${gitProxyFlags} pull --no-rebase`,
        cwd: params.repoDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } as Record<string, string>,
        signal: params.signal,
        killTimeoutMs: params.killTimeoutMs,
        writeLine: params.writeLine
      });
    } catch (error) {
      params.writeLine(`[worker] default branch update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { reuseWorkspace };
};

export const runRemoteTaskExecution = async (params: {
  client: BackendInternalApiClient;
  config: WorkerConfig;
  taskId: string;
  task: Record<string, unknown>;
  signal: AbortSignal;
  stopReason?: 'manual_stop' | 'deleted';
  writeLine: (line: string) => void;
  prepareRuntime?: (providers: string[]) => Promise<void>;
}): Promise<RemoteTaskExecutionSuccess> => {
  const bundle = (await params.client.getTaskExecutionBundle(params.taskId)).bundle;
  const workspaceDir = path.join(params.config.workspaceRootDir, bundle.taskGroupId);
  const repoDir = path.join(workspaceDir, bundle.repoFolderName);

  let providerCommentUrl: string | undefined;
  let gitStatus: GitStatus | undefined;
  let repoChangeTracker: RepoChangeTracker | null = null;
  let repoChangeTrackerStopped = false;

  const stopTracker = async () => {
    if (repoChangeTracker && !repoChangeTrackerStopped) {
      await repoChangeTracker.stop();
      repoChangeTrackerStopped = true;
    }
  };

  try {
    await mkdir(workspaceDir, { recursive: true });
    await writeWorkspaceFiles(workspaceDir, bundle.workspaceFiles);

    params.writeLine(`[worker] task ${params.taskId} workspace: ${workspaceDir}`);
    params.writeLine(`[worker] remote execution bundle provider: ${bundle.provider}`);
    await params.client.patchResult(
      params.taskId,
      {
        message: 'Worker started remote-native execution',
        workerCommandSource: 'remote-native',
        providerRouting: bundle.providerRouting,
        repoWorkflow: bundle.repoWorkflow ?? null
      },
      'processing'
    );

    await ensureProviderRuntimesPrepared({
      config: params.config,
      bundle,
      writeLine: params.writeLine,
      prepareRuntime: params.prepareRuntime
    });

    const { reuseWorkspace } = await prepareRepository({
      bundle,
      repoDir,
      workspaceDir,
      writeLine: params.writeLine,
      signal: params.signal,
      killTimeoutMs: params.config.cancelKillTimeoutMs
    });

    const hookcodeConfig = await parseHookcodeConfig(repoDir);
    if (hookcodeConfig?.dependency && reuseWorkspace) {
      await params.client.patchDependencyResult(params.taskId, { status: 'skipped', steps: [], totalDuration: 0 });
      params.writeLine('[worker] skipping dependency installation because this task group already has a prepared workspace on this worker.');
    } else if (hookcodeConfig?.dependency && bundle.dependencyConfig?.enabled === false) {
      await params.client.patchDependencyResult(params.taskId, { status: 'skipped', steps: [], totalDuration: 0 });
      params.writeLine('[worker] dependency installation disabled by robot configuration');
    } else {
      await installDependencies({
        client: params.client,
        taskId: params.taskId,
        config: hookcodeConfig,
        repoDir,
        signal: params.signal,
        killTimeoutMs: params.config.cancelKillTimeoutMs,
        writeLine: params.writeLine,
        failureMode: bundle.dependencyConfig?.failureMode,
        allowCustomInstall: bundle.dependencyConfig?.allowCustomInstall
      });
    }

    const requiresGitIdentity = bundle.attempts.some((attempt) => attempt.runConfig.sandbox === 'workspace-write');
    if (requiresGitIdentity) {
      const gitIdentity = bundle.gitIdentity;
      if (!gitIdentity?.userName || !gitIdentity?.userEmail) {
        throw new Error('missing git identity for workspace-write remote execution');
      }
      params.writeLine(`[worker] configuring git identity: ${gitIdentity.userName} <${gitIdentity.userEmail}>`);
      await streamCommand({
        command: `git config --local user.name ${shDoubleQuote(gitIdentity.userName)} && git config --local user.email ${shDoubleQuote(gitIdentity.userEmail)}`,
        cwd: repoDir,
        env: process.env as Record<string, string>,
        signal: params.signal,
        killTimeoutMs: params.config.cancelKillTimeoutMs,
        writeLine: params.writeLine
      });

      gitStatus = { enabled: true, capturedAt: new Date().toISOString(), errors: [] };
      const baselineCapture = await collectGitStatusSnapshot(repoDir);
      if (baselineCapture.snapshot) gitStatus.baseline = baselineCapture.snapshot;
      if (baselineCapture.errors.length > 0) gitStatus.errors?.push(...baselineCapture.errors);

      repoChangeTracker = new RepoChangeTracker({
        repoDir,
        emitLine: params.writeLine,
        patchSnapshot: async (snapshot) => {
          await params.client.patchResult(params.taskId, { workspaceChanges: snapshot });
        }
      });
      await repoChangeTracker.start();
    }

    let providerRouting = JSON.parse(JSON.stringify(bundle.providerRouting)) as Record<string, unknown>;
    let tokenUsage: TaskTokenUsage | undefined;
    let finalResponse = '';
    let resumeThreadId = trimString(bundle.resumeThreadId);
    let providerRunSucceeded = false;

    const patchExecutionState = async () => {
      await params.client.patchResult(params.taskId, {
        providerRouting,
        ...(tokenUsage ? { tokenUsage } : {})
      });
    };

    for (let index = 0; index < bundle.attempts.length; index += 1) {
      const attempt = bundle.attempts[index];
      const failoverExecution = attempt.role === 'fallback' && index > 0;
      providerRouting = {
        ...updateProviderRoutingAttempt(providerRouting, attempt.provider, {
          status: 'running',
          reason: failoverExecution ? 'Running after primary provider failure.' : 'Selected for execution.',
          startedAt: new Date().toISOString(),
          finishedAt: undefined,
          error: undefined
        }),
        failoverTriggered: Boolean((providerRouting as Record<string, unknown>).failoverTriggered) || failoverExecution
      };
      await patchExecutionState();
      params.writeLine(
        `[worker] provider routing attempt ${index + 1}/${bundle.attempts.length}: executing ${attempt.provider} (${attempt.role}).`
      );

      if (!attempt.credential.canExecute) {
        const message = attempt.credential.reason || `No executable credential is available for provider ${attempt.provider}`;
        providerRouting = updateProviderRoutingAttempt(providerRouting, attempt.provider, {
          status: 'failed',
          error: message,
          reason: message,
          finishedAt: new Date().toISOString()
        });
        await patchExecutionState();
        if (index === bundle.attempts.length - 1) {
          throw new Error(message);
        }
        continue;
      }

      const promptBody =
        attempt.provider === 'claude_code'
          ? `${buildClaudeWorkspacePromptPrefix(workspaceDir, bundle.repoFolderName)}${bundle.promptBase}`
          : bundle.promptBase;
      const promptFile = path.join(repoDir, '.codex_prompt.txt');
      await writeFile(promptFile, promptBody, 'utf8');

      const providerLogLine = async (line: string) => {
        tokenUsage = addTaskTokenUsage(
          tokenUsage,
          extractCodexExecTokenUsageDeltaFromLine(line) ??
            extractClaudeCodeExecTokenUsageDeltaFromLine(line) ??
            extractGeminiCliExecTokenUsageDeltaFromLine(line) ??
            { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        );
        params.writeLine(line);
      };

      try {
        const env =
          attempt.runConfig.sandbox === 'workspace-write' && bundle.gitIdentity
            ? {
                GIT_AUTHOR_NAME: bundle.gitIdentity.userName,
                GIT_AUTHOR_EMAIL: bundle.gitIdentity.userEmail,
                GIT_COMMITTER_NAME: bundle.gitIdentity.userName,
                GIT_COMMITTER_EMAIL: bundle.gitIdentity.userEmail
              }
            : undefined;

        const result =
          attempt.provider === 'codex'
            ? await runCodexExecWithSdk({
                repoDir,
                workspaceDir,
                promptFile,
                model: trimString(attempt.runConfig.normalized.model),
                sandbox: attempt.runConfig.sandbox,
                modelReasoningEffort: trimString(attempt.runConfig.normalized.model_reasoning_effort) || 'medium',
                resumeThreadId: resumeThreadId || undefined,
                apiKey: trimString(attempt.credential.apiKey) || undefined,
                apiBaseUrl: trimString(attempt.credential.apiBaseUrl) || undefined,
                outputSchema: await parseCodexOutputSchema(workspaceDir, params.writeLine),
                outputLastMessageFile: path.join(workspaceDir, attempt.runConfig.outputLastMessageFileName),
                signal: params.signal,
                env,
                redact: redactSensitiveText,
                logLine: providerLogLine
              })
            : attempt.provider === 'claude_code'
              ? await runClaudeCodeExecWithSdk({
                  repoDir,
                  workspaceDir,
                  promptFile,
                  model: trimString(attempt.runConfig.normalized.model),
                  sandbox: attempt.runConfig.sandbox,
                  networkAccess: attempt.runConfig.networkAccess,
                  resumeSessionId: resumeThreadId || undefined,
                  apiKey: trimString(attempt.credential.apiKey) || undefined,
                  apiBaseUrl: trimString(attempt.credential.apiBaseUrl) || undefined,
                  outputLastMessageFile: path.join(workspaceDir, attempt.runConfig.outputLastMessageFileName),
                  signal: params.signal,
                  env,
                  redact: redactSensitiveText,
                  logLine: providerLogLine
                })
              : await runGeminiCliExecWithCli({
                  repoDir,
                  workspaceDir,
                  promptFile,
                  model: trimString(attempt.runConfig.normalized.model),
                  sandbox: attempt.runConfig.sandbox,
                  networkAccess: attempt.runConfig.networkAccess,
                  resumeSessionId: resumeThreadId || undefined,
                  apiKey: trimString(attempt.credential.apiKey) || undefined,
                  apiBaseUrl: trimString(attempt.credential.apiBaseUrl) || undefined,
                  outputLastMessageFile: path.join(workspaceDir, attempt.runConfig.outputLastMessageFileName),
                  geminiHomeDir: path.join(params.config.runtimeInstallDir, 'gemini-home', bundle.taskGroupId),
                  signal: params.signal,
                  env,
                  redact: redactSensitiveText,
                  logLine: providerLogLine
                });

        const nextThreadId = trimString(result.threadId);
        if (nextThreadId) {
          resumeThreadId = nextThreadId;
          await params.client.setThreadId(bundle.taskGroupId, nextThreadId);
        }
        finalResponse = result.finalResponse;
        providerRouting = {
          ...updateProviderRoutingAttempt(providerRouting, attempt.provider, {
            status: 'succeeded',
            reason: failoverExecution ? 'Fallback provider succeeded after primary failure.' : 'Execution completed successfully.',
            finishedAt: new Date().toISOString()
          }),
          finalProvider: attempt.provider,
          failoverTriggered: Boolean((providerRouting as Record<string, unknown>).failoverTriggered) || failoverExecution
        };
        providerRunSucceeded = true;
        await patchExecutionState();
        break;
      } catch (error) {
        if (params.signal.aborted) throw error;
        const safeError = redactSensitiveText(error instanceof Error ? error.message : String(error));
        providerRouting = updateProviderRoutingAttempt(providerRouting, attempt.provider, {
          status: 'failed',
          error: safeError,
          reason: safeError,
          finishedAt: new Date().toISOString()
        });
        await patchExecutionState();
        params.writeLine(`[worker] provider routing attempt failed: provider=${attempt.provider} role=${attempt.role} error=${safeError}`);
        if (attempt.role === 'fallback' || index === bundle.attempts.length - 1) {
          throw error;
        }
      }
    }

    if (!providerRunSucceeded) {
      throw new Error('remote provider execution did not complete successfully');
    }

    await stopTracker();

    if (gitStatus?.enabled) {
      const finalCapture = await collectGitStatusSnapshot(repoDir);
      gitStatus.capturedAt = new Date().toISOString();
      if (finalCapture.snapshot) gitStatus.final = finalCapture.snapshot;
      if (finalCapture.workingTree) gitStatus.workingTree = finalCapture.workingTree;
      gitStatus.delta = computeGitStatusDelta(gitStatus.baseline, finalCapture.snapshot) ?? undefined;
      const pushError = finalCapture.errors.find((entry) => entry.startsWith('pushTarget:') || entry.startsWith('pushRemote:'));
      gitStatus.push = {
        ...computeGitPushState({
          delta: gitStatus.delta ?? null,
          final: finalCapture.snapshot,
          pushTargetSha: finalCapture.pushTargetSha,
          error: pushError
        }),
        targetBranch: finalCapture.snapshot?.branch,
        targetWebUrl: finalCapture.snapshot?.pushWebUrl,
        targetHeadSha: finalCapture.pushTargetSha
      };
      if (finalCapture.errors.length > 0) {
        if (!gitStatus.errors) gitStatus.errors = [];
        gitStatus.errors.push(...finalCapture.errors);
      }
    }

    const safeOutputText = redactSensitiveText(finalResponse).trimEnd();
    if (bundle.skipProviderPost) {
      params.writeLine('[worker] provider posting skipped (chat/manual task)');
    } else {
      try {
        providerCommentUrl = trimString(
          (await params.client.postProviderResult(params.taskId, { status: 'succeeded', outputText: safeOutputText })).providerCommentUrl
        );
      } catch (error) {
        params.writeLine(`[worker] provider post failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await params.client.patchResult(params.taskId, {
      ...(tokenUsage ? { tokenUsage } : {}),
      providerRouting
    });

    return {
      outputText: safeOutputText || undefined,
      gitStatus: gitStatus as unknown as Record<string, unknown>,
      providerCommentUrl: providerCommentUrl || undefined
    };
  } catch (error) {
    await stopTracker();
    if (params.signal.aborted) {
      throw new Error(resolveAbortMessage(params.stopReason));
    }

    if (gitStatus?.enabled && !gitStatus.final) {
      try {
        const finalCapture = await collectGitStatusSnapshot(repoDir);
        gitStatus.capturedAt = new Date().toISOString();
        if (finalCapture.snapshot) gitStatus.final = finalCapture.snapshot;
        if (finalCapture.workingTree) gitStatus.workingTree = finalCapture.workingTree;
        gitStatus.delta = computeGitStatusDelta(gitStatus.baseline, finalCapture.snapshot) ?? undefined;
        if (finalCapture.errors.length > 0) {
          if (!gitStatus.errors) gitStatus.errors = [];
          gitStatus.errors.push(...finalCapture.errors);
        }
      } catch (captureError) {
        if (!gitStatus.errors) gitStatus.errors = [];
        gitStatus.errors.push(`capture: ${captureError instanceof Error ? captureError.message : String(captureError)}`);
      }
    }

    if (!bundle.skipProviderPost) {
      try {
        providerCommentUrl = trimString(
          (
            await params.client.postProviderResult(params.taskId, {
              status: 'failed',
              message: redactSensitiveText(error instanceof Error ? error.message : String(error))
            })
          ).providerCommentUrl
        );
      } catch (postError) {
        params.writeLine(`[worker] provider failure post failed (ignored): ${postError instanceof Error ? postError.message : String(postError)}`);
      }
    }

    throw new WorkerTaskExecutionError(error instanceof Error ? error.message : String(error), {
      providerCommentUrl: providerCommentUrl || undefined,
      gitStatus: gitStatus as unknown as Record<string, unknown>,
      cause: error
    });
  }
};
