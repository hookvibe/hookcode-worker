jest.mock('../runtime/crossPlatformSpawn', () => ({
  xSpawnSync: jest.fn()
}));

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { xSpawnSync } from '../runtime/crossPlatformSpawn';
import { detectWorkerRuntimeState, resolveTaskProvidersFromContext } from '../runtime/runtimeDetection';

describe('runtime detection helpers', () => {
  const realPath = process.env.PATH;
  let fakeBinDir = '';

  beforeEach(() => {
    jest.clearAllMocks();
    fakeBinDir = mkdtempSync(path.join(os.tmpdir(), 'hookcode-provider-bin-'));
    for (const command of ['codex', 'claude', 'gemini']) {
      const filePath = path.join(fakeBinDir, command);
      writeFileSync(filePath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(filePath, 0o755);
    }
    process.env.PATH = fakeBinDir;
  });

  afterEach(() => {
    if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env.PATH = realPath;
  });

  test('marks providers available when their global CLI probes succeed', () => {
    (xSpawnSync as jest.Mock).mockImplementation((command: string) => ({
      status: 0,
      stdout: `${command} 1.2.3`,
      stderr: ''
    }));

    const runtimeState = detectWorkerRuntimeState(['codex', 'claude_code']);

    expect(runtimeState.availableProviders).toEqual(['codex', 'claude_code']);
    expect(runtimeState.providerStatuses?.codex?.version).toContain('codex 1.2.3');
    expect(runtimeState.providerStatuses?.claude_code?.command).toBe('claude');
  });

  test('reports probe failures as runtime errors instead of pretending the CLI is ready', () => {
    (xSpawnSync as jest.Mock).mockImplementation(() => ({
      status: 1,
      stdout: '',
      stderr: 'permission denied'
    }));

    const runtimeState = detectWorkerRuntimeState(['codex']);

    expect(runtimeState.availableProviders).toEqual([]);
    expect(runtimeState.providerStatuses?.codex?.status).toBe('error');
    expect(runtimeState.providerStatuses?.codex?.error).toContain('permission denied');
  });

  test('detects available global CLIs', () => {
    (xSpawnSync as jest.Mock).mockImplementation(() => ({
      status: 0,
      stdout: 'codex 1.2.3',
      stderr: ''
    }));

    expect(detectWorkerRuntimeState().availableProviders).toContain('codex');
  });

  test('collects primary and routed providers from task context', () => {
    const providers = resolveTaskProvidersFromContext({
      task: { robotId: 'robot-1' },
      robotsInRepo: [
        {
          id: 'robot-1',
          modelProvider: 'codex',
          modelProviderConfig: {
            routingConfig: [{ provider: 'claude_code' }, { provider: 'gemini_cli' }]
          }
        }
      ]
    });

    expect(providers).toEqual(['codex', 'claude_code', 'gemini_cli']);
  });
});
