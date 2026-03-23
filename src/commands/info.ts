import { readWorkerCredentials } from '../credentials';
import { resolveWorkerRuntimeOptions, parseWorkerConfig } from '../config';
import { readPackageVersion } from '../packageInfo';
import { resolvePreparedProviders } from '../runtime/prepareRuntime';
import { getWorkerProcessStatus } from '../pidFile';

export const showInfo = (workDirRoot: string): void => {
  const version = readPackageVersion() || 'unknown';
  const credentials = readWorkerCredentials(workDirRoot);
  const { running, pid } = getWorkerProcessStatus(workDirRoot);

  console.log('=== HookCode Worker Info ===\n');
  console.log(`  Version:          ${version}`);
  console.log(`  Platform:         ${process.platform} / ${process.arch}`);
  console.log(`  Node.js:          ${process.version}`);
  console.log(`  Work dir:         ${workDirRoot}`);

  if (running) {
    console.log(`  Daemon:           running (pid ${pid})`);
  } else {
    console.log('  Daemon:           stopped');
  }

  console.log('');
  if (!credentials) {
    console.log('  Bind status:      not bound');
    console.log('  Run "hookcode-worker configure --bind-code <code>" to bind.\n');
    return;
  }

  console.log(`  Bind status:      bound`);
  console.log(`  Worker ID:        ${credentials.workerId}`);
  console.log(`  Backend URL:      ${credentials.backendUrl}`);
  console.log(`  Configured at:    ${credentials.configuredAt}`);

  try {
    const runtimeOptions = resolveWorkerRuntimeOptions(process.env);
    const config = parseWorkerConfig(process.env, credentials, runtimeOptions);
    console.log(`  Worker kind:      ${config.workerKind}`);
    console.log(`  Worker name:      ${config.workerName}`);
    console.log(`  Max concurrency:  ${config.maxConcurrency}`);
    console.log(`  Heartbeat:        ${config.heartbeatIntervalMs}ms`);
    console.log(`  Runtime dir:      ${config.runtimeInstallDir}`);
    console.log(`  Workspace dir:    ${config.workspaceRootDir}`);
  } catch {
    // Config parsing may fail if env is incomplete — that's fine for info display.
  }

  const prepared = resolvePreparedProviders();
  console.log(`  Providers ready:  ${prepared.length > 0 ? prepared.join(', ') : 'none'}`);
  console.log('');
};
