import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  validateManifestLockPair,
} from '../../features/project-template/index.js';
import { TEMPLATE_CAPABILITIES } from '../../features/project-template/validation.js';

const roots: string[] = [];
const source = {
  kind: 'local' as const,
  uri: '.',
  ref: 'workspace' as const,
  commit: 'a'.repeat(40),
};

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-plan-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, '.takt', relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

async function withPoisonedArrayNumericSetters<T>(run: () => Promise<T>): Promise<T> {
  const keys = ['0', '1', '2'] as const;
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(Array.prototype, key));
  const defineProperty = Object.defineProperty;
  try {
    for (const key of keys) {
      Object.defineProperty(Array.prototype, key, {
        configurable: true,
        set(value: unknown) {
          if (typeof value === 'boolean') return;
          defineProperty(this, key, {
            configurable: true, enumerable: true, value, writable: true,
          });
        },
      });
    }
    return await run();
  } finally {
    for (let index = 0; index < keys.length; index += 1) {
      const original = originals[index];
      if (original === undefined) delete (Array.prototype as unknown as Record<string, unknown>)[keys[index]];
      else Object.defineProperty(Array.prototype, keys[index], original);
    }
  }
}

async function withPoisonedTypedArrayLength<T>(run: () => Promise<T>): Promise<T> {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(prototype, 'length')!;
  const byteLengthDescriptor = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!;
  Object.defineProperty(prototype, 'length', {
    ...lengthDescriptor,
    get(this: Uint8Array) {
      const bytes = byteLengthDescriptor.get!.call(this) as number;
      return Object.getPrototypeOf(this) === Uint8Array.prototype && bytes <= 2
        ? 0 : lengthDescriptor.get!.call(this) as number;
    },
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(prototype, 'length', lengthDescriptor);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template export plan', () => {
  it('builds a manifest, lock, file plan, and redacted exclusion counts', async () => {
    const root = makeProject({
      'workflows/review.yaml': 'name: review\n',
      'tasks.yaml': 'private runtime task',
    });

    const plan = await createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    });

    expect(plan.manifest.entries).toEqual([
      expect.objectContaining({
        path: 'workflows/review.yaml',
        policy: 'merge',
        mode: '0644',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect((plan as unknown as Record<string, unknown>)['files']).toBeUndefined();
    expect(plan.report).toMatchObject({
      counts: { managed: 0, merge: 1, scaffold: 0, excluded: 1 },
      excludedReasons: { RUNTIME_STATE: 1 },
      warnings: [],
    });
    expect(Object.isFrozen(plan.report.warnings)).toBe(true);
    expect(JSON.stringify(plan.report)).not.toContain(root);
    expect(JSON.stringify(plan)).not.toContain(root);
    expect(() => validateManifestLockPair(plan.manifest, plan.lock)).not.toThrow();
  });

  it('fails closed when the scan contains a sensitive file', async () => {
    const root = makeProject({
      'workflows/review.yaml': 'name: review\n',
      '.env': 'TOKEN=secret',
    });

    await expect(createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    })).rejects.toMatchObject({ code: 'INVALID_EXPORT_PLAN' });
  });

  it('requires explicit approval for detected capabilities', async () => {
    const root = makeProject({
      'workflows/release.yaml': 'steps:\n  - run: npm test\n',
    });
    const options = {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    };

    await expect(createProjectTemplateExportPlan(root, options))
      .rejects.toMatchObject({ code: 'EXPORT_REVIEW_REQUIRED' });

    const approved = await createProjectTemplateExportPlan(root, {
      ...options,
      approvedCapabilities: ['external-command'],
    });
    expect(approved.manifest.capabilities).toEqual(['external-command']);
    expect(approved.manifest.entries[0]?.capabilities).toEqual(['external-command']);
  });

  it('does not consume a live capability iterator or poisoned includes', async () => {
    const root = makeProject({
      'workflows/release.yaml': 'steps:\n  - run: npm test\n',
    });
    const approvedCapabilities: string[] = [];
    const originalIterator = Array.prototype[Symbol.iterator];
    const originalIncludes = Array.prototype.includes;
    let outcome: unknown;
    try {
      Array.prototype[Symbol.iterator] = function iterator() {
        return this === approvedCapabilities
          ? originalIterator.call(['external-command'])
          : originalIterator.call(this);
      };
      Array.prototype.includes = function includes(value, fromIndex) {
        return this === TEMPLATE_CAPABILITIES
          ? true
          : originalIncludes.call(this, value, fromIndex);
      };
      outcome = await createProjectTemplateExportPlan(root, {
        packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source,
        approvedCapabilities: approvedCapabilities as never,
      }).catch((error: unknown) => error);
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
      Array.prototype.includes = originalIncludes;
    }
    expect(outcome).toMatchObject({ code: 'EXPORT_REVIEW_REQUIRED' });
  });

  it.each([
    ['duplicate', ['external-command', 'external-command']],
    ['unknown', ['credential']],
    ['unused', ['external-command', 'github-write']],
  ] as const)('rejects %s capability approvals', async (_label, approvedCapabilities) => {
    const root = makeProject({
      'workflows/release.yaml': 'steps:\n  - run: npm test\n',
    });
    await expect(createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source,
      approvedCapabilities: approvedCapabilities as never,
    })).rejects.toMatchObject({
      code: 'INVALID_EXPORT_PLAN', field: 'approvedCapabilities',
    });
  });

  it('requires an explicit policy for project-owned configuration', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });
    const options = {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    };

    await expect(createProjectTemplateExportPlan(root, options))
      .rejects.toMatchObject({ code: 'EXPORT_REVIEW_REQUIRED' });

    const approved = await createProjectTemplateExportPlan(root, {
      ...options,
      policies: { 'config.yaml': 'managed' },
    });
    expect(approved.manifest.entries[0]?.policy).toBe('managed');
  });

  it('does not reinterpret a public policy object through poisoned Object globals', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });
    const policies = {};
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    const originalSymbols = Object.getOwnPropertySymbols;
    const originalEntries = Object.entries;
    let outcome: unknown;
    try {
      Object.getOwnPropertyDescriptors = ((value: object) => value === policies
        ? { 'config.yaml': { configurable: true, enumerable: true, value: 'managed', writable: true } }
        : originalDescriptors(value)) as typeof Object.getOwnPropertyDescriptors;
      Object.getOwnPropertySymbols = ((value: object) => value === policies
        ? [] : originalSymbols(value)) as typeof Object.getOwnPropertySymbols;
      Object.entries = ((value: object) => value === policies
        ? [['config.yaml', { value: 'managed' }]]
        : originalEntries(value)) as typeof Object.entries;
      outcome = await createProjectTemplateExportPlan(root, {
        packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source, policies,
      }).catch((error: unknown) => error);
    } finally {
      Object.getOwnPropertyDescriptors = originalDescriptors;
      Object.getOwnPropertySymbols = originalSymbols;
      Object.entries = originalEntries;
    }
    expect(outcome).toMatchObject({ code: 'EXPORT_REVIEW_REQUIRED' });
  });

  it('matches a large reverse-ordered policy set through canonical lookup', async () => {
    const files: Record<string, string> = {};
    const policies: Record<string, 'merge'> = {};
    for (let index = 255; index >= 0; index -= 1) {
      const path = `workflows/review-${String(index).padStart(3, '0')}.yaml`;
      files[path] = 'name: review\n';
      policies[path] = 'merge';
    }
    const root = makeProject(files);
    const plan = await createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source, policies,
    });
    expect(plan.manifest.entries).toHaveLength(256);
    expect(plan.manifest.entries[0]?.path).toBe('workflows/review-000.yaml');
    expect(plan.manifest.entries[255]?.path).toBe('workflows/review-255.yaml');
  });

  it('rejects an unknown policy under Array prototype numeric setter poisoning', async () => {
    const root = makeProject({ 'workflows/review.yaml': 'name: review\n' });
    const outcome = await withPoisonedArrayNumericSetters(() => (
      createProjectTemplateExportPlan(root, {
        packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source,
        policies: { 'missing.yaml': 'managed' },
      }).catch((error: unknown) => error)
    ));
    expect(outcome).toMatchObject({
      code: 'INVALID_EXPORT_PLAN', field: 'policies',
    });
  });

  it('rejects an unused capability under Array prototype numeric setter poisoning', async () => {
    const root = makeProject({
      'workflows/release.yaml': 'steps:\n  - run: npm test\n',
    });
    const outcome = await withPoisonedArrayNumericSetters(() => (
      createProjectTemplateExportPlan(root, {
        packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source,
        approvedCapabilities: ['external-command', 'github-write'],
      }).catch((error: unknown) => error)
    ));
    expect(outcome).toMatchObject({
      code: 'INVALID_EXPORT_PLAN', field: 'approvedCapabilities',
    });
  });

  it('rejects an unknown policy under TypedArray length getter poisoning', async () => {
    const root = makeProject({ 'workflows/review.yaml': 'name: review\n' });
    const outcome = await withPoisonedTypedArrayLength(() => (
      createProjectTemplateExportPlan(root, {
        packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source,
        policies: { 'missing.yaml': 'managed' },
      }).catch((error: unknown) => error)
    ));
    expect(outcome).toMatchObject({
      code: 'INVALID_EXPORT_PLAN', field: 'policies',
    });
  });

  it('rejects an unused capability under TypedArray length getter poisoning', async () => {
    const root = makeProject({
      'workflows/release.yaml': 'steps:\n  - run: npm test\n',
    });
    const outcome = await withPoisonedTypedArrayLength(() => (
      createProjectTemplateExportPlan(root, {
        packVersion: '1.0.0', takt: { minVersion: '0.48.0' }, source,
        approvedCapabilities: ['external-command', 'github-write'],
      }).catch((error: unknown) => error)
    ));
    expect(outcome).toMatchObject({
      code: 'INVALID_EXPORT_PLAN', field: 'approvedCapabilities',
    });
  });

  it('does not treat an inherited policy as explicit approval', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });
    const inheritedPolicies = Object.create({
      'config.yaml': 'managed',
    }) as Record<string, 'managed'>;

    await expect(createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      policies: inheritedPolicies,
    })).rejects.toMatchObject({
      code: 'INVALID_EXPORT_PLAN',
      field: 'policies',
    });
  });

  it('rejects policy accessors without invoking them', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });
    let getterCalls = 0;
    const policies = Object.defineProperty({}, 'config.yaml', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'managed';
      },
    }) as Record<string, 'managed'>;

    await expect(createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      policies,
    })).rejects.toMatchObject({
      code: 'INVALID_EXPORT_PLAN',
      field: 'policies',
    });
    expect(getterCalls).toBe(0);
  });

  it('accepts an own policy in a null-prototype dictionary', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });
    const policies = Object.create(null) as Record<string, 'managed'>;
    policies['config.yaml'] = 'managed';

    const plan = await createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      policies,
    });

    expect(plan.manifest.entries[0]?.policy).toBe('managed');
  });

  it('rejects an invalid runtime policy before building counts', async () => {
    const root = makeProject({ 'config.yaml': 'language: ja\n' });

    await expect(createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      policies: { 'config.yaml': 'excluded' } as unknown as Record<string, 'managed'>,
    })).rejects.toMatchObject({
      code: 'INVALID_EXPORT_PLAN',
      field: 'policies',
    });
  });

  it('redacts unknown policy keys and hostile path markers from errors', async () => {
    const root = makeProject({ 'workflows/review.yaml': 'name: review\n' });
    const marker = 'TOKEN_MARKER_ABC';

    const error = await createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      policies: { [`workflows/${marker}.yaml`]: 'managed' },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'INVALID_EXPORT_PLAN', field: 'policies' });
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(root);
  });

  it('deep-freezes every public plan branch', async () => {
    const root = makeProject({ 'workflows/review.yaml': 'name: review\n' });
    const plan = await createProjectTemplateExportPlan(root, {
      packVersion: '1.0.0',
      takt: { minVersion: '0.48.0' },
      source,
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.manifest)).toBe(true);
    expect(Object.isFrozen(plan.manifest.entries)).toBe(true);
    expect(Object.isFrozen(plan.manifest.entries[0])).toBe(true);
    expect(Object.isFrozen(plan.lock)).toBe(true);
    expect(Object.isFrozen(plan.report)).toBe(true);
    expect(Reflect.set(plan.report.counts, 'merge', 99)).toBe(false);
  });
});
