import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAgent } from '../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, WorkflowState, WorkflowStep } from '../core/models/types.js';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import {
  parseGroundCheckDecision,
  resolveGroundCheckConfig,
} from '../core/workflow/ground-check.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import { normalizeProviderOptions } from '../infra/config/providerOptions.js';
import { denormalizeProviderOptions } from '../infra/config/configNormalizers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const tmpDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-ground-check-'));
  tmpDirs.push(dir);
  return dir;
}

function makeAgentResponse(content: string, overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'agent',
    status: 'done',
    content,
    timestamp: new Date('2026-06-25T00:00:00.000Z'),
    ...overrides,
  };
}

function makeState(): WorkflowState {
  return {
    workflowName: 'ground-check-workflow',
    currentStep: 'reviewers',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeStructuredCaller(): StructuredCaller {
  return {
    evaluateCondition: vi.fn(),
    judgeStatus: vi.fn(),
    decomposeTask: vi.fn(),
    requestMoreParts: vi.fn(),
  };
}

function makeGroundCheckDeps(tmpDir: string): ParallelRunnerDeps {
  const reportDirRel = '.takt/runs/ground-check/reports';
  const reportDirAbs = join(tmpDir, reportDirRel);
  mkdirSync(reportDirAbs, { recursive: true });

  const reviewerProviderOptions = {
    opencode: {
      variant: 'review-high',
      groundCheck: {
        enabled: true,
        provider: 'codex' as const,
        model: 'gpt-5-mini',
        providerOptions: {
          codex: { reasoningEffort: 'high' as const },
        },
      },
    },
  };

  return {
    optionsBuilder: {
      resolveStepProviderModel: vi.fn((step: WorkflowStep) => ({
        provider: step.provider ?? 'opencode',
        model: step.model ?? 'review-model',
        providerOptions: step.providerOptions ?? reviewerProviderOptions,
      })),
      buildAgentOptions: vi.fn((step: WorkflowStep) => ({
        cwd: tmpDir,
        projectCwd: tmpDir,
        resolvedProvider: step.provider ?? 'opencode',
        resolvedModel: step.model ?? 'review-model',
        providerOptions: step.providerOptions ?? reviewerProviderOptions,
      })),
      buildPhaseRunnerContext: vi.fn((
        state: WorkflowState,
        lastResponse: string | undefined,
        updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
      ) => ({
        cwd: tmpDir,
        reportDir: reportDirAbs,
        language: 'en',
        workflowName: 'ground-check-workflow',
        lastResponse,
        getSessionId: (persona: string) => state.personaSessions.get(persona),
        resolveSessionKey: (step: WorkflowStep) => `${step.persona ?? step.name}:${step.provider ?? 'opencode'}`,
        buildResumeOptions: (step: WorkflowStep, sessionId: string) => ({
          cwd: tmpDir,
          projectCwd: tmpDir,
          sessionId,
          resolvedProvider: step.provider ?? 'opencode',
          resolvedModel: step.model ?? 'review-model',
          providerOptions: step.providerOptions ?? reviewerProviderOptions,
          allowedTools: [],
          permissionMode: 'readonly' as const,
        }),
        buildNewSessionReportOptions: (step: WorkflowStep) => ({
          cwd: tmpDir,
          projectCwd: tmpDir,
          resolvedProvider: step.provider ?? 'opencode',
          resolvedModel: step.model ?? 'review-model',
          providerOptions: step.providerOptions ?? reviewerProviderOptions,
          allowedTools: [],
          permissionMode: 'readonly' as const,
        }),
        updatePersonaSession,
        structuredCaller: makeStructuredCaller(),
      })),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: {
      buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      normalizeStructuredOutput: vi.fn((_step: WorkflowStep, response: AgentResponse) => response),
      emitStepReports: vi.fn(),
      persistPreviousResponseSnapshot: vi.fn(),
    } as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: {
      projectCwd: tmpDir,
    },
    getCwd: () => tmpDir,
    getReportDir: () => reportDirRel,
    getWorkflowName: () => 'ground-check-workflow',
    getInteractive: () => false,
    observabilityEnabled: false,
    detectRuleIndex: () => -1,
    structuredCaller: makeStructuredCaller(),
    refreshFindingsState: vi.fn(),
    emitEvent: vi.fn(),
    getRunId: () => 'run-ground-check',
    runQualityGates: vi.fn().mockResolvedValue({ ok: true, results: [] }),
  };
}

afterEach(() => {
  vi.resetAllMocks();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('ground-check config and decision parsing', () => {
  it('Given raw provider_options ground_check, When normalized and denormalized, Then snake_case is preserved at the boundary', () => {
    const normalized = normalizeProviderOptions({
      opencode: {
        network_access: true,
        ground_check: {
          enabled: true,
          provider: 'codex',
          model: 'gpt-5-mini',
          provider_options: {
            codex: { reasoning_effort: 'high' },
          },
        },
      },
    });

    expect(normalized).toEqual({
      opencode: {
        networkAccess: true,
        groundCheck: {
          enabled: true,
          provider: 'codex',
          model: 'gpt-5-mini',
          providerOptions: {
            codex: { reasoningEffort: 'high' },
          },
        },
      },
    });
    expect(denormalizeProviderOptions(normalized)).toEqual({
      opencode: {
        network_access: true,
        ground_check: {
          enabled: true,
          provider: 'codex',
          model: 'gpt-5-mini',
          provider_options: {
            codex: { reasoning_effort: 'high' },
          },
        },
      },
    });
  });

  it('Given ambiguous ground-check tags, When parsing the decision, Then it fails closed to NEED_RECHECK', () => {
    expect(parseGroundCheckDecision('[GROUND_CHECK:VALID]')).toBe('valid');
    expect(parseGroundCheckDecision('[GROUND_CHECK:NEED_RECHECK]')).toBe('need_recheck');
    expect(parseGroundCheckDecision('no tag')).toBe('need_recheck');
    expect(parseGroundCheckDecision('[GROUND_CHECK:VALID]\n[GROUND_CHECK:NEED_RECHECK]')).toBe('need_recheck');
    expect(parseGroundCheckDecision('[GROUND_CHECK:UNKNOWN]')).toBe('need_recheck');
  });

  it('Given enabled ground_check without explicit provider/model/options, When resolving, Then reviewer provider settings are reused without leaking ground_check', () => {
    const providerOptions = {
      opencode: {
        variant: 'review-high',
        groundCheck: { enabled: true },
      },
    };

    expect(resolveGroundCheckConfig({
      provider: 'opencode',
      model: 'review-model',
      providerOptions,
    })).toEqual({
      enabled: true,
      provider: 'opencode',
      model: 'review-model',
      providerOptions: {
        opencode: { variant: 'review-high' },
      },
    });
  });
});

describe('parallel reviewer ground-check flow', () => {
  it('Given a hallucinated reviewer report, When ground-check requests recheck, Then the original reviewer regenerates the report and artifacts are versioned', async () => {
    const tmpDir = createTempDir();
    const reportDir = join(tmpDir, '.takt/runs/ground-check/reports');
    const deps = makeGroundCheckDeps(tmpDir);
    const state = makeState();
    const subStep: AgentWorkflowStep = {
      name: 'api-review',
      persona: 'api-reviewer',
      personaDisplayName: 'api-reviewer',
      instruction: 'Review API implementation',
      outputContracts: [{ name: 'api-review.md', format: '# API Review' }],
    };
    const parentStep: WorkflowStep = {
      name: 'reviewers',
      personaDisplayName: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [subStep],
    } as WorkflowStep;

    vi.mocked(executeAgent)
      .mockImplementationOnce(async (_persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: instruction });
        return makeAgentResponse('initial review mentions imaginary /v9 API', { sessionId: 'review-session-1' });
      })
      .mockImplementationOnce(async (_persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: 'report', userInstruction: instruction });
        return makeAgentResponse('# API Review\nUses imaginary /v9 API.', { sessionId: 'review-session-2' });
      })
      .mockImplementationOnce(async (_persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: 'ground-check', userInstruction: instruction });
        expect(instruction).toContain('Uses imaginary /v9 API');
        return makeAgentResponse('[GROUND_CHECK:NEED_RECHECK]\nUngrounded: imaginary /v9 API.', { sessionId: 'check-session-1' });
      })
      .mockImplementationOnce(async (persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: instruction });
        expect(persona).toBe('api-reviewer');
        expect(instruction).toContain('Ungrounded: imaginary /v9 API');
        return makeAgentResponse('rechecked review removes unsupported API claim', { sessionId: 'review-session-3' });
      })
      .mockImplementationOnce(async (_persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: 'report', userInstruction: instruction });
        return makeAgentResponse('# API Review\nNo unsupported API claims remain.', { sessionId: 'review-session-4' });
      })
      .mockImplementationOnce(async (_persona, instruction, options) => {
        options.onPromptResolved?.({ systemPrompt: 'ground-check', userInstruction: instruction });
        expect(instruction).toContain('No unsupported API claims remain');
        return makeAgentResponse('[GROUND_CHECK:VALID]\nAll claims are grounded.', { sessionId: 'check-session-2' });
      });

    const result = await new ParallelRunner(deps).runParallelStep(parentStep, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('done');
    expect(state.stepOutputs.get('api-review')?.content).toBe('rechecked review removes unsupported API claim');
    expect(readFileSync(join(reportDir, 'api-review.md'), 'utf-8')).toContain('No unsupported API claims remain');
    expect(readFileSync(join(reportDir, 'api-review.ground-check.md'), 'utf-8')).toContain('[GROUND_CHECK:VALID]');

    const reportHistory = readdirSync(reportDir);
    expect(reportHistory.some((name) => /^api-review\.md\.\d{8}T\d{6}Z/.test(name))).toBe(true);
    expect(reportHistory.some((name) => /^api-review\.ground-check\.md\.\d{8}T\d{6}Z/.test(name))).toBe(true);
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(6);
    expect(existsSync(join(reportDir, 'api-review.md'))).toBe(true);
  });
});
