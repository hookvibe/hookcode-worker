import { clearWorkerCredentials, readWorkerCredentials } from '../credentials';
import { getWorkerProcessStatus, removePidFile } from '../pidFile';

const KILL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export const unbindWorker = async (workDirRoot: string): Promise<void> => {
  const credentials = readWorkerCredentials(workDirRoot);
  if (!credentials) {
    console.log('[worker] not bound — nothing to unbind.');
    return;
  }

  // Stop running daemon first, waiting for graceful exit.
  const { running, pid } = getWorkerProcessStatus(workDirRoot);
  if (running && pid !== null) {
    console.log(`[worker] stopping running daemon (pid ${pid})…`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }

    const deadline = Date.now() + KILL_TIMEOUT_MS;
    while (Date.now() < deadline && isAlive(pid)) {
      await sleep(POLL_INTERVAL_MS);
    }
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    removePidFile(workDirRoot);
  }

  clearWorkerCredentials(workDirRoot);
  console.log(`[worker] unbound worker ${credentials.workerId} from ${credentials.backendUrl}.`);
  console.log('[worker] credentials removed. The backend will mark this worker offline after heartbeat timeout.');
};
