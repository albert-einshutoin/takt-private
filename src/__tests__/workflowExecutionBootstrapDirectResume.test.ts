import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

const {
  mockWriteFileAtomic,
  mockResolveWorkflowConfigValues,
  mockCreateOutputFns,
  mockInitializeOtelFoundation,
  mockEnsureWorktreeTaktGitignore,
  mockGenerateReportDir,
  mockCreateProviderEventLogger,
  mockInitNdjsonLog,
} = vi.hoisted(() => ({
  mockWriteFileAtomic: vi.fn(),
  mockResolveWorkflowConfigValues: vi.fn(),
  mockCreateOutputFns: vi.fn(),
  mockInitializeOtelFoundation: vi.fn(),
  mockEnsureWorktreeTaktGitignore: vi.fn(),
  mockGenerateReportDir: vi.fn(() => 'generated-run'),
  mockCreateProviderEventLogger: vi.fn(() => ({
    wrapCallback: (handler: unknown) => handler,
  })),
  mockInitNdjsonLog: vi.fn(
    () => '/project/.takt/runs/direct-resume/logs/session.ndjson',
  ),
}));

vi.mock('../infra/config/index.js', () => ({
  ensureDir: vi.fn(),
  loadPersonaSessions: vi.fn(() => ({})),
  loadWorktreeSessions: vi.fn(() => ({})),
  resolveWorkflowConfigValues: mockResolveWorkflowConfigValues,
  updatePersonaSession: vi.fn(),
  updateWorktreeSession: vi.fn(),
  writeFileAtomic: mockWriteFileAtomic,
}));

vi.mock('../features/tasks/execute/runMetaStorage.js', () => ({
  writeRunMetaFileDurably: mockWriteFileAtomic,
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValueWithSource: vi.fn(() => ({ value: 'mock', source: 'global' })),
  resolveProviderOptionsWithTrace: vi.fn(() => ({
    value: undefined,
    source: 'default',
    originResolver: undefined,
  })),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/.takt'),
}));

vi.mock('../infra/fs/index.js', () => ({
  createSessionLog: vi.fn(() => ({ history: [] })),
  generateSessionId: vi.fn(() => 'session-1'),
  initNdjsonLog: mockInitNdjsonLog,
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../shared/ui/index.js', () => ({
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/ui/TaskPrefixWriter.js', () => ({
  TaskPrefixWriter: vi.fn().mockImplementation(() => ({
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
  generateReportDir: mockGenerateReportDir,
  getDebugPromptsLogFile: vi.fn(() => undefined),
  isValidReportDirName: vi.fn(() => true),
  preventSleep: vi.fn(),
}));

vi.mock('../shared/utils/providerEventLogger.js', () => ({
  createProviderEventLogger: mockCreateProviderEventLogger,
  isProviderEventsEnabled: vi.fn(() => false),
}));

vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn(() => ({})),
  isUsageEventsEnabled: vi.fn(() => false),
}));

vi.mock('../infra/observability/otelFoundation.js', () => ({
  initializeOtelFoundation: mockInitializeOtelFoundation,
}));

vi.mock('../infra/task/projectLocalTaktSync.js', () => ({
  ensureWorktreeTaktGitignore: mockEnsureWorktreeTaktGitignore,
}));

vi.mock('../features/analytics/index.js', () => ({
  initAnalyticsWriter: vi.fn(),
}));

vi.mock('../features/tasks/execute/analyticsEmitter.js', () => ({
  AnalyticsEmitter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../agents/structured-caller.js', () => ({
  CapabilityAwareStructuredCaller: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../features/tasks/execute/outputFns.js', () => ({
  createOutputFns: mockCreateOutputFns,
  createPrefixedStreamHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/traceReportWriter.js', () => ({
  createTraceReportWriter: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/sessionLogger.js', () => ({
  SessionLogger: vi.fn().mockImplementation(() => ({
    writeInteractiveMetadata: vi.fn(),
  })),
}));

vi.mock('../core/runtime/runtime-environment.js', () => ({
  resolveRuntimeConfig: vi.fn(() => undefined),
}));

import { createWorkflowExecutionBootstrap } from '../features/tasks/execute/workflowExecutionBootstrap.js';

const workflowConfig: WorkflowConfig = {
  name: 'default',
  initialStep: 'fix',
  maxSteps: 50,
  steps: [
    { name: 'fix', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
  ],
};

const temporaryDirs: string[] = [];

function createTempProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-direct-resume-'));
  temporaryDirs.push(projectDir);
  return projectDir;
}

function hasTasksYamlWrite(): boolean {
  return mockWriteFileAtomic.mock.calls.some((call) => String(call[0]).endsWith('/.takt/tasks.yaml'));
}

describe('createWorkflowExecutionBootstrap direct resume metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateOutputFns.mockReturnValue({
      header: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      blankLine: vi.fn(),
      result: vi.fn(),
    });
    mockInitializeOtelFoundation.mockResolvedValue({ shutdown: vi.fn() });
    mockInitNdjsonLog.mockReturnValue(
      '/project/.takt/runs/direct-resume/logs/session.ndjson',
    );
    mockWriteFileAtomic.mockImplementation(() => undefined);
    mockCreateProviderEventLogger.mockReturnValue({
      wrapCallback: (handler: unknown) => handler,
    });
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
      timezone: undefined,
    });
  });

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Given directResume is passed, When bootstrap creates run meta, Then source metadata is persisted in meta.json', async () => {
    const projectDir = createTempProject();
    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      directResume: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'retry',
      },
    });

    const metaWrite = mockWriteFileAtomic.mock.calls.find((call) =>
      String(call[0]).endsWith('/.takt/runs/direct-resume/meta.json')
    );
    expect(metaWrite).toBeDefined();
    const meta = JSON.parse(String(metaWrite![1])) as {
      source_run_slug?: string;
      resume_mode?: string;
    };
    expect(meta.source_run_slug).toBe('20260524-source-run');
    expect(meta.resume_mode).toBe('retry');
  });

  it('rejects blank direct or CLI task text before publishing run metadata', async () => {
    const projectDir = createTempProject();

    await expect(createWorkflowExecutionBootstrap(
      workflowConfig,
      ' \n\t ',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
        reportDirName: 'blank-task',
      },
    )).rejects.toThrow('Run metadata task must contain non-whitespace text');
    expect(mockWriteFileAtomic.mock.calls.some(
      (call) => String(call[0]).endsWith('/meta.json'),
    )).toBe(false);
  });

  it('Given timezone is configured, When bootstrap creates a generated run slug, Then timezone is passed to report dir generation', async () => {
    const projectDir = createTempProject();
    mockResolveWorkflowConfigValues.mockReturnValueOnce({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
      timezone: 'Asia/Tokyo',
    });

    await createWorkflowExecutionBootstrap(workflowConfig, 'Timezone run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
    });

    expect(mockGenerateReportDir).toHaveBeenCalledWith('Timezone run', { timezone: 'Asia/Tokyo' });
  });

  it('Given no tasks.yaml exists, When direct resume bootstrap runs, Then tasks.yaml is not created', async () => {
    const projectDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      directResume: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'requeue',
      },
    });

    expect(existsSync(join(projectDir, '.takt', 'tasks.yaml'))).toBe(false);
    expect(hasTasksYamlWrite()).toBe(false);
  });

  it('Given tasks.yaml already exists, When direct resume bootstrap runs, Then tasks.yaml remains unchanged', async () => {
    const projectDir = createTempProject();
    const tasksDir = join(projectDir, '.takt');
    const tasksPath = join(tasksDir, 'tasks.yaml');
    const initialTasks = 'tasks:\n  - name: keep-existing\n    status: pending\n';
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(tasksPath, initialTasks, 'utf-8');

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      directResume: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'instruct',
      },
    });

    expect(readFileSync(tasksPath, 'utf-8')).toBe(initialTasks);
    expect(hasTasksYamlWrite()).toBe(false);
  });

  it('Given cwd differs from projectCwd, When bootstrap runs, Then worktree .takt/.gitignore is ensured', async () => {
    const projectDir = createTempProject();
    const worktreeDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run in worktree', worktreeDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'worktree-run',
    });

    expect(mockEnsureWorktreeTaktGitignore).toHaveBeenCalledTimes(1);
    expect(mockEnsureWorktreeTaktGitignore).toHaveBeenCalledWith(worktreeDir);
  });

  it('Given cwd equals projectCwd, When bootstrap runs, Then worktree .takt/.gitignore is not ensured', async () => {
    const projectDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run in project', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'project-run',
    });

    expect(mockEnsureWorktreeTaktGitignore).not.toHaveBeenCalled();
  });

  it.each(['provider', 'ndjson-log', 'provider-log', 'otel'] as const)(
    'terminalizes published run metadata when %s bootstrap fails',
    async (failure) => {
      const projectDir = createTempProject();
      if (failure === 'provider') {
        mockResolveWorkflowConfigValues.mockReturnValueOnce({
          notificationSound: false,
          notificationSoundEvents: {},
          rateLimitFallback: undefined,
          runtime: undefined,
          preventSleep: false,
          logging: {},
          analytics: { enabled: false },
          observability: {},
          timezone: undefined,
        });
      } else if (failure === 'ndjson-log') {
        mockInitNdjsonLog.mockImplementationOnce(() => {
          throw new Error('ndjson log initialization failed');
        });
      } else if (failure === 'provider-log') {
        mockCreateProviderEventLogger.mockImplementationOnce(() => {
          throw new Error('provider log initialization failed');
        });
      } else {
        mockInitializeOtelFoundation.mockRejectedValueOnce(
          new Error('otel initialization failed'),
        );
      }

      await expect(createWorkflowExecutionBootstrap(
        workflowConfig,
        'Bootstrap failure',
        projectDir,
        {
          projectCwd: projectDir,
          ...(failure === 'provider' ? {} : { provider: 'mock' as const }),
          reportDirName: `bootstrap-${failure}`,
        },
      )).rejects.toThrow();

      const metaWrites = mockWriteFileAtomic.mock.calls
        .filter((call) => String(call[0]).endsWith('/meta.json'))
        .map((call) => JSON.parse(String(call[1])) as {
          status: string;
          failureReason?: string;
        });
      expect(metaWrites[0]?.status).toBe('running');
      expect(metaWrites.at(-1)).toMatchObject({
        status: 'aborted',
        failureReason: expect.stringContaining('workflow bootstrap failed:'),
      });
    },
  );

  it('preserves running evidence when bootstrap terminalization fails', async () => {
    const projectDir = createTempProject();
    mockInitializeOtelFoundation.mockRejectedValueOnce(
      new Error('otel initialization failed'),
    );
    let metaWrites = 0;
    mockWriteFileAtomic.mockImplementation((path) => {
      if (!String(path).endsWith('/meta.json')) return;
      metaWrites += 1;
      if (metaWrites === 2) throw new Error('terminal meta fsync failed');
    });

    const failure = createWorkflowExecutionBootstrap(
      workflowConfig,
      'Bootstrap terminalization failure',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
        reportDirName: 'bootstrap-terminal-failure',
      },
    );

    await expect(failure).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'otel initialization failed' }),
        expect.objectContaining({ message: 'terminal meta fsync failed' }),
      ],
    });
    expect(metaWrites).toBe(2);
  });

  it.each([false, true])(
    'terminalizes onRunningEvidencePublished failure when terminal write failure is %s',
    async (terminalWriteFails) => {
      const projectDir = createTempProject();
      const callbackError = new Error('running evidence handoff failed');
      let metaWrites = 0;
      mockWriteFileAtomic.mockImplementation((path) => {
        if (!String(path).endsWith('/meta.json')) return;
        metaWrites += 1;
        if (terminalWriteFails && metaWrites === 2) {
          throw new Error('callback terminal meta write failed');
        }
      });

      const failure = createWorkflowExecutionBootstrap(
        workflowConfig,
        'Callback failure',
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'mock',
          reportDirName: 'callback-failure',
          onRunningEvidencePublished() {
            throw callbackError;
          },
        },
      );

      if (terminalWriteFails) {
        await expect(failure).rejects.toMatchObject({
          errors: [
            callbackError,
            expect.objectContaining({
              message: 'callback terminal meta write failed',
            }),
          ],
        });
      } else {
        await expect(failure).rejects.toBe(callbackError);
      }
      expect(metaWrites).toBe(2);
    },
  );
});
