import { getWorkerProcessStatus } from '../pidFile';
import { readWorkerCredentials } from '../credentials';

export const showStatus = (workDirRoot: string): void => {
  const { running, pid } = getWorkerProcessStatus(workDirRoot);
  const credentials = readWorkerCredentials(workDirRoot);

  console.log('=== HookCode Worker Status ===\n');

  // Daemon status
  if (running) {
    console.log(`  Daemon:       running (pid ${pid})`);
  } else {
    console.log('  Daemon:       stopped');
  }

  // Bind status
  if (credentials) {
    console.log(`  Bound:        yes`);
    console.log(`  Worker ID:    ${credentials.workerId}`);
    console.log(`  Backend URL:  ${credentials.backendUrl}`);
    console.log(`  Configured:   ${credentials.configuredAt}`);
  } else {
    console.log('  Bound:        no (run "hookcode-worker configure" to bind)');
  }

  console.log(`\n  Work dir:     ${workDirRoot}`);
};
