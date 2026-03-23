import type { SpawnSyncOptions, SpawnSyncReturns } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { WorkerRuntimeState } from '../protocol';
import { xSpawn, xSpawnSync } from './crossPlatformSpawn';

const PROVIDER_PACKAGES: Record<string, string[]> = {
  codex: ['@openai/codex-sdk'],
  claude_code: ['@anthropic-ai/claude-agent-sdk'],
  gemini_cli: ['@google/gemini-cli']
};
const PNPM_PACKAGE_MANAGER = 'pnpm@9.6.0';

/**
 * Module-level mutex that serialises all provider SDK install operations.
 * Both WorkerProcess.prepareRuntime() and remoteTaskExecution's
 * ensureProviderRuntimesPrepared() ultimately call prepareRuntimeProviders()
 * which passes through this lock, preventing concurrent npm/pnpm writes to
 * the same vendor directory.
 */
let activeInstallPromise: Promise<WorkerRuntimeState> | null = null;

type VendorManifest = {
  name?: string;
  private?: boolean;
  packageManager?: string;
  dependencies?: Record<string, string>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const packageIsResolvableWithRetry = async (pkg: string, retries = 3, delayMs = 500): Promise<boolean> => {
  for (let i = 0; i < retries; i += 1) {
    if (packageIsResolvable(pkg)) return true;
    if (i < retries - 1) await sleep(delayMs);
  }
  return false;
};

const applyNodePath = (vendorDir: string): void => {
  const nodeModulesDir = path.join(vendorDir, 'node_modules');
  const current = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  if (!current.includes(nodeModulesDir)) {
    process.env.NODE_PATH = [...current, nodeModulesDir].filter(Boolean).join(path.delimiter);
    const moduleLib = require('module') as { _initPaths?: () => void };
    moduleLib._initPaths?.();
  }
};

export const detectNpmCommand = (
  runSync: (command: string, args: string[], opts?: SpawnSyncOptions) => SpawnSyncReturns<Buffer | string> = xSpawnSync
): { command: string; args: string[] } => {
  // Prefer pnpm when available, but keep npm as a fallback so the worker can bootstrap on clean machines. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
  // Reuse the cross-platform spawn wrapper so Windows `.cmd` shims are probed the same way as real execution commands. docs/en/developer/plans/crossplatformcompat20260318/task_plan.md crossplatformcompat20260318
  const pnpmCheck = runSync('pnpm', ['--version'], { stdio: 'ignore' });
  if (!pnpmCheck.error && pnpmCheck.status === 0) {
    return { command: 'pnpm', args: ['add', '--ignore-workspace', '--save-prod'] };
  }
  return { command: 'npm', args: ['install', '--no-save'] };
};

const installPackages = async (vendorDir: string, packages: string[]): Promise<void> => {
  await mkdir(vendorDir, { recursive: true });
  const { command, args } = detectNpmCommand();
  const packageJsonPath = path.join(vendorDir, 'package.json');
  let manifest: VendorManifest = { name: 'hookcode-worker-vendor', private: true };

  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as VendorManifest;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = {
        ...parsed,
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : 'hookcode-worker-vendor',
        private: true
      };
    }
  } catch {
    manifest = { name: 'hookcode-worker-vendor', private: true };
  }

  if (command === 'pnpm') {
    manifest.packageManager = PNPM_PACKAGE_MANAGER;
  }

  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await new Promise<void>((resolve, reject) => {
    const child = xSpawn(command, [...args, ...packages], {
      cwd: vendorDir,
      stdio: 'inherit',
      env: process.env
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
};

export const applyWorkerVendorNodePath = (vendorDir: string): void => {
  // Extend NODE_PATH with the worker-owned vendor directory so runtime-installed provider SDKs stay isolated from project deps. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
  applyNodePath(vendorDir);
};

export const resolvePreparedProviders = (): string[] => {
  return Object.entries(PROVIDER_PACKAGES)
    .filter(([, packages]) => packages.every((pkg) => packageIsResolvable(pkg)))
    .map(([provider]) => provider);
};

/**
 * Internal implementation — callers go through the serialised wrapper below.
 */
const prepareRuntimeProvidersInternal = async (
  vendorDir: string,
  targets: string[],
  priorState?: WorkerRuntimeState
): Promise<WorkerRuntimeState> => {
  const runtimeState: WorkerRuntimeState = {
    preparedProviders: priorState?.preparedProviders ?? resolvePreparedProviders(),
    preparingProviders: targets,
    lastPrepareAt: new Date().toISOString(),
    lastPrepareError: undefined
  };
  applyNodePath(vendorDir);

  try {
    const missingPackages = Array.from(
      new Set(targets.flatMap((provider) => PROVIDER_PACKAGES[provider] ?? []).filter((pkg) => !packageIsResolvable(pkg)))
    );
    if (missingPackages.length > 0) {
      // Install provider runtimes only when requested so the distributed worker package can remain small by default. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
      await installPackages(vendorDir, missingPackages);
      applyNodePath(vendorDir);

      // Verify packages are actually resolvable after install (file system caching may delay visibility).
      const stillMissing: string[] = [];
      for (const pkg of missingPackages) {
        if (!(await packageIsResolvableWithRetry(pkg))) {
          stillMissing.push(pkg);
        }
      }
      if (stillMissing.length > 0) {
        return {
          preparedProviders: resolvePreparedProviders(),
          preparingProviders: [],
          lastPrepareAt: new Date().toISOString(),
          lastPrepareError: `packages installed but not resolvable: ${stillMissing.join(', ')}`
        };
      }
    }
    return {
      preparedProviders: resolvePreparedProviders(),
      preparingProviders: [],
      lastPrepareAt: new Date().toISOString(),
      lastPrepareError: undefined
    };
  } catch (error) {
    return {
      preparedProviders: resolvePreparedProviders(),
      preparingProviders: [],
      lastPrepareAt: new Date().toISOString(),
      lastPrepareError: error instanceof Error ? error.message : String(error)
    };
  }
};

/**
 * Serialised entry-point for provider SDK installation.
 *
 * A module-level promise lock ensures only one npm/pnpm install process runs
 * at a time.  When a second caller arrives while an install is in-flight the
 * new request is queued: the existing promise is awaited first, then the
 * remaining (not-yet-prepared) providers are installed in a follow-up pass.
 */
export const prepareRuntimeProviders = async (
  vendorDir: string,
  providers?: string[],
  priorState?: WorkerRuntimeState
): Promise<WorkerRuntimeState> => {
  const targets = Array.from(new Set((providers ?? Object.keys(PROVIDER_PACKAGES)).filter((provider) => provider in PROVIDER_PACKAGES)));

  // Wait for any in-flight install to finish before starting a new one.
  if (activeInstallPromise) {
    try {
      await activeInstallPromise;
    } catch {
      // Prior install failed — we still want to attempt our own.
    }
  }

  // After waiting, some or all requested providers may already be prepared.
  const alreadyPrepared = resolvePreparedProviders();
  const remaining = targets.filter((provider) => !alreadyPrepared.includes(provider));
  if (remaining.length === 0) {
    return {
      preparedProviders: alreadyPrepared,
      preparingProviders: [],
      lastPrepareAt: new Date().toISOString(),
      lastPrepareError: undefined
    };
  }

  const promise = prepareRuntimeProvidersInternal(vendorDir, remaining, priorState);
  activeInstallPromise = promise;
  try {
    return await promise;
  } finally {
    if (activeInstallPromise === promise) {
      activeInstallPromise = null;
    }
  }
};

export const resolveTaskProvidersFromContext = (context: {
  task?: Record<string, unknown> | null;
  robotsInRepo?: Array<Record<string, unknown>>;
}): string[] => {
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
  const providers = [provider, fallbackProvider].filter((entry) => entry in PROVIDER_PACKAGES);
  return providers.length > 0 ? Array.from(new Set(providers)) : ['codex'];
};
