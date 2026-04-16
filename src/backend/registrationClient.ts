import { isValidApiKey } from '../bindCode';

export interface WorkerVerifyResponse {
  workerId: string;
  workerName: string;
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Verify an API key against the backend and return worker info.
 */
export const verifyWorkerApiKey = async (backendUrl: string, apiKey: string): Promise<WorkerVerifyResponse> => {
  if (!isValidApiKey(apiKey)) {
    throw new Error('Invalid API key format. API keys must start with "hkw_".');
  }

  const url = `${backendUrl.replace(/\/+$/, '')}/workers/internal/heartbeat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ activeTaskIds: [] })
  });

  if (!response.ok) {
    const text = trimString(await response.text().catch(() => ''));
    throw new Error(`API key verification failed (${response.status} ${response.statusText}): ${text || 'unknown error'}`);
  }

  const data = (await response.json()) as { ok?: boolean; workerId?: string; workerName?: string };
  if (!data.ok) {
    throw new Error('API key verification failed: server returned not ok');
  }
  return {
    workerId: trimString(data.workerId) || 'unknown',
    workerName: trimString(data.workerName) || 'HookCode Worker'
  };
};
