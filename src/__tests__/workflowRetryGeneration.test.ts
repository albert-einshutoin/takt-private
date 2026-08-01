import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import type { InternalWorkflowReadContext } from '../infra/config/loaders/workflowDiscovery.js';
import { WorkflowDiscoveryReadError } from '../infra/config/loaders/workflowDiscoveryError.js';

const { mockResolveWorkflowCallTarget } = vi.hoisted(() => ({
  mockResolveWorkflowCallTarget: vi.fn(),
}));

vi.mock('../infra/config/loaders/workflowCallResolver.js', () => ({
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

import { buildWorkflowGenerationWitness } from '../features/tasks/execute/workflowRetryGeneration.js';

const readContext = Object.freeze({ marker: 'one-snapshot' }) as unknown as InternalWorkflowReadContext;

function agentWorkflow(name: string, stepCount = 1): WorkflowConfig {
  return {
    name,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      name: `step-${index}`,
      instruction: `instruction-${index}`,
      rules: [],
    })),
  };
}

function callWorkflow(name: string, calls: string[]): WorkflowConfig {
  return {
    name,
    steps: calls.map((call, index) => ({
      name: `call-${index}`,
      kind: 'workflow_call' as const,
      call,
      rules: [],
    })),
  };
}

describe('workflow retry generation witness', () => {
  beforeEach(() => {
    mockResolveWorkflowCallTarget.mockReset();
  });
  it('memoizes duplicate DAG references and uses the same read context for every child', () => {
    const root = callWorkflow('root', ['shared', 'shared']);
    const shared = callWorkflow('shared', ['leaf']);
    const leaf = agentWorkflow('leaf');
    mockResolveWorkflowCallTarget.mockImplementation((
      _parent: WorkflowConfig,
      identifier: string,
      _step: string,
      _project: string,
      _lookup: string,
      _parentContext: unknown,
      context: InternalWorkflowReadContext,
    ) => {
      expect(context).toBe(readContext);
      return identifier === 'shared' ? shared : leaf;
    });

    const first = buildWorkflowGenerationWitness(root, '/project', '/project', readContext);
    const second = buildWorkflowGenerationWitness(root, '/project', '/project', readContext);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(6);
  });

  it('bounds cycles without recursively resolving the repeated reference', () => {
    const root = callWorkflow('root', ['child']);
    const child = callWorkflow('child', ['root']);
    mockResolveWorkflowCallTarget.mockImplementation((
      _parent: WorkflowConfig,
      identifier: string,
    ) => identifier === 'child' ? child : root);

    expect(buildWorkflowGenerationWitness(root, '/project', '/project', readContext))
      .toMatch(/^[0-9a-f]{64}$/);
    expect(mockResolveWorkflowCallTarget).toHaveBeenCalledTimes(2);
  });

  it('fails with the stable discovery taxonomy beyond the engine depth limit', () => {
    const workflows = Array.from({ length: 6 }, (_, index) => (
      index === 5 ? agentWorkflow(`workflow-${index}`) : callWorkflow(`workflow-${index}`, [`workflow-${index + 1}`])
    ));
    mockResolveWorkflowCallTarget.mockImplementation((
      _parent: WorkflowConfig,
      identifier: string,
    ) => workflows[Number(identifier.split('-')[1])]);

    expect(() => buildWorkflowGenerationWitness(workflows[0]!, '/project', '/project', readContext))
      .toThrowError(WorkflowDiscoveryReadError);
  });

  it('fails closed when the total step budget is exceeded', () => {
    const oversized = agentWorkflow('oversized', 4097);

    expect(() => buildWorkflowGenerationWitness(oversized, '/project', '/project', readContext))
      .toThrowError(WorkflowDiscoveryReadError);
    expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
  });

  it('fails closed when a wide graph exceeds the total node budget', () => {
    const identifiers = Array.from({ length: 256 }, (_, index) => `child-${index}`);
    const root = callWorkflow('wide-root', identifiers);
    mockResolveWorkflowCallTarget.mockImplementation((
      _parent: WorkflowConfig,
      identifier: string,
    ) => agentWorkflow(identifier));

    expect(() => buildWorkflowGenerationWitness(root, '/project', '/project', readContext))
      .toThrowError(WorkflowDiscoveryReadError);
  });

  it('fails closed before final tree serialization when canonical bytes exceed the budget', () => {
    const oversized = agentWorkflow('oversized-bytes');
    oversized.steps[0]!.instruction = 'x'.repeat((4 * 1024 * 1024) + 1);

    expect(() => buildWorkflowGenerationWitness(oversized, '/project', '/project', readContext))
      .toThrowError(WorkflowDiscoveryReadError);
  });
});
