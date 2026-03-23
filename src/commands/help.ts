import { readPackageVersion } from '../packageInfo';

const COMMANDS: { name: string; usage: string; description: string }[] = [
  { name: 'run', usage: 'hookcode-worker run', description: 'Start the worker process in the foreground (default command).' },
  { name: 'start', usage: 'hookcode-worker start', description: 'Start the worker as a background daemon.' },
  { name: 'stop', usage: 'hookcode-worker stop', description: 'Stop the background daemon.' },
  { name: 'status', usage: 'hookcode-worker status', description: 'Show whether the worker daemon is running and its bind state.' },
  { name: 'info', usage: 'hookcode-worker info', description: 'Display current configuration and binding details.' },
  { name: 'configure', usage: 'hookcode-worker configure --bind-code <code>', description: 'Register this worker with a HookCode backend using a bind code.' },
  { name: 'unbind', usage: 'hookcode-worker unbind', description: 'Remove stored credentials and unbind from the backend.' },
  { name: 'version', usage: 'hookcode-worker version', description: 'Print the package version.' },
  { name: 'upgrade', usage: 'hookcode-worker upgrade --to <version>', description: 'Upgrade the globally installed worker package.' },
  { name: 'help', usage: 'hookcode-worker help', description: 'Show this help message.' }
];

export const printHelp = (): void => {
  const version = readPackageVersion() || 'unknown';
  console.log(`hookcode-worker v${version}\n`);
  console.log('Usage: hookcode-worker <command> [options]\n');
  console.log('Commands:\n');

  const maxName = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const cmd of COMMANDS) {
    console.log(`  ${cmd.name.padEnd(maxName + 2)}${cmd.description}`);
  }

  console.log('\nOptions:\n');
  console.log('  --bind-code <code>   Provide a bind code for configure/run');
  console.log('  --to <version>       Target version for upgrade');
  console.log('  --help, -h           Show this help message');
  console.log('\nEnvironment variables:\n');
  console.log('  HOOKCODE_WORK_DIR                   Worker storage root (default: ~/.hookcode)');
  console.log('  HOOKCODE_WORKER_BIND_CODE            One-time bind code for registration');
  console.log('  HOOKCODE_WORKER_KIND                 "local" or "remote" (default: local)');
  console.log('  HOOKCODE_WORKER_NAME                 Display name (default: HookCode Worker)');
  console.log('  HOOKCODE_WORKER_MAX_CONCURRENCY      Max parallel tasks');
  console.log('  HOOKCODE_WORKER_HEARTBEAT_MS         Heartbeat interval in ms (default: 10000)');
};
