import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildWorkerWsUrl, parseWorkerConfig, resolveWorkerRuntimeOptions } from '../config';
import { writeWorkerCredentials } from '../credentials';

describe('worker config', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  const createWorkDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hookcode-worker-config-'));
    tempDirs.push(dir);
    return dir;
  };

  test('parses persisted worker credentials and normalizes backend url', () => {
    const workDir = createWorkDir();
    writeWorkerCredentials(workDir, {
      backendUrl: 'https://example.com/api/',
      workerId: 'worker-1',
      workerToken: 'secret',
      configuredAt: new Date().toISOString()
    });

    const config = parseWorkerConfig({
      HOOKCODE_WORK_DIR: workDir,
      HOOKCODE_WORKER_KIND: 'remote',
      HOOKCODE_WORKER_NAME: 'Remote A',
      HOOKCODE_WORKER_MAX_CONCURRENCY: '3'
    });

    expect(config.backendUrl).toBe('https://example.com/api');
    expect(config.workerKind).toBe('remote');
    expect(config.maxConcurrency).toBe(3);
    expect(config.runtimeInstallDir).toBe(path.join(workDir, 'runtime'));
  });

  test('builds websocket url from backend api url', () => {
    expect(buildWorkerWsUrl('https://example.com/api', 'worker-1', 'token')).toBe(
      'wss://example.com/api/workers/connect?workerId=worker-1&token=token'
    );
  });

  test('uses noop and unified work dir defaults', () => {
    const workDir = createWorkDir();
    writeWorkerCredentials(workDir, {
      backendUrl: 'http://localhost:3000/api',
      workerId: 'worker-1',
      workerToken: 'secret',
      configuredAt: new Date().toISOString()
    });

    const config = parseWorkerConfig({
      HOOKCODE_WORK_DIR: workDir,
      HOOKCODE_WORKER_NOOP_ON_MISSING_COMMAND: 'true'
    });

    expect(config.noopOnMissingCommand).toBe(true);
    expect(config.runtimeInstallDir).toBe(path.join(workDir, 'runtime'));
    expect(config.workspaceRootDir).toBe(path.join(workDir, 'workspaces'));
  });

  test('resolves bind code and work dir from env', () => {
    const workDir = createWorkDir();
    const options = resolveWorkerRuntimeOptions({
      HOOKCODE_WORK_DIR: workDir,
      HOOKCODE_WORKER_BIND_CODE: 'hcw1.bind-code'
    });

    expect(options.workDirRoot).toBe(workDir);
    expect(options.bindCode).toBe('hcw1.bind-code');
  });
});
