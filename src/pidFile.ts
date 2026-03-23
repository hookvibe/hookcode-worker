import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';

const PID_FILE_NAME = 'worker.pid';

export const resolvePidFilePath = (workDirRoot: string): string => path.join(workDirRoot, PID_FILE_NAME);

export const writePidFile = (workDirRoot: string, pid: number): void => {
  mkdirSync(workDirRoot, { recursive: true });
  writeFileSync(resolvePidFilePath(workDirRoot), String(pid), 'utf8');
};

export const readPidFile = (workDirRoot: string): number | null => {
  try {
    const raw = readFileSync(resolvePidFilePath(workDirRoot), 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const removePidFile = (workDirRoot: string): void => {
  try {
    unlinkSync(resolvePidFilePath(workDirRoot));
  } catch {
    // Ignore — file may already be absent.
  }
};

export const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type WorkerProcessStatus = {
  running: boolean;
  pid: number | null;
};

export const getWorkerProcessStatus = (workDirRoot: string): WorkerProcessStatus => {
  const pid = readPidFile(workDirRoot);
  if (pid === null) return { running: false, pid: null };
  const running = isProcessRunning(pid);
  if (!running) {
    removePidFile(workDirRoot);
    return { running: false, pid: null };
  }
  return { running: true, pid };
};
