#!/usr/bin/env node
import { registerWorkerBindCode } from './backend/registrationClient';
import { parseWorkerConfig, resolveWorkerRuntimeOptions } from './config';
import { readWorkerCredentials, writeWorkerCredentials, type WorkerCredentials } from './credentials';
import { WorkerProcess } from './workerProcess';

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
  const argv = process.argv.slice(2);
  const command = argv[0] === 'configure' || argv[0] === 'run' ? argv.shift()! : 'run';
  const runtimeOptions = resolveWorkerRuntimeOptions(process.env);
  const bindCode = resolveBindCodeArg(argv) ?? runtimeOptions.bindCode;
  const forceReconfigure = parseBoolean(process.env.HOOKCODE_WORKER_FORCE_RECONFIGURE);

  if (command === 'configure') {
    if (!bindCode) {
      throw new Error('HOOKCODE_WORKER_BIND_CODE is required for "hookcode-worker configure".');
    }
    const credentials = await configureWorker(bindCode, runtimeOptions.workDirRoot);
    console.log(`[worker] configured ${credentials.workerId} in ${runtimeOptions.workDirRoot}`);
    return;
  }

  let credentials = readWorkerCredentials(runtimeOptions.workDirRoot);
  if (bindCode && (forceReconfigure || !credentials)) {
    credentials = await configureWorker(bindCode, runtimeOptions.workDirRoot);
    console.log(`[worker] registered ${credentials.workerId} from bind code`);
  }

  // Start the standalone worker entrypoint so backend-supervised and remote workers share the same protocol client.
  const worker = new WorkerProcess(parseWorkerConfig(process.env, credentials, runtimeOptions));
  await worker.start();
};

void main().catch((error) => {
  console.error('[worker] failed to start', error);
  process.exitCode = 1;
});
