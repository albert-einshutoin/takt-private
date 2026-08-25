import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  inspectProjectTemplateRepertoireDependencies,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  serializeProjectTemplateRepertoireDependencyLock,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  createProjectTemplateRepertoireDependencyPlan,
} from '../../features/project-template/repertoire-dependency-plan.js';
import {
  renderProjectTemplateRepertoireDependencyPlanHuman,
  renderProjectTemplateRepertoireDependencyPlanJson,
} from '../../features/project-template/repertoire-dependency-preview.js';

const SOURCE_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function dependency(
  scope = '@acme/repertoire',
  overrides: Record<string, unknown> = {},
) {
  return {
    scope,
    version: '1.2.3',
    source: `github:${scope.slice(1)}@v1.2.3`,
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

function installed(
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

function plan(
  incoming = lock(),
  previousLock: Record<string, unknown> = { state: 'absent' },
  observations: readonly unknown[] = incoming.dependencies.map((item) =>
    installed((item as ReturnType<typeof dependency>).scope)),
  inspectionOverrides: Record<string, unknown> = {},
) {
  const inspection = inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256: MANIFEST_SHA,
      dependencies: incoming.dependencies,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      ...inspectionOverrides,
    },
    port: {
      inspect: () => ({ witnessSha256: 'd'.repeat(64), observations }),
    },
  });
  return createProjectTemplateRepertoireDependencyPlan({
    inspectionClaim:
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(inspection),
    incomingLock: incoming as never,
    previousLock: previousLock as never,
  });
}

function renderedJson(value: ReturnType<typeof plan>): Record<string, unknown> {
  return JSON.parse(
    renderProjectTemplateRepertoireDependencyPlanJson(value),
  ) as Record<string, unknown>;
}

describe('project template repertoire dependency sealed preview G4.3', () => {
  it('renders deterministic empty human and canonical JSON previews', () => {
    const value = plan(lock([]), { state: 'absent' }, []);
    const human = renderProjectTemplateRepertoireDependencyPlanHuman(value);
    const json = renderProjectTemplateRepertoireDependencyPlanJson(value);

    expect(human).toContain('add=0 update=0 keep=0 remove=0 unknown=0');
    expect(human).toContain('dependencies: <none>');
    expect(json).toBe(renderProjectTemplateRepertoireDependencyPlanJson(value));
    expect(JSON.stringify(JSON.parse(json))).toBe(json);
    expect(renderedJson(value)).toMatchObject({
      schemaVersion: '1.0',
      planId: value.planId,
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256: MANIFEST_SHA,
      declarationSha256: value.declarationSha256,
      previousLockState: 'absent',
      metadataChanges: [],
      globalConflicts: [],
      flags: {
        reviewRequired: false,
        hardConflict: false,
        defaultApplyPossible: true,
      },
      entries: [],
      nextLock: lock([]),
    });
  });

  it('renders add required and installed values with the full commit', () => {
    const value = plan();
    const human = renderProjectTemplateRepertoireDependencyPlanHuman(value);
    const json = renderedJson(value);
    expect(human).toContain('scope="@acme/repertoire" action=add');
    expect(human).toContain(`commit="${COMMIT}"`);
    expect(human).toContain('changes=["ADDED"]');
    expect(human).toContain('required: source="github:acme/repertoire" ref="v1.2.3"');
    expect(human).toContain('installed: state=installed source="github:acme/repertoire"');
    expect(json.entries).toEqual([expect.objectContaining({
      scope: '@acme/repertoire',
      action: 'add',
      changes: ['ADDED'],
      required: expect.objectContaining({ commit: COMMIT }),
      installed: expect.objectContaining({ commit: COMMIT }),
    })]);
  });

  it('renders update/remove/edit deltas in fixed plan order', () => {
    const previous = lock([
      dependency('@acme/alpha'),
      dependency('@acme/removed'),
    ]);
    const incoming = lock([
      dependency('@acme/alpha', {
        version: '2.0.0',
        source: 'github:acme/alpha@refs/tags/v2.0.0',
        commit: 'f'.repeat(40),
        capabilities: [],
      }),
    ]);
    const value = plan(
      incoming,
      {
        state: 'present',
        content: serializeProjectTemplateRepertoireDependencyLock(previous),
      },
      [installed('@acme/alpha', {
        ref: 'v2.0.0', version: '2.0.0', commit: 'f'.repeat(40), capabilities: [],
      })],
    );
    const human = renderProjectTemplateRepertoireDependencyPlanHuman(value);
    const json = renderedJson(value);
    expect(human).toContain('EDIT_CAPABILITY_REMOVED');
    expect(human.indexOf('scope="@acme/alpha"'))
      .toBeLessThan(human.indexOf('scope="@acme/removed"'));
    expect(json.entries).toEqual([
      expect.objectContaining({
        scope: '@acme/alpha',
        action: 'update',
        changes: [
          'SOURCE_CHANGED',
          'VERSION_CHANGED',
          'COMMIT_CHANGED',
          'EDIT_CAPABILITY_REMOVED',
        ],
      }),
      expect.objectContaining({
        scope: '@acme/removed', action: 'remove', changes: ['REMOVED'],
      }),
    ]);
  });

  it('renders edit addition and every installed conflict in fixed order', () => {
    const previous = lock([dependency('@acme/repertoire', { capabilities: [] })]);
    const incoming = lock();
    const value = plan(
      incoming,
      {
        state: 'present',
        content: serializeProjectTemplateRepertoireDependencyLock(previous),
      },
      [installed('@acme/repertoire', {
        source: 'github:other/repertoire',
        ref: '1.2.3',
        version: '2.0.0',
        commit: 'f'.repeat(40),
        capabilities: [],
      })],
    );
    const json = renderedJson(value) as {
      entries: Array<{ changes: string[]; installedConflicts: string[] }>;
    };
    expect(json.entries[0]?.changes).toEqual(['EDIT_CAPABILITY_ADDED']);
    expect(json.entries[0]?.installedConflicts).toEqual([
      'SOURCE_MISMATCH',
      'REF_MISMATCH',
      'VERSION_MISMATCH',
      'COMMIT_MISMATCH',
      'CAPABILITY_MISMATCH',
    ]);
  });

  it('renders metadata, global, unknown, and installed conflicts', () => {
    const incoming = lock();
    const headerPrevious = lock([dependency()], {
      sourceDescriptorSha256: 'e'.repeat(64),
      manifestSha256: 'f'.repeat(64),
    });
    const metadata = plan(incoming, {
      state: 'present',
      content: serializeProjectTemplateRepertoireDependencyLock(headerPrevious),
    }, [{ scope: '@acme/repertoire', state: 'missing' }]);
    const metadataHuman = renderProjectTemplateRepertoireDependencyPlanHuman(metadata);
    expect(metadataHuman).toContain('SOURCE_DESCRIPTOR_SHA256_CHANGED');
    expect(metadataHuman).toContain('MANIFEST_SHA256_CHANGED');
    expect(metadataHuman).toContain('NOT_INSTALLED');

    const invalidPrevious = plan(incoming, {
      state: 'present', content: '{',
    });
    const json = renderedJson(invalidPrevious);
    expect(json.globalConflicts).toEqual(['PREVIOUS_LOCK_INVALID']);
    expect(json.entries).toEqual([
      expect.objectContaining({ scope: '@acme/repertoire', action: 'unknown' }),
    ]);
  });

  it('keeps human and JSON summary/flag review fields in parity', () => {
    const value = plan();
    const human = renderProjectTemplateRepertoireDependencyPlanHuman(value);
    const json = renderedJson(value) as {
      summary: { counts: Record<string, number> };
      flags: Record<string, boolean>;
    };
    for (const action of ['add', 'update', 'keep', 'remove', 'unknown']) {
      expect(human).toContain(`${action}=${json.summary.counts[action]}`);
    }
    for (const flag of ['reviewRequired', 'hardConflict', 'defaultApplyPossible']) {
      expect(human).toContain(`${flag}=${String(json.flags[flag])}`);
    }
  });

  it('does not expose opaque inspection or non-review evidence', () => {
    const value = plan();
    const output = renderProjectTemplateRepertoireDependencyPlanHuman(value)
      + renderProjectTemplateRepertoireDependencyPlanJson(value);
    expect(output).not.toContain(value.preconditionToken);
    expect(output).not.toContain('preconditionToken');
    expect(output).not.toContain('witness');
    expect(output).not.toContain('accessLog');
    expect(output).not.toContain('/Users/');
    expect(output).not.toContain('credential');
  });

  it('rejects clones, planId tampering, cross-realm values, proxies, and accessors', () => {
    const value = plan();
    const get = vi.fn();
    const accessor = {};
    Object.defineProperty(accessor, 'planId', { get });
    const injected = {
      ...value,
      dependencies: [{
        ...value.dependencies[0],
        scope: '@evil/secret\n/Users/private/token=credential',
      }],
    };
    for (const forged of [
      { ...value },
      { ...value, planId: 'f'.repeat(64) },
      injected,
      runInNewContext('({ planId: "a".repeat(64) })'),
      new Proxy({}, { get }),
      accessor,
    ]) {
      expect(() => renderProjectTemplateRepertoireDependencyPlanHuman(forged as never))
        .toThrow();
      expect(() => renderProjectTemplateRepertoireDependencyPlanJson(forged as never))
        .toThrow();
    }
    expect(get).not.toHaveBeenCalled();
    expect(() => renderProjectTemplateRepertoireDependencyPlanJson(injected as never))
      .toThrow();
  });

  it('does not invoke post-init stringify, toJSON, iterator, or coercion hooks', () => {
    const value = plan();
    const expectedHuman = renderProjectTemplateRepertoireDependencyPlanHuman(value);
    const expectedJson = renderProjectTemplateRepertoireDependencyPlanJson(value);
    const stringify = JSON.stringify;
    const iterator = Array.prototype[Symbol.iterator];
    const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const string = globalThis.String;
    let calls = 0;
    try {
      JSON.stringify = (() => { calls += 1; throw new Error('stringify'); }) as typeof JSON.stringify;
      Array.prototype[Symbol.iterator] = (() => {
        calls += 1;
        throw new Error('iterator');
      }) as typeof Array.prototype[typeof Symbol.iterator];
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true, value: () => { calls += 1; throw new Error('toJSON'); },
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true, value: () => { calls += 1; throw new Error('toJSON'); },
      });
      globalThis.String = (() => {
        calls += 1;
        throw new Error('coercion');
      }) as StringConstructor;
      expect(renderProjectTemplateRepertoireDependencyPlanHuman(value))
        .toBe(expectedHuman);
      expect(renderProjectTemplateRepertoireDependencyPlanJson(value))
        .toBe(expectedJson);
    } finally {
      JSON.stringify = stringify;
      Array.prototype[Symbol.iterator] = iterator;
      if (objectToJson === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, 'toJSON', objectToJson);
      if (arrayToJson === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, 'toJSON', arrayToJson);
      globalThis.String = string;
    }
    expect(calls).toBe(0);
  });
});
