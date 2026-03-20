type AsyncLogItem = { line: string; important: boolean };

export const createAsyncLineLogger = (params: {
  logLine?: (line: string) => Promise<void>;
  redact?: (text: string) => string;
  maxQueueSize?: number;
}) => {
  const maxQueueSize = typeof params.maxQueueSize === 'number' && params.maxQueueSize > 0 ? params.maxQueueSize : 200;
  const queue: AsyncLogItem[] = [];
  let pumpPromise: Promise<void> | null = null;

  const pump = async () => {
    if (!params.logLine) return;
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        await params.logLine(item.line);
      } catch (error) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[providerRuntime] logLine failed (ignored)', { error });
        }
      }
    }
  };

  const ensurePump = () => {
    if (!params.logLine || pumpPromise) return;
    pumpPromise = pump().finally(() => {
      pumpPromise = null;
      if (queue.length > 0) ensurePump();
    });
  };

  const enqueue = (line: string, opts?: { important?: boolean }) => {
    if (!params.logLine) return;
    const rawLine = String(line ?? '');
    const safeLine = params.redact ? params.redact(rawLine) : rawLine;
    const important = Boolean(opts?.important);

    if (queue.length >= maxQueueSize) {
      const dropIndex = queue.findIndex((item) => !item.important);
      if (dropIndex >= 0) queue.splice(dropIndex, 1);
      else queue.shift();
    }

    queue.push({ line: safeLine, important });
    ensurePump();
  };

  const flushBestEffort = async (timeoutMs: number) => {
    if (!params.logLine) return;
    if (!pumpPromise && queue.length === 0) return;
    const wait = pumpPromise ?? Promise.resolve();
    await Promise.race([wait, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  };

  return { enqueue, flushBestEffort };
};

export const buildMergedProcessEnv = (overrides?: Record<string, string | undefined>): Record<string, string> | undefined => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'string') env[key] = value;
    }
  }

  const gitHttpProxy = (process.env.GIT_HTTP_PROXY ?? '').trim();
  if (gitHttpProxy) {
    env.http_proxy = gitHttpProxy;
    env.https_proxy = gitHttpProxy;
    env.HTTP_PROXY = gitHttpProxy;
    env.HTTPS_PROXY = gitHttpProxy;
  }

  return Object.keys(env).length > 0 ? env : undefined;
};

export const normalizeHttpBaseUrl = (raw: unknown): string | undefined => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || /\s/.test(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
};
