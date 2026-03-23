import { spawn } from 'child_process';
import { openSync, closeSync, mkdirSync } from 'fs';
import path from 'path';
import { getWorkerProcessStatus, writePidFile } from '../pidFile';

export const startDaemon = (workDirRoot: string): void => {
  const { running, pid } = getWorkerProcessStatus(workDirRoot);
  if (running) {
    console.log(`[worker] already running (pid ${pid}).`);
    return;
  }

  mkdirSync(workDirRoot, { recursive: true });
  const logPath = path.join(workDirRoot, 'worker.log');
  const logFd = openSync(logPath, 'a');

  let child;
  try {
    child = spawn(process.execPath, [process.argv[1], 'run'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env
    });
  } finally {
    // Close the fd in the parent — the child process has its own copy.
    closeSync(logFd);
  }

  if (!child.pid) {
    console.error('[worker] failed to start daemon.');
    process.exitCode = 1;
    return;
  }

  writePidFile(workDirRoot, child.pid);
  child.unref();
  console.log(`[worker] daemon started (pid ${child.pid}). Logs: ${logPath}`);
};
