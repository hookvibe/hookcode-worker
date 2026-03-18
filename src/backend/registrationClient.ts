import { parseWorkerBindCode } from '../bindCode';

export interface WorkerRegistrationResponse {
  workerId: string;
  workerToken: string;
  backendUrl: string;
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const registerWorkerBindCode = async (bindCode: string): Promise<WorkerRegistrationResponse> => {
  const parsed = parseWorkerBindCode(bindCode);
  if (!parsed) {
    throw new Error('HOOKCODE_WORKER_BIND_CODE is invalid');
  }

  const response = await fetch(`${parsed.backendUrl.replace(/\/+$/, '')}/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bindCode })
  });

  if (!response.ok) {
    const text = trimString(await response.text().catch(() => ''));
    throw new Error(`Worker registration failed (${response.status} ${response.statusText}): ${text || 'unknown error'}`);
  }

  const data = (await response.json()) as Partial<WorkerRegistrationResponse>;
  const workerId = trimString(data.workerId);
  const workerToken = trimString(data.workerToken);
  const backendUrl = trimString(data.backendUrl).replace(/\/+$/, '');
  if (!workerId || !workerToken || !backendUrl) {
    throw new Error('Worker registration response is invalid');
  }
  return { workerId, workerToken, backendUrl };
};
