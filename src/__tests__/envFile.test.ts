import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { loadWorkerEnvFile, parseWorkerEnvFileContents, resolveWorkerEnvFilePath } from '../envFile';

describe('envFile', () => {
  test('parses worker env file values with quotes, comments, and export prefix', () => {
    const parsed = parseWorkerEnvFileContents(`
# comment
HOOKCODE_WORKER_KIND=remote
export HOOKCODE_WORKER_NAME="Local Dev Worker"
HOOKCODE_WORK_DIR=./tmp/worker # inline comment
HOOKCODE_WORKER_BIND_CODE='hcw1.example'
`);

    expect(parsed).toEqual({
      HOOKCODE_WORKER_KIND: 'remote',
      HOOKCODE_WORKER_NAME: 'Local Dev Worker',
      HOOKCODE_WORK_DIR: './tmp/worker',
      HOOKCODE_WORKER_BIND_CODE: 'hcw1.example'
    });
  });

  test('prefers .env.worker.local over .env.worker when auto-discovering files', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'hookcode-worker-env-'));
    try {
      writeFileSync(path.join(cwd, '.env.worker'), 'HOOKCODE_WORKER_NAME=base\n', 'utf8');
      writeFileSync(path.join(cwd, '.env.worker.local'), 'HOOKCODE_WORKER_NAME=local\n', 'utf8');

      expect(resolveWorkerEnvFilePath(cwd)).toBe(path.join(cwd, '.env.worker.local'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('loads env file values without overriding explicit process env', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'hookcode-worker-env-'));
    try {
      const envFile = path.join(cwd, '.env.worker');
      writeFileSync(
        envFile,
        ['HOOKCODE_WORKER_KIND=remote', 'HOOKCODE_WORKER_NAME=FromFile', 'HOOKCODE_WORKER_MAX_CONCURRENCY=1'].join('\n'),
        'utf8'
      );

      const env: NodeJS.ProcessEnv = {
        HOOKCODE_WORKER_NAME: 'FromEnv'
      };

      const loaded = loadWorkerEnvFile({ cwd, env });
      expect(loaded?.path).toBe(envFile);
      expect(env.HOOKCODE_WORKER_KIND).toBe('remote');
      expect(env.HOOKCODE_WORKER_NAME).toBe('FromEnv');
      expect(env.HOOKCODE_WORKER_MAX_CONCURRENCY).toBe('1');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
