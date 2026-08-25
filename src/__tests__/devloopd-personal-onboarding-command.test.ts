import { describe, expect, it, vi } from 'vitest';
import {
  executePersonalOnboardingCommand,
  type PersonalOnboardingTemplateCommandFacade,
} from '../devloopd/personalOnboardingCommand.js';
import type {
  PersonalOnboardingReport,
  RunPersonalOnboardingOptions,
} from '../devloopd/personalOnboarding.js';

const PLAN_ID = 'a'.repeat(64);

function legacyReport(): PersonalOnboardingReport {
  return {
    passed: true,
    changed: false,
    apply: false,
    repoPath: '/repo',
    actions: [{
      status: 'would_change',
      name: 'root gitignore',
      message: 'would append local automation ignore patterns',
      path: '/repo/.gitignore',
      detail: '.devloop/',
    }],
  };
}

function dependencies(templateRun = vi.fn()): {
  runLegacy: ReturnType<typeof vi.fn>;
  formatLegacy: ReturnType<typeof vi.fn>;
  createTemplateFacade: ReturnType<typeof vi.fn>;
} {
  const report = legacyReport();
  const facade: PersonalOnboardingTemplateCommandFacade = {
    run: templateRun,
  };
  return {
    runLegacy: vi.fn(async (_options: RunPersonalOnboardingOptions) => report),
    formatLegacy: vi.fn(() => [
      'devloopd onboard-repo passed',
      'Mode: dry-run',
      'Repository: /repo',
      '- WOULD_CHANGE root gitignore: would append local automation ignore patterns',
      '  /repo/.gitignore',
      '  .devloop/',
    ].join('\n')),
    createTemplateFacade: vi.fn(() => facade),
  };
}

describe('devloopd onboard-repo command compatibility', () => {
  it('keeps template-absent output byte-equivalent and never creates the new facade', async () => {
    const value = dependencies();

    const result = await executePersonalOnboardingCommand({
      cwd: '/repo', repo: 'owner/repo', apply: false, force: false,
    }, value);

    expect(value.runLegacy).toHaveBeenCalledOnce();
    expect(value.runLegacy).toHaveBeenCalledWith({
      repoPath: '/repo', repo: 'owner/repo', apply: false, force: false,
    });
    expect(value.formatLegacy).toHaveBeenCalledWith(legacyReport());
    expect(value.createTemplateFacade).not.toHaveBeenCalled();
    expect(result).toEqual({
      stdout: [
        'devloopd onboard-repo passed',
        'Mode: dry-run',
        'Repository: /repo',
        '- WOULD_CHANGE root gitignore: would append local automation ignore patterns',
        '  /repo/.gitignore',
        '  .devloop/',
      ].join('\n'),
      exitCode: 0,
    });
  });

  it.each([
    ['force dry-run', { force: true }, 'FORCE_REQUIRES_APPLY'],
    ['expected plan dry-run', { expectedPlanId: PLAN_ID }, 'EXPECTED_PLAN_ID_REQUIRES_APPLY'],
    ['apply without expected plan', { apply: true }, 'MISSING_EXPECTED_PLAN_ID'],
  ] as const)('rejects %s before creating template authority', async (_name, flags, code) => {
    const value = dependencies();

    const result = await executePersonalOnboardingCommand({
      cwd: '/repo', template: './starter.taktpack', json: true,
      apply: false, force: false, ...flags,
    }, value);

    expect(value.runLegacy).not.toHaveBeenCalled();
    expect(value.createTemplateFacade).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(20);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1.0', status: 'error', command: 'onboard-repo',
      error: { code },
    });
  });

  it('routes template mode only through the safe facade and separates JSON from human output', async () => {
    const machineOutput = JSON.stringify({
      schemaVersion: '1.0', status: 'partial', command: 'onboard-repo',
      mode: 'apply', backupId: 'backup-safe',
      components: {
        files: { status: 'success' },
        rootGitignore: { status: 'success' },
        labels: { status: 'error' },
      },
    });
    const templateRun = vi.fn(async () => ({
      passed: false,
      machineOutput,
      humanOutput: 'files applied; GitHub labels failed; backup backup-safe retained',
    }));
    const value = dependencies(templateRun);

    const result = await executePersonalOnboardingCommand({
      cwd: '/repo', repo: 'owner/repo', template: 'github:owner/starter@v1.0.0',
      apply: true, force: true, expectedPlanId: PLAN_ID, json: true,
    }, value);

    expect(value.runLegacy).not.toHaveBeenCalled();
    expect(value.createTemplateFacade).toHaveBeenCalledOnce();
    expect(templateRun).toHaveBeenCalledWith({
      repoPath: '/repo', repo: 'owner/repo',
      source: { kind: 'github', value: 'github:owner/starter@v1.0.0' },
      mutation: { mode: 'apply', force: true, expectedPlanId: PLAN_ID },
    });
    expect(result).toEqual({ stdout: machineOutput, exitCode: 1 });
    expect(result.stdout).not.toContain('files applied');
  });

  it('preserves the dry-run plan through JSON and human apply handoff', async () => {
    const machineOutput = JSON.stringify({
      schemaVersion: '1.0', status: 'success', command: 'onboard-repo',
      mode: 'dry-run', planId: PLAN_ID,
      components: {
        files: { status: 'success' }, rootGitignore: { status: 'success' },
        labels: { status: 'success' },
      },
    });
    const humanOutput = `devloopd onboard-repo template success\nPlan: ${PLAN_ID}`;
    const templateRun = vi.fn()
      .mockResolvedValueOnce({ passed: true, planId: PLAN_ID, machineOutput, humanOutput })
      .mockResolvedValueOnce({
        passed: true,
        machineOutput: JSON.stringify({
          schemaVersion: '1.0', status: 'success', command: 'onboard-repo', mode: 'apply',
        }),
        humanOutput: 'devloopd onboard-repo template success',
      });
    const value = dependencies(templateRun);

    const preview = await executePersonalOnboardingCommand({
      cwd: '/repo', template: './starter.taktpack', json: true,
    }, value);
    const applied = await executePersonalOnboardingCommand({
      cwd: '/repo', template: './starter.taktpack', apply: true,
      expectedPlanId: preview.planId,
    }, value);

    expect(preview).toEqual({ stdout: machineOutput, exitCode: 0, planId: PLAN_ID });
    expect(humanOutput).toContain(`Plan: ${preview.planId}`);
    expect(templateRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mutation: { mode: 'apply', force: false, expectedPlanId: PLAN_ID },
    }));
    expect(applied.exitCode).toBe(0);
    expect(applied).not.toHaveProperty('planId');
  });
});
