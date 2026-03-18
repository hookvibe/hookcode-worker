import { readFileSync } from 'fs';
import path from 'path';

export const WORKER_PACKAGE_NAME = '@hookvibe/hookcode-worker';
export const WORKER_DOCKER_IMAGE = 'ghcr.io/hookvibe/hookcode-worker';

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const normalizeTargetVersion = (value: unknown): string => trimString(value) || 'latest';

export const readPackageVersion = (): string | undefined => {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
    const raw = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return typeof raw.version === 'string' ? raw.version : undefined;
  } catch {
    return undefined;
  }
};

export const buildGlobalInstallCommand = (version: string): string => `npm install -g ${WORKER_PACKAGE_NAME}@${normalizeTargetVersion(version)}`;

export const buildCliUpgradeCommand = (version: string): string => `hookcode-worker upgrade --to ${normalizeTargetVersion(version)}`;

export const resolveNpmExecutable = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? 'npm.cmd' : 'npm');
