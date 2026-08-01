import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectTemplateCompanionLockStateError,
  readProjectTemplateCompanionLockState,
  readProjectTemplateCompanionLockStateWithIoSeam,
} from '../../features/project-template/companion-lock-state-reader.js';
import {
  serializeProjectTemplateRepertoireDependencyLock,
  PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  serializeProjectTemplateSourceProvenance,
  PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
} from '../../features/project-template/source-provenance.js';
import { serializeTemplateLock } from '../../features/project-template/lock.js';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from '../../features/project-template/repertoire-dependency-canonical.js';

const CONTENT_LOCK_PATH = '.takt-template-lock.json';
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-companion-locks-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function contentLock(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    manifestSha256: 'c'.repeat(64),
    packVersion: '2.1.0',
    source: {
      kind: 'github',
      uri: 'https://github.com/acme/takt-template',
      ref: 'v2.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    capabilities: [],
    entries: [],
  };
}

function repertoireLock(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    sourceDescriptorSha256: 'a'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    dependencies: [],
  };
}

function sourceLock(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    source: {
      owner: 'acme',
      repo: 'takt-template',
      repositoryUrl: 'https://github.com/acme/takt-template',
      canonicalSource: 'github:acme/takt-template@refs/tags/v2.1.0',
      requestedRef: 'refs/tags/v2.1.0',
      releaseTag: 'v2.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      descriptorSha256: 'a'.repeat(64),
    },
    archive: {
      sha256: 'b'.repeat(64),
      version: '2.1.0',
      manifestSha256: 'c'.repeat(64),
    },
    dependencyVerification: {
      method: 'github-ref-to-commit-v1',
      declarationSha256:
        calculateProjectTemplateRepertoireDependencyDeclarationSha256([]),
      count: 0,
    },
  };
}

function canonicalContents(): Readonly<Record<string, string>> {
  return {
    [CONTENT_LOCK_PATH]: serializeTemplateLock(contentLock()),
    [PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH]:
      serializeProjectTemplateRepertoireDependencyLock(repertoireLock()),
    [PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH]:
      serializeProjectTemplateSourceProvenance(sourceLock()),
  };
}

function writeAll(projectRoot: string): void {
  for (const [path, content] of Object.entries(canonicalContents())) {
    writeFileSync(join(projectRoot, path), content, { mode: 0o600 });
  }
}

function expectStateError(
  callback: () => unknown,
  code: ProjectTemplateCompanionLockStateError['code'],
): void {
  try {
    callback();
    throw new Error('expected companion lock read to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectTemplateCompanionLockStateError);
    expect((error as ProjectTemplateCompanionLockStateError).code).toBe(code);
  }
}

describe('project template companion lock state reader', () => {
  it('accepts all-absent only as a deterministic first-install baseline', () => {
    const result = readProjectTemplateCompanionLockState(root());

    expect(result.state).toBe('first-install');
    expect(result.previousLocksSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.previousLocksSha256).toBe(
      readProjectTemplateCompanionLockState(root()).previousLocksSha256,
    );
  });

  it('reads all-present canonical locks and binds their exact bytes', () => {
    const projectRoot = root();
    writeAll(projectRoot);
    const result = readProjectTemplateCompanionLockState(projectRoot);

    expect(result.state).toBe('update');
    if (result.state !== 'update') throw new Error('expected update state');
    expect(result.contentLock).toEqual(contentLock());
    expect(result.repertoireLock).toEqual(repertoireLock());
    expect(result.sourceProvenance).toEqual(sourceLock());
    expect(result.lockSha256).toEqual(Object.fromEntries(
      Object.entries(canonicalContents()).map(([path, content]) => [
        path,
        createHash('sha256').update(content, 'utf8').digest('hex'),
      ]),
    ));
    expect(result.previousLocksSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.lockSha256)).toBe(true);
  });

  it.each([
    [CONTENT_LOCK_PATH],
    [PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH],
    [PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH],
    [CONTENT_LOCK_PATH, PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH],
    [CONTENT_LOCK_PATH, PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH],
    [PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
      PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH],
  ])('rejects every mixed absent/present state: %s', (...paths) => {
    const projectRoot = root();
    for (const path of paths) {
      writeFileSync(join(projectRoot, path), canonicalContents()[path]!);
    }
    expectStateError(
      () => readProjectTemplateCompanionLockState(projectRoot),
      'MIXED_STATE',
    );
  });

  it.each([
    ['content manifest', (content: Record<string, unknown>) => {
      content['manifestSha256'] = 'f'.repeat(64);
    }],
    ['content version', (content: Record<string, unknown>) => {
      content['packVersion'] = '2.2.0';
    }],
    ['content repository', (content: Record<string, unknown>) => {
      (content['source'] as Record<string, unknown>)['uri'] =
        'https://github.com/other/takt-template';
    }],
    ['content release ref', (content: Record<string, unknown>) => {
      (content['source'] as Record<string, unknown>)['ref'] = 'v2.2.0';
    }],
    ['content commit', (content: Record<string, unknown>) => {
      (content['source'] as Record<string, unknown>)['commit'] = 'f'.repeat(40);
    }],
  ])('rejects cross-lock identity drift: %s', (_label, mutateContent) => {
    const projectRoot = root();
    const changed = contentLock();
    mutateContent(changed);
    const contents = canonicalContents();
    writeFileSync(join(projectRoot, CONTENT_LOCK_PATH), serializeTemplateLock(changed));
    for (const path of [
      PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH,
      PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH,
    ]) writeFileSync(join(projectRoot, path), contents[path]!);
    expectStateError(
      () => readProjectTemplateCompanionLockState(projectRoot),
      'INVALID_LOCK',
    );
  });

  it('rejects repertoire descriptor and declaration evidence drift', () => {
    for (const kind of ['descriptor', 'declaration'] as const) {
      const projectRoot = root();
      const repertoire = repertoireLock();
      const source = sourceLock();
      if (kind === 'descriptor') {
        repertoire['sourceDescriptorSha256'] = 'f'.repeat(64);
      } else {
        (source['dependencyVerification'] as Record<string, unknown>)[
          'declarationSha256'
        ] = 'f'.repeat(64);
      }
      writeFileSync(
        join(projectRoot, CONTENT_LOCK_PATH),
        serializeTemplateLock(contentLock()),
      );
      writeFileSync(
        join(projectRoot, PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH),
        serializeProjectTemplateRepertoireDependencyLock(repertoire),
      );
      writeFileSync(
        join(projectRoot, PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH),
        serializeProjectTemplateSourceProvenance(source),
      );
      expectStateError(
        () => readProjectTemplateCompanionLockState(projectRoot),
        'INVALID_LOCK',
      );
    }
  });

  it('revalidates lock paths after parsing and closes every opened handle', () => {
    const projectRoot = root();
    writeAll(projectRoot);
    const replacement = join(projectRoot, 'replacement.json');
    writeFileSync(replacement, canonicalContents()[CONTENT_LOCK_PATH]!);
    const phases: string[] = [];
    expectStateError(
      () => readProjectTemplateCompanionLockStateWithIoSeam(projectRoot, {
        onPhase(phase) {
          phases.push(phase);
          if (phase === 'before-final-revalidation') {
            renameSync(replacement, join(projectRoot, CONTENT_LOCK_PATH));
          }
        },
      }),
      'UNSAFE_LOCK',
    );
    expect(phases).toContain('root-closed');
  });

  it('closes the root descriptor when an early post-open check fails', () => {
    const phases: string[] = [];
    expectStateError(
      () => readProjectTemplateCompanionLockStateWithIoSeam(root(), {
        onPhase(phase) {
          phases.push(phase);
          if (phase === 'root-opened') throw new Error('private root failure');
        },
      }),
      'UNSAFE_ROOT',
    );
    expect(phases.at(-1)).toBe('root-closed');
  });

  it.each([
    [CONTENT_LOCK_PATH],
    [PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_PATH],
    [PROJECT_TEMPLATE_SOURCE_PROVENANCE_PATH],
  ])('rejects noncanonical JSON for %s', (path) => {
    const projectRoot = root();
    writeAll(projectRoot);
    writeFileSync(join(projectRoot, path), `${canonicalContents()[path]}\n`);
    expectStateError(
      () => readProjectTemplateCompanionLockState(projectRoot),
      'INVALID_LOCK',
    );
  });

  it.each([
    ['symlink', (projectRoot: string, path: string) => {
      rmSync(join(projectRoot, path));
      writeFileSync(join(projectRoot, 'outside.json'), canonicalContents()[path]!);
      symlinkSync(join(projectRoot, 'outside.json'), join(projectRoot, path));
    }],
    ['hardlink', (projectRoot: string, path: string) => {
      linkSync(join(projectRoot, path), join(projectRoot, 'second-link.json'));
    }],
    ['directory', (projectRoot: string, path: string) => {
      rmSync(join(projectRoot, path));
      mkdirSync(join(projectRoot, path));
    }],
  ])('rejects %s lock entries without following or reading them', (_label, mutate) => {
    for (const path of Object.keys(canonicalContents())) {
      const projectRoot = root();
      writeAll(projectRoot);
      mutate(projectRoot, path);
      expectStateError(
        () => readProjectTemplateCompanionLockState(projectRoot),
        'UNSAFE_LOCK',
      );
    }
  });

  it('rejects an unreadable lock rather than treating it as absent', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const projectRoot = root();
    writeAll(projectRoot);
    chmodSync(join(projectRoot, CONTENT_LOCK_PATH), 0o000);
    expectStateError(
      () => readProjectTemplateCompanionLockState(projectRoot),
      'UNREADABLE_LOCK',
    );
  });

  it('rejects a non-directory or symlink project root', () => {
    const parent = root();
    const actual = join(parent, 'actual');
    mkdirSync(actual);
    const linked = join(parent, 'linked');
    symlinkSync(actual, linked);
    expectStateError(
      () => readProjectTemplateCompanionLockState(linked),
      'UNSAFE_ROOT',
    );
  });
});
