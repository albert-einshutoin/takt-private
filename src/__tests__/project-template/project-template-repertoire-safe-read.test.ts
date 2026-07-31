import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateRepertoireSafeReadContext,
  ProjectTemplateRepertoireSafeReadError,
  readProjectTemplateRepertoireDirectory,
  readProjectTemplateRepertoireFile,
  type ProjectTemplateRepertoireSafeReadPhase,
} from '../../infra/repertoire/project-template-repertoire-safe-read.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-repertoire-safe-read-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('project template repertoire safe read G3.1', () => {
  it('normalizes hostile runtime error codes without prototype setters', () => {
    const original = Object.getOwnPropertyDescriptor(
      ProjectTemplateRepertoireSafeReadError.prototype,
      'code',
    );
    let calls = 0;
    let value: ProjectTemplateRepertoireSafeReadError;
    try {
      Object.defineProperty(
        ProjectTemplateRepertoireSafeReadError.prototype,
        'code',
        {
          configurable: true,
          set() {
            calls += 1;
          },
        },
      );
      value = new ProjectTemplateRepertoireSafeReadError({
        toString() {
          throw new Error('must not coerce');
        },
      } as never);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(
          ProjectTemplateRepertoireSafeReadError.prototype,
          'code',
        );
      } else {
        Object.defineProperty(
          ProjectTemplateRepertoireSafeReadError.prototype,
          'code',
          original,
        );
      }
    }
    expect(calls).toBe(0);
    expect(value!.code).toBe('INVALID_ARGUMENT');
  });

  it('returns bounded private bytes and a relative identity witness', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'workflows'));
    writeFileSync(join(root, 'workflows', 'review.yaml'), 'name: review\n');
    const context = createProjectTemplateRepertoireSafeReadContext(root);

    const result = readProjectTemplateRepertoireFile(
      context,
      'workflows/review.yaml',
      'workflow',
    );

    expect(result.relativePath).toBe('workflows/review.yaml');
    expect(result.content.toString('utf8')).toBe('name: review\n');
    expect(result.witness).toMatchObject({
      kind: 'file',
      relativePath: 'workflows/review.yaml',
      size: 13,
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('lists at most bounded, case-distinct entries in byte order', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'providers'));
    writeFileSync(join(root, 'providers', 'z.yaml'), '');
    writeFileSync(join(root, 'providers', 'A.yaml'), '');
    const context = createProjectTemplateRepertoireSafeReadContext(root);

    const result = readProjectTemplateRepertoireDirectory(
      context,
      'providers',
    );

    expect(result.entries).toEqual(['A.yaml', 'z.yaml']);
    expect(result.witness).toMatchObject({
      kind: 'directory',
      relativePath: 'providers',
    });
  });

  it.each([
    '',
    '.',
    '..',
    '../secret',
    'workflows/../secret',
    '/absolute',
    String.raw`C:\absolute`,
    String.raw`workflows\bad.yaml`,
    'workflows//bad.yaml',
    'workflows/\u0000bad.yaml',
    'workflows/CON.yaml',
    `${'a/'.repeat(32)}a`,
    'a'.repeat(1025),
  ])('rejects non-portable relative path %j', (relativePath) => {
    const context = createProjectTemplateRepertoireSafeReadContext(makeRoot());
    expect(() => readProjectTemplateRepertoireFile(
      context,
      relativePath,
      'manifest',
    )).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
  });

  it('rejects symlink and hard-link inputs without exposing paths', () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, 'secret.yaml'), 'secret-token');
    symlinkSync(join(outside, 'secret.yaml'), join(root, 'linked.yaml'));
    writeFileSync(join(root, 'original.yaml'), 'same');
    linkSync(join(root, 'original.yaml'), join(root, 'hardlink.yaml'));
    const context = createProjectTemplateRepertoireSafeReadContext(root);

    for (const relativePath of ['linked.yaml', 'hardlink.yaml']) {
      let failure: unknown;
      try {
        readProjectTemplateRepertoireFile(context, relativePath, 'manifest');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'UNSAFE_ENTRY' });
      expect(String(failure)).not.toContain(root);
      expect(String(failure)).not.toContain('secret-token');
    }
  });

  it('rejects a symlinked ancestor', () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(outside, 'workflows'));
    writeFileSync(join(outside, 'workflows', 'a.yaml'), 'secret');
    symlinkSync(join(outside, 'workflows'), join(root, 'workflows'));
    const context = createProjectTemplateRepertoireSafeReadContext(root);

    expect(() => readProjectTemplateRepertoireFile(
      context,
      'workflows/a.yaml',
      'workflow',
    )).toThrow(expect.objectContaining({ code: 'UNSAFE_ENTRY' }));
  });

  it('uses a size-plus-one sentinel for every fixed file class', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'lock.yaml'), Buffer.alloc(64 * 1024 + 1));
    writeFileSync(join(root, 'workflow.yaml'), Buffer.alloc(1024 * 1024 + 1));
    const context = createProjectTemplateRepertoireSafeReadContext(root);

    expect(() => readProjectTemplateRepertoireFile(
      context,
      'lock.yaml',
      'lock',
    )).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() => readProjectTemplateRepertoireFile(
      context,
      'workflow.yaml',
      'workflow',
    )).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('rejects a file replacement at the phase seam without passing an absolute path', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'lock.yaml'), 'before');
    writeFileSync(join(root, 'replacement.yaml'), 'after');
    const seen: Array<readonly [string, ProjectTemplateRepertoireSafeReadPhase]> = [];
    const context = createProjectTemplateRepertoireSafeReadContext(
      root,
      (relativePath, phase) => {
        seen.push([relativePath, phase]);
        if (relativePath === 'lock.yaml' && phase === 'after-open') {
          renameSync(join(root, 'replacement.yaml'), join(root, 'lock.yaml'));
        }
      },
    );

    expect(() => readProjectTemplateRepertoireFile(
      context,
      'lock.yaml',
      'lock',
    )).toThrow(expect.objectContaining({ code: 'CHANGED_DURING_READ' }));
    expect(seen.every(([relativePath]) => !relativePath.startsWith(root)))
      .toBe(true);
  });

  it('rejects case-normalized directory collisions and entry overflow', () => {
    const collisionRoot = makeRoot();
    mkdirSync(join(collisionRoot, 'providers'));
    writeFileSync(join(collisionRoot, 'providers', 'A.yaml'), '');
    writeFileSync(join(collisionRoot, 'providers', 'a.yaml'), '');
    if (readdirSync(join(collisionRoot, 'providers')).length === 2) {
      expect(() => readProjectTemplateRepertoireDirectory(
        createProjectTemplateRepertoireSafeReadContext(collisionRoot),
        'providers',
      )).toThrow(expect.objectContaining({ code: 'UNSAFE_ENTRY' }));
    }

    const overflowRoot = makeRoot();
    mkdirSync(join(overflowRoot, 'providers'));
    for (let index = 0; index < 1025; index += 1) {
      writeFileSync(join(overflowRoot, 'providers', `p${index}.yaml`), '');
    }
    expect(() => readProjectTemplateRepertoireDirectory(
      createProjectTemplateRepertoireSafeReadContext(overflowRoot),
      'providers',
    )).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('rejects forged contexts and invalid file classes without coercion', () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('must not coerce');
      },
    };
    expect(() => readProjectTemplateRepertoireFile(
      {} as never,
      hostile as never,
      'lock',
    )).toThrow(expect.objectContaining({ code: 'INVALID_CONTEXT' }));
    const context = createProjectTemplateRepertoireSafeReadContext(makeRoot());
    expect(() => readProjectTemplateRepertoireFile(
      context,
      'lock.yaml',
      hostile as never,
    )).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('does not resolve mutable WeakMap methods for context authority', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'lock.yaml'), 'secret-outside-context');
    const legitimate = createProjectTemplateRepertoireSafeReadContext(root);
    const forged = {};
    const originalGet = WeakMap.prototype.get;
    const originalHas = WeakMap.prototype.has;
    const originalSet = WeakMap.prototype.set;
    let calls = 0;
    let thrown: unknown;
    try {
      WeakMap.prototype.get = function poisonedGet(key: object) {
        calls += 1;
        return Reflect.apply(originalGet, this, [
          key === forged ? legitimate : key,
        ]);
      };
      WeakMap.prototype.has = function poisonedHas() {
        calls += 1;
        return true;
      };
      WeakMap.prototype.set = function poisonedSet() {
        calls += 1;
        return this;
      };
      try {
        readProjectTemplateRepertoireFile(
          forged as never,
          'lock.yaml',
          'lock',
        );
      } catch (error) {
        thrown = error;
      }
    } finally {
      WeakMap.prototype.get = originalGet;
      WeakMap.prototype.has = originalHas;
      WeakMap.prototype.set = originalSet;
    }
    expect(calls).toBe(0);
    expect(thrown).toEqual(expect.objectContaining({
      code: 'INVALID_CONTEXT',
    }));
  });

  it.each(['before-close', 'after-close'] as const)(
    'revalidates a file around the late %s seam',
    (attackPhase) => {
      const root = makeRoot();
      writeFileSync(join(root, 'lock.yaml'), 'before');
      writeFileSync(join(root, 'replacement.yaml'), 'after');
      const context = createProjectTemplateRepertoireSafeReadContext(
        root,
        (relativePath, phase) => {
          if (relativePath === 'lock.yaml' && phase === attackPhase) {
            renameSync(
              join(root, 'replacement.yaml'),
              join(root, 'lock.yaml'),
            );
          }
        },
      );
      expect(() => readProjectTemplateRepertoireFile(
        context,
        'lock.yaml',
        'lock',
      )).toThrow(expect.objectContaining({
        code: 'CHANGED_DURING_READ',
      }));
    },
  );

  it.each(['before-close', 'after-close'] as const)(
    'revalidates a directory around the late %s seam',
    (attackPhase) => {
      const root = makeRoot();
      mkdirSync(join(root, 'workflows'));
      mkdirSync(join(root, 'replacement'));
      writeFileSync(join(root, 'workflows', 'before.yaml'), 'before');
      writeFileSync(join(root, 'replacement', 'after.yaml'), 'after');
      const context = createProjectTemplateRepertoireSafeReadContext(
        root,
        (relativePath, phase) => {
          if (relativePath === 'workflows' && phase === attackPhase) {
            renameSync(join(root, 'workflows'), join(root, 'original'));
            renameSync(join(root, 'replacement'), join(root, 'workflows'));
          }
        },
      );
      expect(() => readProjectTemplateRepertoireDirectory(
        context,
        'workflows',
      )).toThrow(expect.objectContaining({
        code: 'CHANGED_DURING_READ',
      }));
    },
  );

  it('does not call mutable Stats type predicates or leak their errors', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'lock.yaml'), 'safe');
    const statsPrototype = Object.getPrototypeOf(lstatSync(root)) as {
      isDirectory: () => boolean;
      isFile: () => boolean;
      isSymbolicLink: () => boolean;
    };
    const originals = {
      isDirectory: statsPrototype.isDirectory,
      isFile: statsPrototype.isFile,
      isSymbolicLink: statsPrototype.isSymbolicLink,
    };
    let calls = 0;
    const poison = () => {
      calls += 1;
      throw new Error(`leaked ${root}`);
    };
    try {
      statsPrototype.isDirectory = poison;
      statsPrototype.isFile = poison;
      statsPrototype.isSymbolicLink = poison;
      const context = createProjectTemplateRepertoireSafeReadContext(root);
      expect(readProjectTemplateRepertoireFile(
        context,
        'lock.yaml',
        'lock',
      ).content.toString()).toBe('safe');
    } finally {
      statsPrototype.isDirectory = originals.isDirectory;
      statsPrototype.isFile = originals.isFile;
      statsPrototype.isSymbolicLink = originals.isSymbolicLink;
    }
    expect(calls).toBe(0);
  });

  it('rejects Windows-reserved names returned by directory enumeration', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'providers'));
    writeFileSync(join(root, 'providers', 'CON.yaml'), '');
    expect(() => readProjectTemplateRepertoireDirectory(
      createProjectTemplateRepertoireSafeReadContext(root),
      'providers',
    )).toThrow(expect.objectContaining({ code: 'UNSAFE_ENTRY' }));
  });
});
