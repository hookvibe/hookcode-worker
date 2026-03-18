const WORKER_BIND_CODE_PREFIX = 'hcw1.';

export interface WorkerBindCodePayload {
  workerId: string;
  backendUrl: string;
  secret: string;
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
};

export const parseWorkerBindCode = (bindCode: string): WorkerBindCodePayload | null => {
  const raw = trimString(bindCode);
  if (!raw.startsWith(WORKER_BIND_CODE_PREFIX)) return null;
  try {
    const decoded = JSON.parse(decodeBase64Url(raw.slice(WORKER_BIND_CODE_PREFIX.length))) as {
      v?: unknown;
      workerId?: unknown;
      backendUrl?: unknown;
      secret?: unknown;
    };
    if (Number(decoded?.v) !== 1) return null;
    const workerId = trimString(decoded?.workerId);
    const backendUrl = trimString(decoded?.backendUrl).replace(/\/+$/g, '');
    const secret = trimString(decoded?.secret);
    if (!workerId || !backendUrl || !secret) return null;
    return { workerId, backendUrl, secret };
  } catch {
    return null;
  }
};
