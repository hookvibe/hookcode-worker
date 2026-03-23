import { getWorkerProcessStatus, removePidFile } from '../pidFile';

const KILL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const stopDaemon = async (workDirRoot: string): Promise<void> => {
  const { running, pid } = getWorkerProcessStatus(workDirRoot);
  if (!running || pid === null) {
    console.log('[worker] no running daemon found.');
    return;
  }

  console.log(`[worker] sending SIGTERM to pid ${pid}…`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.log('[worker] process already exited.');
    removePidFile(workDirRoot);
    return;
  }

  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      process.kill(pid, 0);
    } catch {
      // Process exited.
      removePidFile(workDirRoot);
      console.log('[worker] daemon stopped.');
      return;
    }
  }

  console.log(`[worker] pid ${pid} did not exit in ${KILL_TIMEOUT_MS}ms, sending SIGKILL…`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead.
  }
  removePidFile(workDirRoot);
  console.log('[worker] daemon killed.');
};
