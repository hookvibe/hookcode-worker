import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

export interface WorkerCredentials {
  backendUrl: string;
  workerId: string;
  workerToken: string;
  configuredAt: string;
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const resolveWorkerCredentialFile = (workDirRoot: string): string => path.join(workDirRoot, 'worker-credentials.json');

export const readWorkerCredentials = (workDirRoot: string): WorkerCredentials | null => {
  const filePath = resolveWorkerCredentialFile(workDirRoot);
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<WorkerCredentials>;
    const backendUrl = trimString(parsed.backendUrl).replace(/\/+$/, '');
    const workerId = trimString(parsed.workerId);
    const workerToken = trimString(parsed.workerToken);
    const configuredAt = trimString(parsed.configuredAt) || new Date().toISOString();
    if (!backendUrl || !workerId || !workerToken) return null;
    return { backendUrl, workerId, workerToken, configuredAt };
  } catch {
    return null;
  }
};

export const writeWorkerCredentials = (workDirRoot: string, credentials: WorkerCredentials): string => {
  mkdirSync(workDirRoot, { recursive: true });
  const filePath = resolveWorkerCredentialFile(workDirRoot);
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(credentials, null, 2), 'utf8');
  renameSync(tempPath, filePath);
  return filePath;
};

export const clearWorkerCredentials = (workDirRoot: string): void => {
  rmSync(resolveWorkerCredentialFile(workDirRoot), { force: true });
};
