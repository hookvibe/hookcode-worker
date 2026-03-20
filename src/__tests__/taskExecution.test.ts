// Verify commandless tasks delegate back to backend inline execution without writing conflicting worker log batches. docs/en/developer/plans/worker-executor-refactor-20260307/task_plan.md worker-executor-refactor-20260307
import path from 'path';
import { runTaskExecution } from '../runtime/taskExecution';
import { runRemoteTaskExecution } from '../runtime/remoteTaskExecution';

jest.mock('../runtime/remoteTaskExecution', () => ({
  runRemoteTaskExecution: jest.fn()
}));

describe('runTaskExecution', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('delegates local tasks to backend inline execution when no command is resolved', async () => {
    const client = {
      ensureGroupId: jest.fn().mockResolvedValue({ groupId: 'group-1' }),
      getThreadId: jest.fn().mockResolvedValue({ threadId: null }),
      getTaskGroupHistory: jest.fn().mockResolvedValue({ hasPriorTaskGroupTask: false, hasTaskGroupLogs: false }),
      getTaskGroupSkills: jest.fn().mockResolvedValue({ selection: null }),
      getPromptPrefix: jest.fn().mockResolvedValue({ promptPrefix: '' }),
      executeInlineTask: jest.fn().mockResolvedValue({ success: true }),
      appendLogs: jest.fn().mockResolvedValue({ success: true })
    };

    const result = await runTaskExecution({
      client: client as any,
      config: {
        backendUrl: 'http://127.0.0.1:4020/api',
        wsUrl: 'ws://127.0.0.1:4020/api/workers/connect?workerId=worker-1&token=secret',
        workerId: 'worker-1',
        workerToken: 'secret',
        workerName: 'Local Worker',
        workerKind: 'local',
        preview: true,
        heartbeatIntervalMs: 10_000,
        maxConcurrency: 1,
        runtimeInstallDir: path.resolve('/tmp', 'hookcode-runtime'),
        workspaceRootDir: path.resolve('/tmp', 'hookcode-workspaces'),
        reconnectMinMs: 100,
        reconnectMaxMs: 1_000,
        controlPollIntervalMs: 2_000,
        cancelKillTimeoutMs: 5_000,
        noopOnMissingCommand: false
      },
      context: {
        task: {
          id: 'task-1',
          taskGroupId: 'group-1',
          repoId: 'repo-1'
        }
      },
      taskId: 'task-1',
      signal: new AbortController().signal
    });

    expect(result).toEqual({ handledByBackend: true });
    expect(client.executeInlineTask).toHaveBeenCalledWith('task-1', 'missing_command');
    expect(client.appendLogs).not.toHaveBeenCalled();
    expect(runRemoteTaskExecution).not.toHaveBeenCalled();
  });

  test('delegates remote tasks to remote-native execution when no command is resolved', async () => {
    const client = {
      ensureGroupId: jest.fn().mockResolvedValue({ groupId: 'group-1' }),
      getThreadId: jest.fn().mockResolvedValue({ threadId: null }),
      getTaskGroupHistory: jest.fn().mockResolvedValue({ hasPriorTaskGroupTask: false, hasTaskGroupLogs: false }),
      getTaskGroupSkills: jest.fn().mockResolvedValue({ selection: null }),
      getPromptPrefix: jest.fn().mockResolvedValue({ promptPrefix: '' }),
      executeInlineTask: jest.fn().mockResolvedValue({ success: true }),
      appendLogs: jest.fn().mockResolvedValue({ success: true })
    };
    (runRemoteTaskExecution as jest.Mock).mockResolvedValue({ outputText: 'remote-ok' });

    const result = await runTaskExecution({
      client: client as any,
      config: {
        backendUrl: 'http://127.0.0.1:4020/api',
        wsUrl: 'ws://127.0.0.1:4020/api/workers/connect?workerId=worker-1&token=secret',
        workerId: 'worker-1',
        workerToken: 'secret',
        workerName: 'Remote Worker',
        workerKind: 'remote',
        preview: true,
        heartbeatIntervalMs: 10_000,
        maxConcurrency: 1,
        runtimeInstallDir: path.resolve('/tmp', 'hookcode-runtime'),
        workspaceRootDir: path.resolve('/tmp', 'hookcode-workspaces'),
        reconnectMinMs: 100,
        reconnectMaxMs: 1_000,
        controlPollIntervalMs: 2_000,
        cancelKillTimeoutMs: 5_000,
        noopOnMissingCommand: false
      },
      context: {
        task: {
          id: 'task-1',
          taskGroupId: 'group-1',
          repoId: 'repo-1'
        }
      },
      taskId: 'task-1',
      signal: new AbortController().signal
    });

    expect(result).toEqual({ outputText: 'remote-ok' });
    expect(runRemoteTaskExecution).toHaveBeenCalledTimes(1);
    expect(client.executeInlineTask).not.toHaveBeenCalled();
  });
});
