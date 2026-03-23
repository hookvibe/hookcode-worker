#!/usr/bin/env node
import { registerWorkerBindCode } from './backend/registrationClient';
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

const parseBoolean = (value: unknown): boolean => {
  const raw = trimString(value).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const resolveBindCodeArg = (argv: string[]): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current !== '--bind-code') continue;
    return trimString(argv[index + 1]) || undefined;
  }
  return undefined;
};

const hasHelpFlag = (argv: string[]): boolean => argv.includes('--help') || argv.includes('-h');

const KNOWN_COMMANDS = ['configure', 'bind', 'run', 'start', 'stop', 'status', 'info', 'unbind', 'version', 'upgrade', 'help'] as const;
type Command = (typeof KNOWN_COMMANDS)[number];

const configureWorker = async (bindCode: string, workDirRoot: string): Promise<WorkerCredentials> => {
  const registered = await registerWorkerBindCode(bindCode);
  const credentials: WorkerCredentials = {
    backendUrl: registered.backendUrl,
    workerId: registered.workerId,
    workerToken: registered.workerToken,
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

  // Global --help flag
  if (hasHelpFlag(argv)) {
    printHelp();
    return;
  }

  const command: Command = KNOWN_COMMANDS.includes(argv[0] as Command) ? (argv.shift()! as Command) : 'run';
  const runtimeOptions = resolveWorkerRuntimeOptions(process.env);
  const bindCode = resolveBindCodeArg(argv) ?? runtimeOptions.bindCode;
  const forceReconfigure = parseBoolean(process.env.HOOKCODE_WORKER_FORCE_RECONFIGURE);

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

  // --- Commands that register / bind ---

  if (command === 'configure' || command === 'bind') {
    if (!bindCode) {
      throw new Error(`HOOKCODE_WORKER_BIND_CODE or --bind-code is required for "hookcode-worker ${command}".`);
    }
    const credentials = await configureWorker(bindCode, runtimeOptions.workDirRoot);
    console.log(`[worker] configured ${credentials.workerId} in ${runtimeOptions.workDirRoot}`);
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
  if (bindCode && (forceReconfigure || !credentials)) {
    credentials = await configureWorker(bindCode, runtimeOptions.workDirRoot);
    console.log(`[worker] registered ${credentials.workerId} from bind code`);
  }

  // Write PID so "hookcode-worker status/stop" can detect this foreground process too.
  writePidFile(runtimeOptions.workDirRoot, process.pid);
  const cleanupPid = () => removePidFile(runtimeOptions.workDirRoot);

  // Start the standalone worker entrypoint so backend-supervised and remote workers share the same protocol client.
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
