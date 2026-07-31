import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProjectTemplateRepertoireCapabilitySnapshot,
  getProjectTemplateRepertoireCapabilityFileAccess,
  PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT,
  revalidateProjectTemplateRepertoireCapabilitySnapshot,
} from '../../infra/repertoire/project-template-repertoire-capability-snapshot.js';
import {
  createProjectTemplateRepertoireSafeReadContext,
} from '../../infra/repertoire/project-template-repertoire-safe-read.js';
import { resolveProviderOptionsByName } from '../../infra/config/loaders/providerOptionsLookupDirectories.js';

const roots: string[] = [];
const FUTURE_DEADLINE_MS = performance.now() + 5 * 60_000;

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-capability-snapshot-'));
  roots.push(value);
  return value;
}

function write(path: string, text: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('project template repertoire capability snapshot G3.3.2', () => {
  it('captures nested workflow and provider YAML in canonical order', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'z.yml'), 'steps: []\n');
    write(join(pkg, 'workflows', 'nested', 'a.yaml'), 'steps: []\n');
    write(join(pkg, 'provider-options', 'edit.yaml'), '{}\n');
    write(join(pkg, 'workflows', 'nested', 'provider-options', 'local.yml'), '{}\n');
    write(join(pkg, 'workflows', 'ignored.md'), 'ignore');

    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
    });

    expect(snapshot.workflowFiles.map((file) => file.relativePath)).toEqual([
      'workflows/nested/a.yaml',
      'workflows/z.yml',
    ]);
    expect(snapshot.providerOptionsFiles.map((file) => file.relativePath))
      .toEqual([
        'provider-options/edit.yaml',
        'workflows/nested/provider-options/local.yml',
      ]);
    expect(Reflect.ownKeys(snapshot)).not.toContain('revalidate');
    expect(JSON.stringify(snapshot)).not.toContain(repertoire);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('never silently skips invalid YAML or a YAML symlink', () => {
    const repertoire = root();
    const outside = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'invalid.yaml'), 'steps: invalid\n');
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
    })).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));

    rmSync(join(pkg, 'workflows', 'invalid.yaml'));
    write(join(outside, 'secret.yaml'), '{}\n');
    symlinkSync(
      join(outside, 'secret.yaml'),
      join(pkg, 'workflows', 'linked.yaml'),
    );
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
    })).toThrow(expect.objectContaining({ code: 'UNSAFE_INPUT' }));
  });

  it('builds a closed memory registry with deterministic layer precedence', () => {
    const repertoire = root();
    const project = root();
    const global = root();
    const builtin = root();
    const other = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'provider-options', 'same.yaml'), 'model: package\n');
    write(join(project, 'same.yaml'), 'model: project-yaml\n');
    write(join(project, 'same.yml'), 'model: project-yml\n');
    write(join(global, 'same.yaml'), 'model: global\n');
    write(join(builtin, 'same.yaml'), 'model: builtin\n');
    write(join(other, 'scoped.yml'), 'model: scoped\n');
    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      approvedLayers: [
        { role: 'project', root: project },
        { role: 'global', root: global },
        { role: 'builtin', root: builtin },
        { role: 'scoped', root: other, scope: '@other/tools' },
      ],
    });
    const access = getProjectTemplateRepertoireCapabilityFileAccess(snapshot);
    const packageFile = `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options/same.yaml`;
    expect(access.readText(packageFile)).toBe('model: package\n');
    expect(snapshot.providerOptionsCandidateDirs.map(String)).toEqual([
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options`,
      '/__takt_capability_snapshot__/project/provider-options',
      '/__takt_capability_snapshot__/global/provider-options',
      '/__takt_capability_snapshot__/builtin/provider-options',
    ]);
    expect(access.exists('/__takt_capability_snapshot__/project/provider-options/same.yaml')).toBe(true);
    expect(resolveProviderOptionsByName(
      'same',
      snapshot.providerOptionsCandidateDirs,
      access,
    )?.path).toBe(
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options/same.yaml`,
    );
    expect(resolveProviderOptionsByName(
      'same',
      snapshot.providerOptionsCandidateDirs.slice(1),
      access,
    )?.path).toBe(
      '/__takt_capability_snapshot__/project/provider-options/same.yaml',
    );
    expect(access.exists('/__takt_capability_snapshot__/project/provider-options/missing.yaml')).toBe(false);
    expect(access.readText('/__takt_capability_snapshot__/repertoire/@other/tools/provider-options/scoped.yml'))
      .toBe('model: scoped\n');
    expect(() => access.exists('/unknown/file.yaml')).toThrow(
      expect.objectContaining({ code: 'OUTSIDE_REGISTRY' }),
    );
    for (const path of [
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/facets/unknown.yaml`,
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options/../secret.yaml`,
    ]) {
      expect(() => access.exists(path)).toThrow(
        expect.objectContaining({ code: 'OUTSIDE_REGISTRY' }),
      );
    }
  });

  it('detects deterministic file and directory mutations on final revalidation', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'review.yaml'), 'steps: []\n');
    const input = {
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review' as const,
      deadlineMs: FUTURE_DEADLINE_MS,
    };
    const first = captureProjectTemplateRepertoireCapabilitySnapshot(input);
    const second = captureProjectTemplateRepertoireCapabilitySnapshot(input);
    expect(first.privateWitnessFragment).toBe(second.privateWitnessFragment);
    expect(() => revalidateProjectTemplateRepertoireCapabilitySnapshot(
      first,
      { deadlineMs: FUTURE_DEADLINE_MS },
    )).not.toThrow();
    write(join(pkg, 'workflows', 'review.yaml'), 'steps:\n  - edit: true\n');
    expect(() => revalidateProjectTemplateRepertoireCapabilitySnapshot(
      first,
      { deadlineMs: FUTURE_DEADLINE_MS },
    )).toThrow(expect.objectContaining({ code: 'CHANGED' }));
  });

  it('enforces abort, deadline, file and byte accounting seams', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'one.yaml'), 'steps: []\n');
    write(join(pkg, 'workflows', 'two.yaml'), 'steps: []\n');
    const context = createProjectTemplateRepertoireSafeReadContext(repertoire);
    const aborted = new AbortController();
    aborted.abort();
    for (const request of [
      { signal: aborted.signal, deadlineMs: FUTURE_DEADLINE_MS },
      { deadlineMs: 0 },
    ]) {
      expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
        repertoireContext: context,
        packageRelativePath: '@acme/review',
        scope: '@acme/review',
        ...request,
      })).toThrow(expect.objectContaining({
        code: request.signal ? 'ABORTED' : 'TIMEOUT',
      }));
    }
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      budgetSeam: { maxPackageFiles: 1 },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      budgetSeam: { maxBytes: 1 },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    let completedFileReads = 0;
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      requestFileCount: 4096,
      budgetSeam: { maxRequestFiles: 4096 },
      ioSeam(phase) {
        if (phase === 'after-file') completedFileReads += 1;
      },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(completedFileReads).toBe(0);
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      budgetSeam: { maxEntries: 8192, initialEntries: 8192 },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('fails before traversing a depth-33 child', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    let directory = join(pkg, 'workflows');
    for (let depth = 0; depth < 31; depth += 1) {
      directory = join(directory, `d${String(depth).padStart(2, '0')}`);
    }
    write(join(directory, 'too-deep.yaml'), 'steps: []\n');
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      budgetSeam: { maxDepth: 40 },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('records approved missing roots and revalidates nearest-parent absence', () => {
    const repertoire = root();
    const layerParent = root();
    const missing = join(layerParent, 'future-provider-options');
    const pkg = join(repertoire, '@acme', 'review');
    mkdirSync(pkg, { recursive: true });
    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      approvedLayers: [{ role: 'project', root: missing }],
    });
    const access = getProjectTemplateRepertoireCapabilityFileAccess(snapshot);
    expect(access.exists(
      '/__takt_capability_snapshot__/project/provider-options/review.yaml',
    )).toBe(false);
    expect(() => revalidateProjectTemplateRepertoireCapabilitySnapshot(
      snapshot,
      { deadlineMs: FUTURE_DEADLINE_MS },
    )).not.toThrow();
    mkdirSync(missing);
    expect(() => revalidateProjectTemplateRepertoireCapabilitySnapshot(
      snapshot,
      { deadlineMs: FUTURE_DEADLINE_MS },
    )).toThrow(expect.objectContaining({ code: 'CHANGED' }));
  });

  it('uses fixed layer order and never calls the capture seam on revalidation', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    const project = root();
    const builtin = root();
    write(join(pkg, 'workflows', 'review.yaml'), 'steps: []\n');
    write(join(project, 'review.yaml'), '{}\n');
    write(join(builtin, 'review.yaml'), '{}\n');
    let seamCalls = 0;
    const context = createProjectTemplateRepertoireSafeReadContext(
      repertoire,
      () => {
        seamCalls += 1;
      },
    );
    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      approvedLayers: [
        { role: 'builtin', root: builtin },
        { role: 'project', root: project },
      ],
    });
    expect(snapshot.providerOptionsCandidateDirs).toEqual([
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options`,
      '/__takt_capability_snapshot__/project/provider-options',
      '/__takt_capability_snapshot__/builtin/provider-options',
    ]);
    expect(seamCalls).toBeGreaterThan(0);
    seamCalls = 0;
    revalidateProjectTemplateRepertoireCapabilitySnapshot(snapshot, {
      deadlineMs: FUTURE_DEADLINE_MS,
    });
    expect(seamCalls).toBe(0);
  });

  it('fails reentry closed, redacts hostile input, and uses captured primitives', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'review.yaml'), 'steps: []\n');
    const base = {
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review' as const,
      deadlineMs: FUTURE_DEADLINE_MS,
    };
    let nested: unknown;
    let attempted = false;
    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      ...base,
      ioSeam() {
        if (attempted) return;
        attempted = true;
        try {
          captureProjectTemplateRepertoireCapabilitySnapshot(base);
        } catch (error) {
          nested = error;
        }
      },
    });
    expect(snapshot.workflowFiles).toHaveLength(1);
    expect(nested).toMatchObject({ code: 'UNSAFE_INPUT' });

    const originals = {
      arrayIncludes: Array.prototype.includes,
      arrayJoin: Array.prototype.join,
      arraySort: Array.prototype.sort,
      stringIncludes: String.prototype.includes,
      stringStartsWith: String.prototype.startsWith,
      regexpTest: RegExp.prototype.test,
    };
    let poisoned = false;
    try {
      const poison = () => {
        throw new Error('secret poisoned primitive');
      };
      const poisonedCapture = captureProjectTemplateRepertoireCapabilitySnapshot({
        ...base,
        ioSeam(phase) {
          if (phase !== 'after-file' || poisoned) return;
          poisoned = true;
          Array.prototype.includes = poison as typeof Array.prototype.includes;
          Array.prototype.join = poison as typeof Array.prototype.join;
          Array.prototype.sort = poison as typeof Array.prototype.sort;
          String.prototype.includes = poison as typeof String.prototype.includes;
          String.prototype.startsWith = poison as typeof String.prototype.startsWith;
          RegExp.prototype.test = poison;
        },
      });
      expect(poisonedCapture.privateWitnessFragment).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      Array.prototype.includes = originals.arrayIncludes;
      Array.prototype.join = originals.arrayJoin;
      Array.prototype.sort = originals.arraySort;
      String.prototype.includes = originals.stringIncludes;
      String.prototype.startsWith = originals.stringStartsWith;
      RegExp.prototype.test = originals.regexpTest;
    }

    const secret = 'secret hostile accessor';
    const hostile = Object.defineProperty({}, 'scope', {
      get() {
        throw new Error(secret);
      },
    });
    let thrown: unknown;
    try {
      captureProjectTemplateRepertoireCapabilitySnapshot(
        hostile as never,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String(thrown)).not.toContain(secret);
    expect((thrown as Error).cause).toBeUndefined();
    expect(captureProjectTemplateRepertoireCapabilitySnapshot(base)
      .workflowFiles).toHaveLength(1);
  });

  it('binds the canonical scope to the package path before private reads', () => {
    const repertoire = root();
    write(
      join(repertoire, '@other', 'secret', 'workflows', 'secret.yaml'),
      'steps: []\n',
    );
    let privateReads = 0;
    const context = createProjectTemplateRepertoireSafeReadContext(
      repertoire,
      () => {
        privateReads += 1;
      },
    );
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@other/secret',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
    })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(privateReads).toBe(0);
  });

  it('requires an exact, finite and branded capture DTO before private reads', () => {
    const repertoire = root();
    mkdirSync(join(repertoire, '@acme', 'review'), { recursive: true });
    let privateReads = 0;
    const base = {
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
        () => {
          privateReads += 1;
        },
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review' as const,
      deadlineMs: FUTURE_DEADLINE_MS,
    };
    const symbol = Symbol('extra');
    for (const input of [
      { ...base, extra: true },
      Object.assign({ ...base }, { [symbol]: true }),
      new Proxy({ ...base }, {}),
      { ...base, deadlineMs: Number.POSITIVE_INFINITY },
      { ...base, signal: { aborted: false } },
    ]) {
      expect(() => captureProjectTemplateRepertoireCapabilitySnapshot(
        input as never,
      )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(privateReads).toBe(0);
  });

  it('requires an exact, finite and branded revalidation DTO', () => {
    const repertoire = root();
    mkdirSync(join(repertoire, '@acme', 'review'), { recursive: true });
    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
    });
    const symbol = Symbol('extra');
    for (const input of [
      { deadlineMs: FUTURE_DEADLINE_MS, extra: true },
      { deadlineMs: Number.POSITIVE_INFINITY },
      { deadlineMs: -1 },
      { deadlineMs: FUTURE_DEADLINE_MS, signal: { aborted: false } },
      Object.assign({ deadlineMs: FUTURE_DEADLINE_MS }, { [symbol]: true }),
      new Proxy({ deadlineMs: FUTURE_DEADLINE_MS }, {}),
    ]) {
      expect(() => revalidateProjectTemplateRepertoireCapabilitySnapshot(
        snapshot,
        input as never,
      )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    const secret = 'secret revalidate accessor';
    const accessor = Object.defineProperty({}, 'deadlineMs', {
      get() {
        throw new Error(secret);
      },
    });
    let thrown: unknown;
    try {
      revalidateProjectTemplateRepertoireCapabilitySnapshot(
        snapshot,
        accessor as never,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String(thrown)).not.toContain(secret);
    expect((thrown as Error).cause).toBeUndefined();
  });

  it('rejects malformed or unbounded approved layer DTOs before IO', () => {
    const repertoire = root();
    mkdirSync(join(repertoire, '@acme', 'review'), { recursive: true });
    let io = 0;
    const base = {
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
        () => {
          io += 1;
        },
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review' as const,
      deadlineMs: FUTURE_DEADLINE_MS,
    };
    const secret = 'secret layer root';
    const accessor = Object.defineProperty({ role: 'project' }, 'root', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const symbol = Symbol('extra');
    const tooMany = Array.from({ length: 132 }, (_, index) => ({
      role: 'scoped' as const,
      root: `/missing/${index}`,
      scope: `@owner/package-${index}` as `@${string}/${string}`,
    }));
    for (const approvedLayers of [
      [accessor],
      [Object.assign({ role: 'project', root: '/missing' }, { extra: true })],
      [Object.assign({ role: 'project', root: '/missing' }, { [symbol]: true })],
      Array(1),
      tooMany,
      new Proxy([], {}),
    ]) {
      io = 0;
      let thrown: unknown;
      try {
        captureProjectTemplateRepertoireCapabilitySnapshot({
          ...base,
          approvedLayers: approvedLayers as never,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(String(thrown)).not.toContain(secret);
      expect(io).toBe(0);
    }
  });

  it('keeps all budget seams below hard production ceilings', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'review.yaml'), 'steps: []\n');
    const context = createProjectTemplateRepertoireSafeReadContext(repertoire);
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      requestFileCount: 4096,
      budgetSeam: { maxRequestFiles: 5000 },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      budgetSeam: {
        maxEntries: 9000,
        initialEntries: 8192,
      },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));

    const nested = join(pkg, 'workflows', 'nested');
    write(join(nested, 'review.yaml'), 'steps: []\n');
    expect(() => captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: context,
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
      budgetSeam: { maxDepth: 1 },
    })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('does not grant provider file authority to workflow YAML', () => {
    const repertoire = root();
    const pkg = join(repertoire, '@acme', 'review');
    write(join(pkg, 'workflows', 'secret.yaml'), 'steps: []\n');
    write(join(pkg, 'provider-options', 'review.yaml'), '{}\n');
    const snapshot = captureProjectTemplateRepertoireCapabilitySnapshot({
      repertoireContext: createProjectTemplateRepertoireSafeReadContext(
        repertoire,
      ),
      packageRelativePath: '@acme/review',
      scope: '@acme/review',
      deadlineMs: FUTURE_DEADLINE_MS,
    });
    const access = getProjectTemplateRepertoireCapabilityFileAccess(snapshot);
    expect(access.readText(
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/provider-options/review.yaml`,
    )).toBe('{}\n');
    expect(() => access.readText(
      `${PROJECT_TEMPLATE_REPERTOIRE_PACKAGE_VIRTUAL_ROOT}/workflows/secret.yaml`,
    )).toThrow(expect.objectContaining({ code: 'OUTSIDE_REGISTRY' }));
  });
});
