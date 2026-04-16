import { accessSync, constants } from 'fs';
import path from 'path';
import type { WorkerProviderKey, WorkerProviderRuntimeEntry, WorkerProviderRuntimeStatuses, WorkerRuntimeState } from '../protocol';
import { xSpawnSync } from './crossPlatformSpawn';
import { buildWorkerRuntimeState, normalizeWorkerProviderKey, WORKER_PROVIDER_KEYS } from './providerRuntimeState';

type ProviderProbe = {
  command: string;
  args: string[];
};

const PROVIDER_PROBES: Record<WorkerProviderKey, ProviderProbe> = {
  codex: { command: 'codex', args: ['--version'] },
  claude_code: { command: 'claude', args: ['--version'] },
  gemini_cli: { command: 'gemini', args: ['--version'] }
};

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isExecutableFile = (filePath: string): boolean => {
  try {
    accessSync(filePath, constants.F_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveBinaryOnPath = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined => {
  const rawPath = trimString(env.PATH);
  if (!rawPath) return undefined;
  const pathEntries = rawPath.split(path.delimiter).filter(Boolean);
  const extensions =
    platform === 'win32'
      ? Array.from(
          new Set(
            (trimString(env.PATHEXT) || '.EXE;.CMD;.BAT;.COM')
              .split(';')
              .map((entry) => entry.trim())
              .filter(Boolean)
          )
        )
      : [''];

  const directCandidates =
    platform === 'win32' && !path.extname(command)
      ? extensions.map((extension) => `${command}${extension.toLowerCase()}`)
      : [command];

  for (const baseDir of pathEntries) {
    for (const candidate of directCandidates) {
      const resolved = path.join(baseDir, candidate);
      if (isExecutableFile(resolved)) return resolved;
      if (platform === 'win32') {
        const exactCaseCandidates = extensions.map((extension) => path.join(baseDir, `${command}${extension}`));
        for (const exactPath of exactCaseCandidates) {
          if (isExecutableFile(exactPath)) return exactPath;
        }
      }
    }
  }
  return undefined;
};

const buildProbeError = (params: {
  command: string;
  result: { status: number | null; error?: Error | null; stdout?: string | Buffer; stderr?: string | Buffer };
}): string => {
  if (params.result.error) return params.result.error.message;
  const output = `${String(params.result.stdout ?? '')}\n${String(params.result.stderr ?? '')}`.trim();
  if (output) return output.split(/\r?\n/).slice(-3).join(' | ');
  return `${params.command} exited with code ${params.result.status ?? 'unknown'}`;
};

const detectProviderRuntimeEntry = (
  provider: WorkerProviderKey,
  checkedAt: string,
  env: NodeJS.ProcessEnv = process.env
): WorkerProviderRuntimeEntry => {
  const probe = PROVIDER_PROBES[provider];
  const binaryPath = resolveBinaryOnPath(probe.command, env);
  if (!binaryPath) {
    return {
      status: 'idle',
      checkedAt,
      command: probe.command
    };
  }

  const result = xSpawnSync(probe.command, probe.args, {
    encoding: 'utf8',
    timeout: 2_000,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const versionOutput = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim();
  if (!result.error && result.status === 0) {
    return {
      status: 'ready',
      checkedAt,
      command: probe.command,
      path: binaryPath,
      version: versionOutput.split(/\r?\n/)[0]?.trim() || undefined
    };
  }

  return {
    status: 'error',
    checkedAt,
    command: probe.command,
    path: binaryPath,
    error: buildProbeError({ command: probe.command, result })
  };
};

export const detectWorkerProviderStatuses = (
  providers: WorkerProviderKey[] = WORKER_PROVIDER_KEYS,
  env: NodeJS.ProcessEnv = process.env
): WorkerProviderRuntimeStatuses => {
  const checkedAt = new Date().toISOString();
  const next: WorkerProviderRuntimeStatuses = {};
  for (const provider of providers) {
    next[provider] = detectProviderRuntimeEntry(provider, checkedAt, env);
  }
  return next;
};

export const detectWorkerRuntimeState = (
  providers: WorkerProviderKey[] = WORKER_PROVIDER_KEYS,
  env: NodeJS.ProcessEnv = process.env
): WorkerRuntimeState => {
  const checkedAt = new Date().toISOString();
  const providerStatuses = detectWorkerProviderStatuses(providers, env);
  return buildWorkerRuntimeState(providerStatuses, { lastCheckedAt: checkedAt });
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
  const routeProviders = Array.isArray(routingConfig)
    ? routingConfig
        .map((entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry) ? normalizeWorkerProviderKey((entry as Record<string, unknown>).provider) : null
        )
        .filter(Boolean)
    : [];
  const normalized = normalizeWorkerProviderKey(provider) ?? 'codex';
  return Array.from(new Set([normalized, ...routeProviders])) as WorkerProviderKey[];
};
