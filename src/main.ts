#!/usr/bin/env node
import { verifyWorkerApiKey } from './backend/registrationClient';
import { parseWorkerConfig, resolveWorkerRuntimeOptions } from './config';
import { readWorkerCredentials, writeWorkerCredentials, type WorkerCredentials } from './credentials';
import { loadWorkerEnvFile } from './envFile';
import { buildCliUpgradeCommand, buildGlobalInstallCommand, readPackageVersion } from './packageInfo';
import { resolveUpgradeTargetArg, upgradeWorkerPackage } from './upgrade';
import { WorkerProcess } from './workerProcess';
import { printHelp } from './commands/help';
import { startDaemon } from './commands/start';
import { stopDaemon } from './commands/stop';
import { showStatus } from './commands/status';
import { showInfo } from './commands/info';
import { unbindWorker } from './commands/unbind';
import { writePidFile, removePidFile } from './pidFile';

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const resolveCliFlag = (argv: string[], flag: string): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    return trimString(argv[index + 1]) || undefined;
  }
  return undefined;
};

const hasHelpFlag = (argv: string[]): boolean => argv.includes('--help') || argv.includes('-h');

const KNOWN_COMMANDS = ['configure', 'run', 'start', 'stop', 'status', 'info', 'unbind', 'version', 'upgrade', 'help'] as const;
type Command = (typeof KNOWN_COMMANDS)[number];

const configureWorker = async (backendUrl: string, apiKey: string, workDirRoot: string): Promise<WorkerCredentials> => {
  const verified = await verifyWorkerApiKey(backendUrl, apiKey);
  console.log(`[worker] API key verified — worker: ${verified.workerName} (${verified.workerId})`);
  const credentials: WorkerCredentials = {
    backendUrl,
    apiKey,
    configuredAt: new Date().toISOString()
  };
  writeWorkerCredentials(workDirRoot, credentials);
  return credentials;
};

const main = async (): Promise<void> => {
  const loadedEnvFile = loadWorkerEnvFile({ env: process.env });
  if (loadedEnvFile) {
    console.log(`[worker] loaded env file ${loadedEnvFile.path} (${loadedEnvFile.loadedKeys.length} keys applied)`);
  }

  const argv = process.argv.slice(2);

  if (hasHelpFlag(argv)) {
    printHelp();
    return;
  }

  const command: Command = KNOWN_COMMANDS.includes(argv[0] as Command) ? (argv.shift()! as Command) : 'run';
  const runtimeOptions = resolveWorkerRuntimeOptions(process.env);
  const apiKeyArg = resolveCliFlag(argv, '--api-key') ?? trimString(process.env.HOOKCODE_WORKER_API_KEY);
  const backendUrlArg = resolveCliFlag(argv, '--backend-url') ?? trimString(process.env.HOOKCODE_WORKER_BACKEND_URL);

  // --- Simple commands that don't need credentials ---

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'version') {
    console.log(readPackageVersion() || 'unknown');
    return;
  }

  if (command === 'upgrade') {
    const targetVersion = resolveUpgradeTargetArg(argv);
    console.log(`[worker] upgrading via ${buildGlobalInstallCommand(targetVersion)}`);
    await upgradeWorkerPackage(targetVersion);
    console.log(`[worker] upgrade complete. Restart the worker process. Future shortcut: ${buildCliUpgradeCommand(targetVersion)}`);
    return;
  }

  if (command === 'status') {
    showStatus(runtimeOptions.workDirRoot);
    return;
  }

  if (command === 'info') {
    showInfo(runtimeOptions.workDirRoot);
    return;
  }

  if (command === 'unbind') {
    await unbindWorker(runtimeOptions.workDirRoot);
    return;
  }

  // --- Configure with API key ---

  if (command === 'configure') {
    if (!apiKeyArg) {
      throw new Error('HOOKCODE_WORKER_API_KEY or --api-key is required for "hookcode-worker configure".');
    }
    if (!backendUrlArg) {
      throw new Error('HOOKCODE_WORKER_BACKEND_URL or --backend-url is required for "hookcode-worker configure".');
    }
    await configureWorker(backendUrlArg, apiKeyArg, runtimeOptions.workDirRoot);
    console.log(`[worker] configured in ${runtimeOptions.workDirRoot}`);
    return;
  }

  // --- Daemon start ---

  if (command === 'start') {
    startDaemon(runtimeOptions.workDirRoot);
    return;
  }

  if (command === 'stop') {
    await stopDaemon(runtimeOptions.workDirRoot);
    return;
  }

  // --- Foreground run (default) ---

  let credentials = readWorkerCredentials(runtimeOptions.workDirRoot);
  if (apiKeyArg && backendUrlArg && !credentials) {
    credentials = await configureWorker(backendUrlArg, apiKeyArg, runtimeOptions.workDirRoot);
  }

  writePidFile(runtimeOptions.workDirRoot, process.pid);
  const cleanupPid = () => removePidFile(runtimeOptions.workDirRoot);

  const worker = new WorkerProcess(parseWorkerConfig(process.env, credentials, runtimeOptions));

  const gracefulShutdown = async () => {
    console.log('[worker] shutting down…');
    await worker.shutdown();
    cleanupPid();
    process.exit(0);
  };
  process.once('SIGINT', () => void gracefulShutdown());
  process.once('SIGTERM', () => void gracefulShutdown());
  process.once('exit', cleanupPid);

  await worker.start();
};

void main().catch((error) => {
  console.error('[worker] failed to start', error);
  process.exitCode = 1;
});
