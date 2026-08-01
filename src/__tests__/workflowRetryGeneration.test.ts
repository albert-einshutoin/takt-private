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

import {
  bindWorkflowGenerationSnapshot,
  buildWorkflowGenerationSnapshot,
  buildWorkflowGenerationWitness,
  disposeWorkflowGenerationSnapshot,
  snapshotWorkflowRetrySource,
  type WorkflowGenerationSnapshot,
} from '../features/tasks/execute/workflowRetryGeneration.js';
import {
  attachWorkflowOpaqueRef,
  attachWorkflowTrustInfo,
} from '../infra/config/loaders/workflowSourceMetadata.js';

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

  it('pins equal-named call edges by exact parent object identity', () => {
    const root = callWorkflow('root', ['left', 'right']);
    const left = callWorkflow('duplicate-parent', ['leaf']);
    const right = {
      ...callWorkflow('duplicate-parent', ['leaf']),
      description: 'distinct parent generation',
    };
    const leftLeaf = agentWorkflow('left-leaf');
    const rightLeaf = agentWorkflow('right-leaf');
    mockResolveWorkflowCallTarget.mockImplementation((
      parent: WorkflowConfig,
      identifier: string,
    ) => {
      if (parent === root) return identifier === 'left' ? left : right;
      if (parent === left) return leftLeaf;
      if (parent === right) return rightLeaf;
      return null;
    });

    const snapshot = buildWorkflowGenerationSnapshot(root, '/project', '/project', readContext);
    const resolve = bindWorkflowGenerationSnapshot(snapshot, root);

    const pinnedLeft = resolve(root, 'left', 'call-0');
    const pinnedRight = resolve(root, 'right', 'call-1');
    expect(resolve(pinnedLeft!, 'leaf', 'call-0')).toBe(leftLeaf);
    expect(resolve(pinnedRight!, 'leaf', 'call-0')).toBe(rightLeaf);
  });

  it('returns one canonical child for memoized DAG objects so every edge resolves grandchildren', () => {
    const root = callWorkflow('root', ['left', 'right']);
    const left = callWorkflow('shared', ['leaf']);
    const right = callWorkflow('shared', ['leaf']);
    const leaf = agentWorkflow('leaf');
    mockResolveWorkflowCallTarget.mockImplementation((
      parent: WorkflowConfig,
      identifier: string,
    ) => {
      if (parent === root) return identifier === 'left' ? left : right;
      if (parent === left || parent === right) return leaf;
      return null;
    });

    const snapshot = buildWorkflowGenerationSnapshot(root, '/project', '/project', readContext);
    const resolve = bindWorkflowGenerationSnapshot(snapshot, root);
    const pinnedLeft = resolve(root, 'left', 'call-0');
    const pinnedRight = resolve(root, 'right', 'call-1');

    expect(pinnedRight).toBe(pinnedLeft);
    expect(resolve(pinnedLeft!, 'leaf', 'call-0')).toBe(leaf);
    expect(resolve(pinnedRight!, 'leaf', 'call-0')).toBe(leaf);
  });

  it('rejects forged and disposed run snapshots with the stable discovery taxonomy', () => {
    const root = callWorkflow('root', ['child']);
    const child = agentWorkflow('child');
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const snapshot = buildWorkflowGenerationSnapshot(root, '/project', '/project', readContext);
    const resolve = bindWorkflowGenerationSnapshot(snapshot, root);

    expect(() => bindWorkflowGenerationSnapshot(
      { witness: snapshot.witness } as WorkflowGenerationSnapshot,
      root,
    )).toThrowError(WorkflowDiscoveryReadError);
    disposeWorkflowGenerationSnapshot(snapshot);
    expect(() => resolve(root, 'child', 'call-0')).toThrowError(WorkflowDiscoveryReadError);
    expect(() => disposeWorkflowGenerationSnapshot(snapshot)).not.toThrow();
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

  it('produces the same persisted witness after an identical workflow moves checkout paths', () => {
    const checkoutA = attachWorkflowOpaqueRef(agentWorkflow('portable'), 'project:sha256:path-a');
    const checkoutB = attachWorkflowOpaqueRef(agentWorkflow('portable'), 'project:sha256:path-b');

    expect(buildWorkflowGenerationWitness(checkoutA, '/a', '/a', readContext))
      .toBe(buildWorkflowGenerationWitness(checkoutB, '/b', '/b', readContext));
  });

  it('keeps portable trust-source identity in the persisted witness', () => {
    const projectWorkflow = attachWorkflowTrustInfo(agentWorkflow('trusted'), {
      source: 'project',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });
    const externalWorkflow = attachWorkflowTrustInfo(agentWorkflow('trusted'), {
      source: 'external',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });

    expect(buildWorkflowGenerationWitness(projectWorkflow, '/project', '/project', readContext))
      .not.toBe(buildWorkflowGenerationWitness(externalWorkflow, '/project', '/project', readContext));
  });

  it('does not depend on localeCompare for canonical key ordering', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-dependent comparator used');
    });
    try {
      expect(buildWorkflowGenerationWitness(agentWorkflow('portable'), '/project', '/project', readContext))
        .toMatch(/^[0-9a-f]{64}$/);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('rejects sparse resume stacks', () => {
    const stack = new Array(1);

    expect(() => snapshotWorkflowRetrySource({
      generationWitness: 'a'.repeat(64),
      resumePoint: { version: 1, stack, iteration: 1, elapsed_ms: 1 },
    })).toThrowError(WorkflowDiscoveryReadError);
  });

  it('rejects custom Array prototypes without invoking inherited getters', () => {
    let getterCalled = false;
    const customPrototype = Object.create(Array.prototype) as unknown[];
    Object.defineProperty(customPrototype, '0', {
      get: () => {
        getterCalled = true;
        return { workflow: 'default', step: 'step', kind: 'agent' };
      },
    });
    const stack = new Array(1);
    Object.setPrototypeOf(stack, customPrototype);

    expect(() => snapshotWorkflowRetrySource({
      generationWitness: 'a'.repeat(64),
      resumePoint: { version: 1, stack, iteration: 1, elapsed_ms: 1 },
    })).toThrowError(WorkflowDiscoveryReadError);
    expect(getterCalled).toBe(false);
  });
});
