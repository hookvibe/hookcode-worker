import { spawn } from 'child_process';
import { WORKER_PACKAGE_NAME, normalizeTargetVersion, resolveNpmExecutable } from './packageInfo';

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const resolveUpgradeTargetArg = (argv: string[]): string => {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current !== '--to') continue;
    return normalizeTargetVersion(argv[index + 1]);
  }
  return 'latest';
};

export const upgradeWorkerPackage = async (targetVersion: string): Promise<void> => {
  const normalizedTarget = normalizeTargetVersion(targetVersion);
  const packageSpec = `${WORKER_PACKAGE_NAME}@${normalizedTarget}`;
  const npmExecutable = resolveNpmExecutable();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmExecutable, ['install', '-g', packageSpec], {
      stdio: 'inherit',
      env: process.env
    });

    child.once('error', (error) => {
      reject(new Error(`[worker] failed to start npm for upgrade: ${trimString(error.message) || String(error)}`));
    });

    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[worker] upgrade failed with exit code ${code ?? 'unknown'}`));
    });
  });
};
