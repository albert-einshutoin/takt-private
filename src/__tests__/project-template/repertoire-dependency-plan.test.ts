import { describe, expect, it, vi } from 'vitest';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  inspectProjectTemplateRepertoireDependencies,
  ProjectTemplateRepertoireDependencyInspectionError,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  serializeProjectTemplateRepertoireDependencyLock,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  calculateProjectTemplateRepertoireDependencyPlanId,
  createProjectTemplateRepertoireDependencyPlan,
} from '../../features/project-template/repertoire-dependency-plan.js';

const SOURCE_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);

function dependency(
  scope = '@acme/repertoire',
  overrides: Record<string, unknown> = {},
) {
  const repository = scope.slice(1);
  return {
    scope,
    version: '1.2.3',
    source: `github:${repository}@v1.2.3`,
    commit: COMMIT,
    capabilities: ['edit'],
    ...overrides,
  };
}

function lock(
  dependencies: readonly unknown[] = [dependency()],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: '1.0',
    sourceDescriptorSha256: SOURCE_SHA,
    manifestSha256: MANIFEST_SHA,
    dependencies,
    ...overrides,
  };
}

function observation(
  scope = '@acme/repertoire',
  overrides: Record<string, unknown> = {},
) {
  return {
    scope,
    state: 'installed',
    installed: {
      source: `github:${scope.slice(1)}`,
      ref: 'v1.2.3',
      version: '1.2.3',
      commit: COMMIT,
      capabilities: ['edit'],
      ...overrides,
    },
  };
}

function claim(
  incoming = lock(),
  observations: readonly unknown[] = [observation()],
  inspectionOverrides: Record<string, unknown> = {},
) {
  const verified = inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256: MANIFEST_SHA,
      dependencies: incoming.dependencies,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      ...inspectionOverrides,
    },
    port: {
      inspect() {
        return { witnessSha256: 'd'.repeat(64), observations };
      },
    },
  });
  return claimProjectTemplateRepertoireDependencyInspectionForPlanning(verified);
}

function create(
  incomingLock: ReturnType<typeof lock> = lock(),
  previousLock: Record<string, unknown> = { state: 'absent' },
  observations: readonly unknown[] = [observation()],
) {
  return createProjectTemplateRepertoireDependencyPlan({
    inspectionClaim: claim(incomingLock, observations),
    incomingLock,
    previousLock,
  });
}

describe('project template repertoire dependency plan G4.2', () => {
  it('creates a deterministic immutable add plan and next lock', () => {
    const incoming = lock();
    const plan = create(incoming);

    expect(plan).toMatchObject({
      schemaVersion: '1.0',
      planId: expect.stringMatching(/^[a-f0-9]{64}$/),
      preconditionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256: MANIFEST_SHA,
      previousLockState: 'absent',
      globalConflicts: [],
      reviewRequired: true,
      hardConflict: false,
      defaultApplyPossible: true,
      dependencies: [{
        scope: '@acme/repertoire',
        action: 'add',
        changes: ['ADDED'],
        installedConflicts: [],
      }],
      summary: {
        counts: { add: 1, keep: 0, update: 0, remove: 0, unknown: 0 },
        conflicts: 0,
        reviewRequired: true,
        hardConflict: false,
      },
      nextLock: incoming,
    });
    expect(calculateProjectTemplateRepertoireDependencyPlanId(plan))
      .toBe(plan.planId);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.dependencies)).toBe(true);
    expect(Object.isFrozen(plan.dependencies[0])).toBe(true);
    expect(Object.isFrozen(plan.nextLock?.dependencies[0])).toBe(true);
  });

  it.each([
    ['1.2.3', '1.2.3'],
    ['v1.2.3', 'v1.2.3'],
    ['refs/tags/1.2.3', '1.2.3'],
    ['refs/tags/v1.2.3', 'v1.2.3'],
  ])('normalizes only refs/tags/ for required ref %s', (sourceRef, installedRef) => {
    const incoming = lock([dependency('@acme/repertoire', {
      source: `github:acme/repertoire@${sourceRef}`,
    })]);
    const previous = serializeProjectTemplateRepertoireDependencyLock(incoming);
    const plan = create(
      incoming,
      { state: 'present', content: previous },
      [observation('@acme/repertoire', { ref: installedRef })],
    );
    expect(plan.dependencies[0]).toMatchObject({
      action: 'keep',
      changes: [],
      installedConflicts: [],
    });
    expect(plan.reviewRequired).toBe(false);
  });

  it('keeps v and non-v refs distinct after tag-prefix normalization', () => {
    const incoming = lock([dependency('@acme/repertoire', {
      source: 'github:acme/repertoire@refs/tags/v1.2.3',
    })]);
    const plan = create(
      incoming,
      { state: 'present', content: serializeProjectTemplateRepertoireDependencyLock(incoming) },
      [observation('@acme/repertoire', { ref: '1.2.3' })],
    );
    expect(plan.dependencies[0]?.installedConflicts).toEqual(['REF_MISMATCH']);
  });

  it('joins dependencies in canonical scope order with fixed change ordering', () => {
    const previous = lock([
      dependency('@acme/alpha', { capabilities: [] }),
      dependency('@acme/removed'),
    ]);
    const incoming = lock([
      dependency('@acme/alpha', {
        version: '2.0.0',
        source: 'github:acme/alpha@v2.0.0',
        commit: 'e'.repeat(40),
        capabilities: ['edit'],
      }),
      dependency('@acme/zeta'),
    ]);
    const plan = create(
      incoming,
      { state: 'present', content: serializeProjectTemplateRepertoireDependencyLock(previous) },
      [
        observation('@acme/alpha', {
          ref: 'v2.0.0', version: '2.0.0', commit: 'e'.repeat(40),
        }),
        observation('@acme/zeta'),
      ],
    );
    expect(plan.dependencies.map(({ scope, action, changes }) => ({
      scope, action, changes,
    }))).toEqual([
      {
        scope: '@acme/alpha',
        action: 'update',
        changes: [
          'SOURCE_CHANGED',
          'VERSION_CHANGED',
          'COMMIT_CHANGED',
          'EDIT_CAPABILITY_ADDED',
        ],
      },
      { scope: '@acme/removed', action: 'remove', changes: ['REMOVED'] },
      { scope: '@acme/zeta', action: 'add', changes: ['ADDED'] },
    ]);
    expect(plan.summary.counts).toEqual({
      add: 1, keep: 0, update: 1, remove: 1, unknown: 0,
    });
  });

  it('plans the strict 128-dependency upper bound deterministically', () => {
    const dependencies = Array.from({ length: 128 }, (_, index) =>
      dependency(`@a/p${String(index).padStart(3, '0')}`));
    const observations = dependencies.map((item) => observation(item.scope));
    const incoming = lock(dependencies);
    const first = create(incoming, { state: 'absent' }, observations);
    const second = create(incoming, { state: 'absent' }, observations);
    expect(first.summary.counts).toEqual({
      add: 128, keep: 0, update: 0, remove: 0, unknown: 0,
    });
    expect(first.planId).toBe(second.planId);
  });

  it('orders every installed conflict and blocks next lock', () => {
    const incoming = lock();
    const plan = create(incoming, { state: 'absent' }, [observation(
      '@acme/repertoire',
      {
        source: 'github:other/repertoire',
        ref: '1.2.3',
        version: '2.0.0',
        commit: 'e'.repeat(40),
        capabilities: [],
      },
    )]);
    expect(plan.dependencies[0]?.installedConflicts).toEqual([
      'SOURCE_MISMATCH',
      'REF_MISMATCH',
      'VERSION_MISMATCH',
      'COMMIT_MISMATCH',
      'CAPABILITY_MISMATCH',
    ]);
    expect(plan).not.toHaveProperty('nextLock');
    expect(plan.hardConflict).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it.each([
    [{ scope: '@acme/repertoire', state: 'missing' }, ['NOT_INSTALLED']],
    [{ scope: '@acme/repertoire', state: 'invalid', reason: 'INVALID_INSTALLATION' }, ['INVALID_INSTALLATION']],
  ])('seals missing and invalid installation conflicts', (seen, conflicts) => {
    expect(create(lock(), { state: 'absent' }, [seen])
      .dependencies[0]?.installedConflicts).toEqual(conflicts);
  });

  it('seals malformed previous bytes and consumes the planning claim', () => {
    const incoming = lock();
    const planningClaim = claim(incoming);
    const plan = createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: incoming,
      previousLock: { state: 'present', content: '{"schemaVersion":"2.0"}' },
    });
    expect(plan.globalConflicts).toEqual(['PREVIOUS_LOCK_INVALID']);
    expect(plan.dependencies[0]?.action).toBe('unknown');
    expect(plan.dependencies[0]?.changes).toEqual([]);
    expect(plan).not.toHaveProperty('nextLock');
    expect(() => createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: incoming,
      previousLock: { state: 'absent' },
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
  });

  it('does not guess removals when the previous lock is unavailable', () => {
    const plan = create(lock(), { state: 'unavailable' });
    expect(plan.globalConflicts).toEqual(['PREVIOUS_LOCK_UNAVAILABLE']);
    expect(plan.dependencies.map((entry) => entry.action)).toEqual(['unknown']);
  });

  it.each([
    ['malformed', '{'],
    ['future schema', '{\n  "schemaVersion": "2.0",\n  "sourceDescriptorSha256": "' + SOURCE_SHA + '",\n  "manifestSha256": "' + MANIFEST_SHA + '",\n  "dependencies": []\n}'],
    ['noncanonical', JSON.stringify(lock())],
    ['oversize', ' '.repeat(256 * 1024 + 1)],
  ])('seals %s previous content without parser details', (_name, content) => {
    const plan = create(lock(), { state: 'present', content });
    expect(plan.previousLockState).toBe('invalid');
    expect(plan.globalConflicts).toEqual(['PREVIOUS_LOCK_INVALID']);
    expect(plan.summary.conflicts).toBe(1);
  });

  it('accepts a pristine Uint8Array canonical previous lock snapshot', () => {
    const incoming = lock();
    const bytes = new TextEncoder().encode(
      serializeProjectTemplateRepertoireDependencyLock(incoming),
    );
    const plan = create(incoming, { state: 'present', content: bytes });
    bytes.fill(0);
    expect(plan.previousLockState).toBe('valid');
    expect(plan.dependencies[0]?.action).toBe('keep');
  });

  it('validates incoming lock before consuming the planning claim', () => {
    const incoming = lock();
    const planningClaim = claim(incoming);
    expect(() => createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: { ...incoming, schemaVersion: '2.0' },
      previousLock: { state: 'absent' },
    })).toThrow();
    expect(createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: incoming,
      previousLock: { state: 'absent' },
    }).dependencies[0]?.action).toBe('add');
  });

  it('rejects a stale binding without pairing its observations', () => {
    const incoming = lock();
    const planningClaim = claim(incoming, [{
      scope: '@acme/repertoire', state: 'missing',
    }], { manifestSha256: 'f'.repeat(64) });
    const plan = createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: incoming,
      previousLock: { state: 'absent' },
    });
    expect(plan.globalConflicts).toEqual(['INSPECTION_BINDING_MISMATCH']);
    expect(plan.dependencies[0]?.installedConflicts).toEqual([]);
  });

  it('preserves INVALID_AUTHORITY for forged, disposed, and reused claims', () => {
    const incoming = lock();
    const verified = inspectProjectTemplateRepertoireDependencies({
      request: {
        sourceDescriptorSha256: SOURCE_SHA,
        manifestSha256: MANIFEST_SHA,
        dependencies: incoming.dependencies,
        deadlineMs: Number.MAX_SAFE_INTEGER,
      },
      port: { inspect: () => ({ witnessSha256: 'd'.repeat(64), observations: [observation()] }) },
    });
    const forged = { inspection: verified };
    const disposed = claimProjectTemplateRepertoireDependencyInspectionForPlanning(verified);
    disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim(disposed);
    for (const inspectionClaim of [forged, disposed]) {
      expect(() => createProjectTemplateRepertoireDependencyPlan({
        inspectionClaim: inspectionClaim as never,
        incomingLock: incoming,
        previousLock: { state: 'absent' },
      })).toThrow(ProjectTemplateRepertoireDependencyInspectionError);
      expect(() => createProjectTemplateRepertoireDependencyPlan({
        inspectionClaim: inspectionClaim as never,
        incomingLock: incoming,
        previousLock: { state: 'absent' },
      })).toThrow(expect.objectContaining({ code: 'INVALID_AUTHORITY' }));
    }
  });

  it('rejects proxy/accessor option envelopes without invoking hooks', () => {
    const get = vi.fn();
    const incoming = lock();
    const planningClaim = claim(incoming);
    const accessor = { incomingLock: incoming, previousLock: { state: 'absent' } };
    Object.defineProperty(accessor, 'inspectionClaim', { enumerable: true, get });
    for (const options of [new Proxy({}, { get }), accessor]) {
      expect(() => createProjectTemplateRepertoireDependencyPlan(options as never))
        .toThrow();
    }
    expect(get).not.toHaveBeenCalled();
    expect(createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: incoming,
      previousLock: { state: 'absent' },
    }).schemaVersion).toBe('1.0');
  });

  it('rejects exact-shape violations before consuming authority', () => {
    const incoming = lock();
    const planningClaim = claim(incoming);
    for (const options of [
      {
        inspectionClaim: planningClaim,
        incomingLock: incoming,
        previousLock: { state: 'absent', content: 'unexpected' },
      },
      {
        inspectionClaim: planningClaim,
        incomingLock: { ...incoming, extra: true },
        previousLock: { state: 'absent' },
      },
    ]) {
      expect(() => createProjectTemplateRepertoireDependencyPlan(options as never))
        .toThrow();
    }
    expect(createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: planningClaim,
      incomingLock: incoming,
      previousLock: { state: 'absent' },
    }).schemaVersion).toBe('1.0');
  });

  it('does not call post-init mutable serialization or array callbacks', () => {
    const incoming = lock();
    const planningClaim = claim(incoming);
    const stringify = JSON.stringify;
    const map = Array.prototype.map;
    const iterator = Array.prototype[Symbol.iterator];
    let calls = 0;
    try {
      JSON.stringify = (() => {
        calls += 1;
        throw new Error('poisoned stringify');
      }) as typeof JSON.stringify;
      Array.prototype.map = (() => {
        calls += 1;
        throw new Error('poisoned map');
      }) as typeof Array.prototype.map;
      Array.prototype[Symbol.iterator] = (() => {
        calls += 1;
        throw new Error('poisoned iterator');
      }) as typeof Array.prototype[typeof Symbol.iterator];
      expect(createProjectTemplateRepertoireDependencyPlan({
        inspectionClaim: planningClaim,
        incomingLock: incoming,
        previousLock: { state: 'absent' },
      }).planId).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      JSON.stringify = stringify;
      Array.prototype.map = map;
      Array.prototype[Symbol.iterator] = iterator;
    }
    expect(calls).toBe(0);
  });

  it('domain-seals the complete deterministic review body', () => {
    const incoming = lock();
    const first = create(incoming);
    const second = create(incoming);
    const withPrevious = create(incoming, {
      state: 'present',
      content: serializeProjectTemplateRepertoireDependencyLock(incoming),
    });
    expect(first.planId).toBe(second.planId);
    expect(first.planId).not.toBe(withPrevious.planId);
    expect(calculateProjectTemplateRepertoireDependencyPlanId(first))
      .toBe(first.planId);
    expect(() => calculateProjectTemplateRepertoireDependencyPlanId({
      ...first,
    })).toThrow();
  });

  it('detaches every retained value from caller mutation', () => {
    const incoming = lock();
    const previous = { state: 'absent' };
    const plan = createProjectTemplateRepertoireDependencyPlan({
      inspectionClaim: claim(incoming),
      incomingLock: incoming,
      previousLock: previous,
    });
    incoming.dependencies[0]!.commit = 'f'.repeat(40);
    previous.state = 'unavailable';
    expect(plan.nextLock?.dependencies[0]?.commit).toBe(COMMIT);
    expect(plan.previousLockState).toBe('absent');
  });
});
