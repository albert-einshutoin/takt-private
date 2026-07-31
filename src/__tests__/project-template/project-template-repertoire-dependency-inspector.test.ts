import {
  Dir,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectProjectTemplateRepertoireDependencies,
  ProjectTemplateRepertoireDependencyInspectionError,
  type ProjectTemplateRepertoireDependencyInspectionRequest,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  createProjectTemplateInstalledRepertoireDependencyInspectionPort,
} from '../../infra/repertoire/project-template-repertoire-dependency-inspector.js';

const roots: string[] = [];
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-installed-inspector-'));
  roots.push(value);
  return value;
}

function openDescriptorCount(): number | undefined {
  for (const fdPath of ['/dev/fd', '/proc/self/fd']) {
    try {
      return readdirSync(fdPath).length;
    } catch {
      // Continue to the next platform-specific process descriptor view.
    }
  }
  return undefined;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { force: true, recursive: true });
  }
});

function dependency(
  scope = '@acme/repertoire',
  version = '1.2.3',
) {
  return {
    scope: scope as `@${string}/${string}`,
    version,
    source: `github:${scope.slice(1)}@v${version}` as const,
    commit: COMMIT,
    capabilities: ['edit'] as const,
  };
}

function request(
  dependencies = [dependency()],
  overrides: Partial<ProjectTemplateRepertoireDependencyInspectionRequest> = {},
): ProjectTemplateRepertoireDependencyInspectionRequest {
  return {
    sourceDescriptorSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    dependencies,
    deadlineMs: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function install(
  repertoireRoot: string,
  scope = '@acme/repertoire',
  overrides: {
    source?: string;
    ref?: string;
    commit?: string;
    manifest?: string;
  } = {},
): string {
  const packageDir = join(repertoireRoot, ...scope.split('/'));
  mkdirSync(packageDir, { recursive: true });
  const ref = overrides.ref ?? 'v1.2.3';
  writeFileSync(
    join(packageDir, '.takt-repertoire-lock.yaml'),
    `source: ${overrides.source ?? `github:${scope.slice(1)}`}\n`
      + `ref: ${ref}\n`
      + `commit: ${overrides.commit ?? COMMIT}\n`
      + 'imported_at: 2026-07-31T00:00:00.000Z\n',
  );
  writeFileSync(
    join(packageDir, 'takt-repertoire.yaml'),
    overrides.manifest ?? 'name: fixture\n',
  );
  return packageDir;
}

function raw(
  repertoireRoot: string,
  dependencies = [dependency()],
) {
  const port =
    createProjectTemplateInstalledRepertoireDependencyInspectionPort({
      projectRoot: repertoireRoot,
      language: 'ja',
      repertoireRoot,
    });
  return port.inspect(request(dependencies)) as {
    readonly witnessSha256: string;
    readonly observations: readonly Record<string, unknown>[];
  };
}

describe('project template installed repertoire dependency inspector G3.2', () => {
  it('returns an exact frozen G2 port and canonical installed provenance', () => {
    const repertoireRoot = root();
    install(repertoireRoot);
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'ja',
        repertoireRoot,
      });
    const requestValue = request();
    expect(Object.keys(port)).toEqual(['inspect']);
    expect(Object.isFrozen(port)).toBe(true);
    const result = port.inspect(requestValue);
    expect(result).toEqual({
      witnessSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      observations: [{
        scope: '@acme/repertoire',
        state: 'installed',
        installed: {
          source: 'github:acme/repertoire',
          ref: 'v1.2.3',
          version: '1.2.3',
          commit: COMMIT,
          capabilities: [],
        },
      }],
    });
    expect(Object.isFrozen(result)).toBe(true);

    const verified = inspectProjectTemplateRepertoireDependencies({
      request: request(),
      port,
    });
    expect(verified.observations).toEqual(
      (result as { observations: unknown }).observations,
    );
  });

  it('accepts canonical refs with and without the v prefix', () => {
    const repertoireRoot = root();
    install(repertoireRoot, '@acme/one', { ref: 'v1.2.3' });
    install(repertoireRoot, '@acme/two', { ref: '2.0.0' });
    const result = raw(repertoireRoot, [
      dependency('@acme/one', '1.2.3'),
      dependency('@acme/two', '2.0.0'),
    ]);
    expect(result.observations.map((value) => (
      value.installed as { version: string }
    ).version)).toEqual(['1.2.3', '2.0.0']);
  });

  it.each(['root', 'owner', 'package'] as const)(
    'returns a deterministic missing observation for a missing %s',
    (level) => {
      const container = root();
      const repertoireRoot = join(container, 'repertoire');
      if (level !== 'root') mkdirSync(repertoireRoot);
      if (level === 'package') mkdirSync(join(repertoireRoot, '@acme'));
      const first = raw(repertoireRoot);
      const second = raw(repertoireRoot);
      expect(first).toEqual({
        witnessSha256: second.witnessSha256,
        observations: [{
          scope: '@acme/repertoire',
          state: 'missing',
        }],
      });
    },
  );

  it.each([
    ['missing lock', (packageDir: string) => {
      rmSync(join(packageDir, '.takt-repertoire-lock.yaml'));
    }],
    ['missing manifest', (packageDir: string) => {
      rmSync(join(packageDir, 'takt-repertoire.yaml'));
    }],
    ['malformed lock', (packageDir: string) => {
      writeFileSync(join(packageDir, '.takt-repertoire-lock.yaml'), 'secret');
    }],
    ['oversized manifest', (packageDir: string) => {
      writeFileSync(
        join(packageDir, 'takt-repertoire.yaml'),
        Buffer.alloc(64 * 1024 + 1),
      );
    }],
  ])('maps %s to a redacted invalid observation', (_label, mutate) => {
    const repertoireRoot = root();
    const packageDir = install(repertoireRoot);
    mutate(packageDir);
    const result = raw(repertoireRoot);
    expect(result.observations).toEqual([{
      scope: '@acme/repertoire',
      state: 'invalid',
      reason: 'INVALID_INSTALLATION',
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(repertoireRoot);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('imported_at');
  });

  it('treats canonical declaration mismatches as installed observations', () => {
    const repertoireRoot = root();
    install(repertoireRoot, '@acme/repertoire', {
      source: 'github:other/package',
      ref: '9.8.7',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
    });
    expect(raw(repertoireRoot).observations[0]).toMatchObject({
      state: 'installed',
      installed: {
        source: 'github:other/package',
        version: '9.8.7',
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
      },
    });
  });

  it('changes the witness when stable manifest evidence changes', () => {
    const repertoireRoot = root();
    const packageDir = install(repertoireRoot);
    const before = raw(repertoireRoot);
    writeFileSync(
      join(packageDir, 'takt-repertoire.yaml'),
      'name: changed\n',
    );
    const after = raw(repertoireRoot);
    expect(after.witnessSha256).not.toBe(before.witnessSha256);
    expect(after.observations).toEqual(before.observations);
  });

  it('fails direct hostile requests above the 128 dependency bound', () => {
    const repertoireRoot = root();
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    expect(() => port.inspect(request(Array.from(
      { length: 129 },
      (_, index) => dependency(`@a/p${String(index).padStart(3, '0')}`),
    )))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => port.inspect({
      ...request(),
      sourceDescriptorSha256: 'short',
    })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => port.inspect(request([
      dependency('@acme/..'),
    ]))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('stops at abort and monotonic deadline checkpoints', () => {
    const repertoireRoot = root();
    const controller = new AbortController();
    controller.abort();
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    expect(() => port.inspect(request(undefined, {
      signal: controller.signal,
    }))).toThrow(expect.objectContaining({ code: 'ABORTED' }));
    expect(() => port.inspect(request(undefined, {
      deadlineMs: 0,
    }))).toThrow(expect.objectContaining({ code: 'TIMEOUT' }));
  });

  it('exposes only relative seam metadata and catches replacement races', () => {
    const repertoireRoot = root();
    const packageDir = install(repertoireRoot);
    const phases: unknown[][] = [];
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort(
        {
          projectRoot: repertoireRoot,
          language: 'en',
          repertoireRoot,
        },
        (phase, scope, relativePath) => {
          phases.push([phase, scope, relativePath]);
          if (phase === 'before-lock') {
            renameSync(
              join(packageDir, '.takt-repertoire-lock.yaml'),
              join(packageDir, 'moved.lock'),
            );
          }
        },
      );
    expect(port.inspect(request())).toMatchObject({
      observations: [{ state: 'invalid' }],
    });
    expect(phases.length).toBeGreaterThan(0);
    for (const [, , relativePath] of phases) {
      expect(String(relativePath)).not.toContain(repertoireRoot);
      expect(String(relativePath).startsWith('/')).toBe(false);
    }
  });

  it('rejects a package directory replaced before provenance files are read', () => {
    const repertoireRoot = root();
    const packageDir = install(repertoireRoot);
    let replaced = false;
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort(
        { projectRoot: repertoireRoot, language: 'en', repertoireRoot },
        (phase) => {
          if (phase !== 'before-lock' || replaced) return;
          replaced = true;
          renameSync(packageDir, `${packageDir}-original`);
          install(repertoireRoot, '@acme/repertoire', {
            source: 'github:evil/replacement',
            ref: '9.9.9',
            commit: 'abcdef0123456789abcdef0123456789abcdef01',
          });
        },
      );

    expect(port.inspect(request())).toMatchObject({
      observations: [{ state: 'invalid', reason: 'INVALID_INSTALLATION' }],
    });
  });

  it.each([
    ['after-lock', '.takt-repertoire-lock.yaml'],
    ['after-manifest', 'takt-repertoire.yaml'],
    ['after-scope', '.takt-repertoire-lock.yaml'],
  ] as const)(
    'rejects an in-place file rewrite at the %s seam',
    (attackPhase, fileName) => {
      const repertoireRoot = root();
      const packageDir = install(repertoireRoot);
      let mutations = 0;
      const callbacks: string[] = [];
      const port =
        createProjectTemplateInstalledRepertoireDependencyInspectionPort(
          { projectRoot: repertoireRoot, language: 'en', repertoireRoot },
          (phase) => {
            callbacks.push(phase);
            if (phase !== attackPhase || mutations !== 0) return;
            mutations += 1;
            writeFileSync(
              join(packageDir, fileName),
              fileName === 'takt-repertoire.yaml'
                ? 'name: rewritten\n'
                : 'source: github:evil/replacement\n'
                  + 'ref: 9.9.9\n'
                  + 'commit: abcdef0123456789abcdef0123456789abcdef01\n'
                  + 'imported_at: 2026-07-31T00:00:00.000Z\n',
            );
          },
        );

      expect(port.inspect(request())).toMatchObject({
        observations: [{ state: 'invalid', reason: 'INVALID_INSTALLATION' }],
      });
      expect(mutations).toBe(1);
      expect(callbacks.at(-1)).toBe('after-scope');
    },
  );

  it('validates dependency order and uniqueness before a missing-root branch', () => {
    const container = root();
    const repertoireRoot = join(container, 'missing');
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: container,
        language: 'en',
        repertoireRoot,
      });
    expect(() => port.inspect(request([
      dependency('@acme/two'),
      dependency('@acme/one'),
    ]))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => port.inspect(request([
      dependency('@acme/one'),
      dependency('@acme/one'),
    ]))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('enforces a short deadline while witnessing a missing root parent', () => {
    const container = root();
    for (let index = 1023; index >= 0; index -= 1) {
      writeFileSync(join(container, `entry-${String(index).padStart(4, '0')}`), '');
    }
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: container,
        language: 'en',
        repertoireRoot: join(container, 'missing'),
      });
    let timedOut = false;
    for (let attempt = 0; attempt < 100 && !timedOut; attempt += 1) {
      try {
        port.inspect(request(undefined, {
          deadlineMs: performance.now() + 0.03,
        }));
      } catch (error) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'TIMEOUT'
        ) {
          timedOut = true;
        } else {
          throw error;
        }
      }
    }
    expect(timedOut).toBe(true);
  });

  it('closes every opened missing-parent directory across short deadlines', () => {
    const repertoireRoot = root();
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(repertoireRoot, `entry-${index}`), '');
    }
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    const before = openDescriptorCount();
    if (before === undefined) return;
    for (let index = 0; index < 300; index += 1) {
      try {
        port.inspect(request(undefined, {
          deadlineMs: performance.now() + 0.03,
        }));
      } catch {
        // The deadline is intentionally shorter than a complete witness read.
      }
    }
    const after = openDescriptorCount();
    expect(after).toBeDefined();
    expect(after).toBeLessThanOrEqual(before + 4);
  });

  it('rejects symlink roots and snapshots context before later mutation', () => {
    const realRoot = root();
    install(realRoot);
    const container = root();
    const link = join(container, 'repertoire');
    symlinkSync(realRoot, link, 'dir');
    expect(raw(link).observations[0]).toMatchObject({ state: 'invalid' });

    const context = {
      projectRoot: realRoot,
      language: 'en' as const,
      repertoireRoot: realRoot,
    };
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort(context);
    context.repertoireRoot = join(container, 'missing');
    expect(port.inspect(request())).toMatchObject({
      observations: [{ state: 'installed' }],
    });
  });

  it('redacts unexpected filesystem failures through the G2 boundary', () => {
    const repertoireRoot = root();
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      }, () => {
        throw new Error(`secret:${repertoireRoot}`);
      });
    let failure: unknown;
    try {
      inspectProjectTemplateRepertoireDependencies({
        request: request(),
        port,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(
      ProjectTemplateRepertoireDependencyInspectionError,
    );
    expect(failure).toMatchObject({ code: 'INSPECTION_FAILED' });
    expect(String(failure)).not.toContain(repertoireRoot);
    expect(String(failure)).not.toContain('secret');
  });

  it('does not invoke post-init collection, string, regexp, or Dir hooks', () => {
    const repertoireRoot = root();
    install(repertoireRoot);
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    const requestValue = request();
    const originalJoin = Array.prototype.join;
    const originalPush = Array.prototype.push;
    const originalIndexOf = String.prototype.indexOf;
    const originalSlice = String.prototype.slice;
    const originalTest = RegExp.prototype.test;
    const originalRead = Dir.prototype.readSync;
    const originalClose = Dir.prototype.closeSync;
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    const originalDescriptor = Object.getOwnPropertyDescriptor;
    const originalOwnKeys = Reflect.ownKeys;
    let calls = 0;
    const called: string[] = [];
    let result: unknown;
    try {
      Array.prototype.join = function poisonedJoin() {
        calls += 1;
        Reflect.apply(originalPush, called, ['join']);
        throw new Error('must not call join');
      };
      Array.prototype.push = function poisonedPush() {
        calls += 1;
        Reflect.apply(originalPush, called, ['push']);
        return Reflect.apply(originalPush, this, []) as number;
      };
      String.prototype.indexOf = function poisonedIndexOf() {
        calls += 1;
        Reflect.apply(originalPush, called, ['indexOf']);
        return -1;
      };
      String.prototype.slice = function poisonedSlice() {
        calls += 1;
        Reflect.apply(originalPush, called, ['slice']);
        return 'forged';
      };
      RegExp.prototype.test = function poisonedTest() {
        calls += 1;
        Reflect.apply(originalPush, called, ['test']);
        return true;
      };
      Dir.prototype.readSync = function poisonedRead() {
        calls += 1;
        Reflect.apply(originalPush, called, ['read']);
        return null;
      };
      Dir.prototype.closeSync = function poisonedClose() {
        calls += 1;
        Reflect.apply(originalPush, called, ['close']);
      };
      Object.getOwnPropertyDescriptors = function poisonedDescriptors() {
        calls += 1;
        Reflect.apply(originalPush, called, ['descriptors']);
        return {};
      };
      Object.getOwnPropertyDescriptor = function poisonedDescriptor() {
        calls += 1;
        Reflect.apply(originalPush, called, ['descriptor']);
        return undefined;
      };
      Reflect.ownKeys = function poisonedOwnKeys() {
        calls += 1;
        Reflect.apply(originalPush, called, ['ownKeys']);
        return [];
      };
      result = port.inspect(requestValue);
    } finally {
      Array.prototype.join = originalJoin;
      Array.prototype.push = originalPush;
      String.prototype.indexOf = originalIndexOf;
      String.prototype.slice = originalSlice;
      RegExp.prototype.test = originalTest;
      Dir.prototype.readSync = originalRead;
      Dir.prototype.closeSync = originalClose;
      Object.getOwnPropertyDescriptors = originalDescriptors;
      Object.getOwnPropertyDescriptor = originalDescriptor;
      Reflect.ownKeys = originalOwnKeys;
    }
    expect({ calls, called }).toEqual({ calls: 0, called: [] });
    expect(result).toMatchObject({
      observations: [{ state: 'installed' }],
    });
  });

  it('does not expose private provenance buffers to typed-array hooks', () => {
    const repertoireRoot = root();
    const packageDir = install(repertoireRoot);
    const lockPath = join(packageDir, '.takt-repertoire-lock.yaml');
    const lockOnDisk = readFileSync(lockPath);
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const originalLength = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'length',
    )!;
    const originalPoolSize = Object.getOwnPropertyDescriptor(
      Buffer,
      'poolSize',
    )!;
    let calls = 0;
    let receiverCalls = 0;
    let mutations = 0;
    let result: unknown;
    try {
      Object.defineProperty(Buffer, 'poolSize', {
        configurable: true,
        get() {
          calls += 1;
          return originalPoolSize.value;
        },
      });
      Object.defineProperty(typedArrayPrototype, 'length', {
        configurable: true,
        get() {
          calls += 1;
          receiverCalls += 1;
          const receiver = this as Uint8Array;
          if (receiver.byteLength > 0) {
            receiver[0] = 0x78;
            mutations += 1;
          }
          return Reflect.apply(originalLength.get!, this, []);
        },
      });
      result = port.inspect(request());
    } finally {
      Object.defineProperty(Buffer, 'poolSize', originalPoolSize);
      Object.defineProperty(
        typedArrayPrototype,
        'length',
        originalLength,
      );
    }
    expect({ calls, mutations, receiverCalls }).toEqual({
      calls: 0,
      mutations: 0,
      receiverCalls: 0,
    });
    expect(result).toMatchObject({ observations: [{ state: 'installed' }] });
    expect(readFileSync(lockPath)).toEqual(lockOnDisk);
  });

  it('rejects dependency accessors without invoking them', () => {
    const repertoireRoot = root();
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    let calls = 0;
    const hostile = Object.defineProperty({}, 'scope', {
      enumerable: true,
      get() {
        calls += 1;
        return '@acme/repertoire';
      },
    });
    expect(() => port.inspect(request([hostile as never])))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(calls).toBe(0);
  });

  it('rejects accessors without consulting an inherited descriptor value', () => {
    const repertoireRoot = root();
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    const hostile = Object.defineProperty({}, 'scope', {
      enumerable: true,
      get() {
        throw new Error('accessor must not run');
      },
    });
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'value',
    );
    let calls = 0;
    let thrown: unknown;
    try {
      Object.defineProperty(Object.prototype, 'value', {
        configurable: true,
        get() {
          calls += 1;
          return '@acme/repertoire';
        },
      });
      try {
        port.inspect(request([hostile as never]));
      } catch (error) {
        thrown = error;
      }
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(Object.prototype, 'value');
      } else {
        Object.defineProperty(Object.prototype, 'value', original);
      }
    }
    expect(calls).toBe(0);
    expect(thrown).toEqual(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
    }));
  });

  it('does not resolve a replaced global Error during invalid witnessing', () => {
    const repertoireRoot = root();
    for (let index = 0; index < 1025; index += 1) {
      writeFileSync(join(repertoireRoot, `entry-${index}`), '');
    }
    const port =
      createProjectTemplateInstalledRepertoireDependencyInspectionPort({
        projectRoot: repertoireRoot,
        language: 'en',
        repertoireRoot,
      });
    const OriginalError = Error;
    let calls = 0;
    try {
      globalThis.Error = function PoisonedError() {
        calls += 1;
        return new OriginalError('poisoned');
      } as ErrorConstructor;
      expect(port.inspect(request())).toMatchObject({
        observations: [{ state: 'invalid' }],
      });
    } finally {
      globalThis.Error = OriginalError;
    }
    expect(calls).toBe(0);
  });
});
