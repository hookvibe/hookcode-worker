import { existsSync, readFileSync } from 'fs';
import path from 'path';

const DEFAULT_ENV_FILE_CANDIDATES = ['.env.worker.local', '.env.worker'];

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const stripInlineComment = (value: string): string => {
  let quotedBy: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const previous = index > 0 ? value[index - 1] : '';

    if (quotedBy) {
      if (current === quotedBy && previous !== '\\') quotedBy = null;
      continue;
    }

    if (current === '"' || current === "'") {
      quotedBy = current;
      continue;
    }

    if (current === '#' && (index === 0 || /\s/.test(previous))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
};

const decodeQuotedValue = (raw: string): string => {
  if (raw.length < 2) return raw;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return stripInlineComment(raw).trim();
  }

  const body = raw.slice(1, -1);
  if (quote === "'") return body;

  return body
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
};

export const parseWorkerEnvFileContents = (raw: string): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const originalLine of String(raw ?? '').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(normalized);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2] ?? '';
    env[key] = decodeQuotedValue(rawValue.trim());
  }

  return env;
};

export const resolveWorkerEnvFilePath = (cwd: string, rawPath?: string): string | null => {
  const explicit = trimString(rawPath);
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
  }

  for (const candidate of DEFAULT_ENV_FILE_CANDIDATES) {
    const resolved = path.resolve(cwd, candidate);
    if (existsSync(resolved)) return resolved;
  }

  return null;
};

export const loadWorkerEnvFile = (params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  rawPath?: string;
}): { path: string; loadedKeys: string[] } | null => {
  const cwd = params?.cwd ?? process.cwd();
  const env = params?.env ?? process.env;
  const rawPath = trimString(params?.rawPath ?? env.HOOKCODE_ENV_FILE);
  const resolvedPath = resolveWorkerEnvFilePath(cwd, rawPath);

  if (!resolvedPath) return null;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Worker env file not found: ${resolvedPath}`);
  }

  const parsed = parseWorkerEnvFileContents(readFileSync(resolvedPath, 'utf8'));
  const loadedKeys: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof env[key] === 'string') continue;
    env[key] = value;
    loadedKeys.push(key);
  }

  return { path: resolvedPath, loadedKeys };
};
