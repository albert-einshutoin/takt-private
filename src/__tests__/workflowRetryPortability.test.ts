import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowConfig, WorkflowResumePoint, WorkflowResumePointEntry } from '../core/models/index.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { getWorkflowStepKind } from '../core/workflow/step-kind.js';
import { snapshotWorkflowRuntimeRead } from '../features/tasks/execute/workflowRuntimeReadBoundary.js';
import { executeTaskWorkflow } from '../features/tasks/execute/taskWorkflowExecution.js';
import {
  bindWorkflowGenerationSnapshot,
  buildWorkflowGenerationWitness,
  buildWorkflowGenerationSnapshot,
  resolveWorkflowRetryOverrides,
  type WorkflowGenerationSnapshot,
  type WorkflowRetrySource,
} from '../features/tasks/execute/workflowRetryGeneration.js';
import { loadWorkflowByIdentifierWithReadContext } from '../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { WorkflowDiscoveryReadError } from '../infra/config/loaders/workflowDiscoveryError.js';
import {
  createWorkflowCallResolver,
  createWorkflowExecutionContext,
} from '../features/tasks/execute/workflowExecutionContext.js';

const DIRECT = `name: direct
initial_step: work
max_steps: 5
steps:
  - name: work
    instruction: portable direct work
`;

const ROOT = `name: root
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`;

const CHILD = `name: child
subworkflow:
  callable: true
initial_step: delegate_deep
max_steps: 5
steps:
  - name: delegate_deep
    kind: workflow_call
    call: ./deep.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`;

const DEEP = `name: deep
subworkflow:
  callable: true
initial_step: finish
max_steps: 5
steps:
  - name: finish
    instruction: portable deep work
`;

interface CapturedGeneration {
  workflow: WorkflowConfig;
  witness: string;
  stack: WorkflowResumePointEntry[];
  snapshot: WorkflowGenerationSnapshot;
}

describe('portable retry workflow references', () => {
  let rootDir: string;
  let deskA: string;
  let deskB: string;
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    rootDir = mkdtempSync(join(tmpdir(), 'takt-portable-retry-'));
    deskA = join(rootDir, 'desk-a');
    deskB = join(rootDir, 'desk-b');
    configDir = join(rootDir, 'global');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'language: en\n');
    process.env.TAKT_CONFIG_DIR = configDir;
    for (const desk of [deskA, deskB]) writeWorkflows(desk);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each([
    ['direct', 'direct', 1],
    ['root', 'root', 1],
    ['deep nested', 'root', 3],
  ] as const)('rebinds %s resume entries from desk A to desk B', (
    _case,
    identifier,
    depth,
  ) => {
    const generationA = captureGeneration(deskA, identifier, depth);
    const generationB = captureGeneration(deskB, identifier, depth);
    expect(generationB.witness).toBe(generationA.witness);
    const resumePoint: WorkflowResumePoint = {
      version: 1,
      stack: generationA.stack,
      iteration: 4,
      elapsed_ms: 1234,
    };

    const overrides = resolveOnDesk(deskB, identifier, {
      resumePoint,
      initialIteration: 4,
      generationWitness: generationA.witness,
    });

    expect(overrides.resumePoint).toEqual({
      ...resumePoint,
      stack: generationB.stack,
    });
    expect(overrides.initialIterationOverride).toBe(4);
    expect(overrides.resumePoint?.elapsed_ms).toBe(1234);
    for (let index = 0; index < depth; index += 1) {
      expect(overrides.resumePoint?.stack[index]?.workflow_ref)
        .toBe(generationB.stack[index]?.workflow_ref);
      expect(overrides.resumePoint?.stack[index]?.workflow_ref)
        .not.toBe(generationA.stack[index]?.workflow_ref);
    }
  });

  it('rejects a same-name desk B topology change instead of invoking the executor', async () => {
    const generationA = captureGeneration(deskA, 'root', 3);
    writeFileSync(join(deskB, '.takt', 'workflows', 'child.yaml'), CHILD.replace(
      'name: delegate_deep',
      'name: changed_edge',
    ).replace('initial_step: delegate_deep', 'initial_step: changed_edge'));
    const generationB = captureGeneration(deskB, 'root', 1);
    let executorCalled = false;

    expect(generationB.witness).not.toBe(generationA.witness);
    await expect(executeTaskWorkflow({
      task: 'portable topology mismatch',
      cwd: deskB,
      projectCwd: deskB,
      workflowIdentifier: 'root',
      retrySource: {
        resumePoint: {
          version: 1,
          stack: generationA.stack,
          iteration: 4,
          elapsed_ms: 1234,
        },
        generationWitness: generationA.witness,
      },
    }, async () => {
      executorCalled = true;
      return { success: true };
    })).rejects.toMatchObject({
      name: 'WorkflowDiscoveryReadError',
      message: 'Workflow discovery failed',
    });
    expect(executorCalled).toBe(false);
  });

  it('fails closed when logical stack identity disagrees with matching topology', () => {
    const generation = captureGeneration(deskB, 'root', 3);
    expect(() => resolveOnDesk(deskB, 'root', {
      resumePoint: {
        version: 1,
        stack: generation.stack.map((entry, index) => (
          index === 1 ? { ...entry, workflow: 'same-name-but-wrong-edge' } : entry
        )),
        iteration: 4,
        elapsed_ms: 1234,
      },
      generationWitness: generation.witness,
    })).toThrowError(WorkflowDiscoveryReadError);
  });

  it('keeps the run-start child generation after a provider wait and disk mutation', () => {
    const generationA = captureGeneration(deskA, 'root', 1);
    const effectiveWorkflow = { ...generationA.workflow };
    const resolver = createWorkflowCallResolver(
      createWorkflowExecutionContext(generationA.workflow, deskA),
      generationA.snapshot,
      effectiveWorkflow,
    );
    writeFileSync(
      join(deskA, '.takt', 'workflows', 'child.yaml'),
      CHILD.replace('name: child', 'name: child\ndescription: generation B'),
    );

    const child = resolver?.({
      parentWorkflow: effectiveWorkflow,
      identifier: './child.yaml',
      stepName: 'delegate',
      projectCwd: deskA,
      lookupCwd: deskA,
    });

    expect(child?.description).toBeUndefined();
  });

  it('fails closed instead of live-reading a child when the snapshot is absent', () => {
    const generationA = captureGeneration(deskA, 'root', 1);
    const resolver = createWorkflowCallResolver(
      createWorkflowExecutionContext(generationA.workflow, deskA),
      undefined,
      generationA.workflow,
    );
    writeFileSync(
      join(deskA, '.takt', 'workflows', 'child.yaml'),
      CHILD.replace('name: child', 'name: child\ndescription: generation B'),
    );

    expect(() => resolver?.({
      parentWorkflow: generationA.workflow,
      identifier: './child.yaml',
      stepName: 'delegate',
      projectCwd: deskA,
      lookupCwd: deskA,
    })).toThrowError(WorkflowDiscoveryReadError);
  });

  it('passes the pinned callable tree through the production task boundary', async () => {
    await expect(executeTaskWorkflow({
      task: 'pinned production composition',
      cwd: deskA,
      projectCwd: deskA,
      workflowIdentifier: 'root',
    }, (workflow, _task, _cwd, options) => Promise.resolve().then(() => {
      writeFileSync(
        join(deskA, '.takt', 'workflows', 'child.yaml'),
        CHILD.replace('name: child', 'name: child\ndescription: generation B'),
      );
      const resolver = createWorkflowCallResolver(
        createWorkflowExecutionContext(workflow, deskA),
        options.workflowGenerationSnapshot,
        workflow,
      );
      const child = resolver?.({
        parentWorkflow: workflow,
        identifier: './child.yaml',
        stepName: 'delegate',
        projectCwd: deskA,
        lookupCwd: deskA,
      });
      expect(child?.description).toBeUndefined();
      return { success: true };
    }))).resolves.toEqual({ success: true });
  });

  it('rejects an A to B to A cursor even when the current witness returns to A', async () => {
    const generationA = captureGeneration(deskB, 'root', 3);
    const childPath = join(deskB, '.takt', 'workflows', 'child.yaml');
    writeFileSync(childPath, `name: child
subworkflow:
  callable: true
initial_step: b_only
max_steps: 5
steps:
  - name: b_only
    instruction: generation B only
`);
    const generationB = captureGeneration(deskB, 'root', 2);
    writeFileSync(childPath, CHILD);
    let executorCalled = false;

    await expect(executeTaskWorkflow({
      task: 'ABA cursor rejection',
      cwd: deskB,
      projectCwd: deskB,
      workflowIdentifier: 'root',
      retrySource: {
        resumePoint: {
          version: 1,
          stack: generationB.stack,
          iteration: 4,
          elapsed_ms: 1234,
        },
        generationWitness: generationA.witness,
      },
    }, async () => {
      executorCalled = true;
      return { success: true };
    })).rejects.toThrowError(WorkflowDiscoveryReadError);
    expect(executorCalled).toBe(false);
  });

  it.each([
    ['complete', undefined],
    ['bootstrap failure', new Error('bootstrap failure')],
    ['provider throw', new Error('provider throw')],
    ['abort', new Error('aborted')],
  ] as const)('disposes the task-owned snapshot after %s settlement', async (scenario, failure) => {
    let borrowedSnapshot: WorkflowGenerationSnapshot | undefined;
    let borrowedWorkflow: WorkflowConfig | undefined;
    const abortController = new AbortController();
    const execution = executeTaskWorkflow({
      task: `snapshot lifetime ${scenario}`,
      cwd: deskA,
      projectCwd: deskA,
      workflowIdentifier: 'root',
      abortSignal: abortController.signal,
    }, (workflow, _task, _cwd, options) => {
      borrowedSnapshot = options.workflowGenerationSnapshot;
      borrowedWorkflow = workflow;
      if (scenario === 'abort') {
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(failure), { once: true });
          queueMicrotask(() => abortController.abort());
        });
      }
      return failure ? Promise.reject(failure) : Promise.resolve({ success: true });
    });

    if (failure) await expect(execution).rejects.toBe(failure);
    else await expect(execution).resolves.toEqual({ success: true });
    expect(borrowedSnapshot).toBeDefined();
    expect(borrowedWorkflow).toBeDefined();
    expect(() => bindWorkflowGenerationSnapshot(borrowedSnapshot!, borrowedWorkflow!))
      .toThrowError(WorkflowDiscoveryReadError);
  });

  function captureGeneration(
    desk: string,
    identifier: string,
    depth: number,
  ): CapturedGeneration {
    return snapshotWorkflowRuntimeRead({
      snapshot: (readContext) => {
        const workflow = loadWorkflowByIdentifierWithReadContext(
          identifier,
          desk,
          { lookupCwd: desk },
          readContext,
        );
        if (!workflow) throw new Error(`missing ${identifier}`);
        const stack: WorkflowResumePointEntry[] = [];
        let current = workflow;
        for (let index = 0; index < depth; index += 1) {
          const step = current.steps.find((candidate) => candidate.name === current.initialStep);
          if (!step) throw new Error('missing initial step');
          stack.push(buildWorkflowResumePointEntry(current, step.name, getWorkflowStepKind(step)));
          if (index < depth - 1) {
            if (getWorkflowStepKind(step) !== 'workflow_call') throw new Error('missing call edge');
            const child = resolveWorkflowCallTarget(
              current,
              (step as { call: string }).call,
              step.name,
              desk,
              desk,
              undefined,
              readContext,
            );
            if (!child) throw new Error('missing child');
            current = child;
          }
        }
        const snapshot = buildWorkflowGenerationSnapshot(workflow, desk, desk, readContext);
        return {
          workflow,
          witness: snapshot.witness,
          stack,
          snapshot,
        };
      },
    });
  }

  function resolveOnDesk(
    desk: string,
    identifier: string,
    source: WorkflowRetrySource,
  ) {
    return snapshotWorkflowRuntimeRead({
      snapshot: (readContext) => {
        const workflow = loadWorkflowByIdentifierWithReadContext(
          identifier,
          desk,
          { lookupCwd: desk },
          readContext,
        );
        if (!workflow) throw new Error(`missing ${identifier}`);
        const currentWitness = buildWorkflowGenerationWitness(workflow, desk, desk, readContext);
        if (currentWitness !== source.generationWitness) throw new Error('generation mismatch');
        return resolveWorkflowRetryOverrides(workflow, desk, desk, source, readContext);
      },
    });
  }
});

function writeWorkflows(desk: string): void {
  const workflowsDir = join(desk, '.takt', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'direct.yaml'), DIRECT);
  writeFileSync(join(workflowsDir, 'root.yaml'), ROOT);
  writeFileSync(join(workflowsDir, 'child.yaml'), CHILD);
  writeFileSync(join(workflowsDir, 'deep.yaml'), DEEP);
}
