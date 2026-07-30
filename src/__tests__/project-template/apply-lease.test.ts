import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProjectTemplateApplyLease,
  clearProjectTemplateRecoveryRequiredMarker,
  isSafeProjectTemplateControlIgnore,
  ProjectTemplateCoordinationError,
  recoverAbandonedProjectTemplateCoordinationClaimsForRecovery,
  syncProjectTemplateCoordinationDirectory,
  withProjectTemplateRunStartPermit,
  writeProjectTemplateRecoveryRequiredMarker,
  type ProjectTemplateRunStartPermit,
} from '../../features/project-template/apply-lease.js';
import {
  inspectProjectTemplateApplyGuard,
  resolveProjectTemplateApplyLeasePath,
  resolveProjectTemplateRecoveryRequiredPath,
  resolveProjectTemplateRunStartMutexPath,
} from '../../features/project-template/apply-guard.js';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import {
  resolveProjectTemplateRunMirrorSlug,
  RunMetaManager,
} from '../../features/tasks/execute/runMeta.js';
import { createRunMetaStorageIo } from '../../features/tasks/execute/runMetaStorage.js';
import { writePersonalDaemonState } from '../../devloopd/personalLifecycle.js';

const coordinationFault = vi.hoisted(() => ({
  namespaceFailure: undefined as 'unlink' | 'fsync' | undefined,
  targetMainPath: undefined as string | undefined,
  failMainCleanup: false,
  namespaceFailureInjected: false,
  mainCleanupFailureInjected: false,
  failNextDirectoryFsync: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]) {
      const value = String(path);
      if (
        value.endsWith('.reclaim')
        && !coordinationFault.namespaceFailureInjected
        && coordinationFault.namespaceFailure === 'unlink'
      ) {
        coordinationFault.namespaceFailureInjected = true;
        throw Object.assign(new Error('injected reclaim namespace unlink failure'), {
          code: 'EIO',
        });
      }
      if (
        value.endsWith('.reclaim')
        && !coordinationFault.namespaceFailureInjected
        && coordinationFault.namespaceFailure === 'fsync'
      ) {
        actual.unlinkSync(path);
        coordinationFault.failNextDirectoryFsync = true;
        return;
      }
      if (
        coordinationFault.namespaceFailureInjected
        && coordinationFault.failMainCleanup
        && !coordinationFault.mainCleanupFailureInjected
        && value === coordinationFault.targetMainPath
      ) {
        coordinationFault.mainCleanupFailureInjected = true;
        throw Object.assign(new Error('injected main cleanup failure'), {
          code: 'EIO',
        });
      }
      actual.unlinkSync(path);
    },
    fsyncSync(fd: number) {
      if (coordinationFault.failNextDirectoryFsync) {
        coordinationFault.failNextDirectoryFsync = false;
        coordinationFault.namespaceFailureInjected = true;
        throw Object.assign(new Error('injected reclaim namespace fsync failure'), {
          code: 'EIO',
        });
      }
      actual.fsyncSync(fd);
    },
  };
});

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-template-lease-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  coordinationFault.namespaceFailure = undefined;
  coordinationFault.targetMainPath = undefined;
  coordinationFault.failMainCleanup = false;
  coordinationFault.namespaceFailureInjected = false;
  coordinationFault.mainCleanupFailureInjected = false;
  coordinationFault.failNextDirectoryFsync = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template apply/run-start coordination', () => {
  it('publishes and validates the private ignore before coordination files', () => {
    const root = makeRoot();

    withProjectTemplateRunStartPermit(root, () => {
      const ignorePath = join(root, '.takt-template-state', '.gitignore');
      expect(readFileSync(ignorePath, 'utf8')).toBe('*\n');
      expect(existsSync(resolveProjectTemplateRunStartMutexPath(root))).toBe(true);
    });
  });

  it.each([
    ['symlink', (ignorePath: string, root: string) => {
      const source = join(root, 'ignore-source');
      writeFileSync(source, '*\n', { mode: 0o600 });
      symlinkSync(source, ignorePath);
    }],
    ['hardlink', (ignorePath: string, root: string) => {
      const source = join(root, 'ignore-source');
      writeFileSync(source, '*\n', { mode: 0o600 });
      linkSync(source, ignorePath);
    }],
    ['wrong content', (ignorePath: string) => {
      writeFileSync(ignorePath, '!\n', { mode: 0o600 });
    }],
  ] as const)('blocks coordination when control ignore is a %s', (_label, install) => {
    const root = makeRoot();
    const controlRoot = join(root, '.takt-template-state');
    mkdirSync(controlRoot, { mode: 0o700 });
    install(join(controlRoot, '.gitignore'), root);

    expect(() => acquireProjectTemplateApplyLease(root))
      .toThrow(ProjectTemplateCoordinationError);
    expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(false);
    expect(existsSync(resolveProjectTemplateRunStartMutexPath(root))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'blocks coordination when the control ignore has broad POSIX mode',
    () => {
      const root = makeRoot();
      const controlRoot = join(root, '.takt-template-state');
      mkdirSync(controlRoot, { mode: 0o700 });
      writeFileSync(join(controlRoot, '.gitignore'), '*\n', { mode: 0o600 });
      chmodSync(join(controlRoot, '.gitignore'), 0o644);

      expect(() => acquireProjectTemplateApplyLease(root))
        .toThrow(ProjectTemplateCoordinationError);
    },
  );

  it('uses lstat identity checks when Windows cannot provide O_NOFOLLOW', () => {
    const root = makeRoot();
    const controlRoot = join(root, '.takt-template-state');
    const ignorePath = join(controlRoot, '.gitignore');
    mkdirSync(controlRoot, { mode: 0o700 });
    writeFileSync(ignorePath, '*\n', { mode: 0o644 });
    const device = lstatSync(controlRoot).dev;

    expect(isSafeProjectTemplateControlIgnore(ignorePath, device, 'win32')).toBe(true);
    rmSync(ignorePath);
    const source = join(root, 'ignore-source');
    writeFileSync(source, '*\n', { mode: 0o600 });
    symlinkSync(source, ignorePath);
    expect(isSafeProjectTemplateControlIgnore(ignorePath, device, 'win32')).toBe(false);
  });

  it('accepts a concurrently published equivalent private ignore', () => {
    const root = makeRoot();
    const controlRoot = join(root, '.takt-template-state');
    mkdirSync(controlRoot, { mode: 0o700 });
    writeFileSync(join(controlRoot, '.gitignore'), '*\n', { mode: 0o600 });

    const lease = acquireProjectTemplateApplyLease(root);
    lease.release();
  });

  it('does not attempt directory fsync on Windows', () => {
    let called = false;

    expect(syncProjectTemplateCoordinationDirectory(
      'unused',
      'win32',
      () => {
        called = true;
      },
    )).toBe('unsupported');
    expect(called).toBe(false);
  });

  it('keeps coordination state out of git status and git add -A', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: root });
    const lease = acquireProjectTemplateApplyLease(root);

    expect(execFileSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
    })).toBe('');
    execFileSync('git', ['add', '-A'], { cwd: root });
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
    })).toBe('');
    lease.release();
  });

  it('blocks run publication for the full lifetime of an apply lease', () => {
    const root = makeRoot();
    const lease = acquireProjectTemplateApplyLease(root);

    expect(() => withProjectTemplateRunStartPermit(root, () => undefined))
      .toThrow(ProjectTemplateCoordinationError);
    expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(true);

    lease.release();
    expect(withProjectTemplateRunStartPermit(root, () => 'started')).toBe('started');
    expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(false);
  });

  it('does not let apply overtake a run while running evidence is published', () => {
    const root = makeRoot();

    withProjectTemplateRunStartPermit(root, () => {
      expect(existsSync(resolveProjectTemplateRunStartMutexPath(root))).toBe(true);
      expect(() => acquireProjectTemplateApplyLease(root))
        .toThrow(ProjectTemplateCoordinationError);
    });

    expect(existsSync(resolveProjectTemplateRunStartMutexPath(root))).toBe(false);
  });

  it('publishes run meta with an active capability before releasing the mutex', () => {
    const root = makeRoot();
    const runSlug = 'capability-published-run';
    const metaPath = join(root, '.takt', 'runs', runSlug, 'meta.json');

    withProjectTemplateRunStartPermit(root, (permit) => {
      new RunMetaManager(
        buildRunPaths(root, runSlug),
        'capability task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: permit,
          projectTemplateCoordinationRoot: root,
        },
      );
      expect(JSON.parse(readFileSync(metaPath, 'utf8'))).toMatchObject({
        status: 'running',
        runSlug,
      });
      expect(() => acquireProjectTemplateApplyLease(root))
        .toThrow(ProjectTemplateCoordinationError);
    });

    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(resolveProjectTemplateRunStartMutexPath(root))).toBe(false);
  });

  it('publishes beneath the canonical project root through a workspace symlink', () => {
    const root = makeRoot();
    const aliasParent = makeRoot();
    const alias = join(aliasParent, 'workspace-alias');
    const runSlug = 'canonical-workspace-run';
    symlinkSync(root, alias);

    withProjectTemplateRunStartPermit(root, (permit) => {
      new RunMetaManager(
        buildRunPaths(alias, runSlug),
        'canonical workspace task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: permit,
          projectTemplateCoordinationRoot: root,
        },
      );
    });

    expect(JSON.parse(readFileSync(
      join(root, '.takt', 'runs', runSlug, 'meta.json'),
      'utf8',
    ))).toMatchObject({ status: 'running', runSlug });
  });

  it('mirrors a worktree run into the coordination root until finalize', () => {
    const projectRoot = makeRoot();
    const worktreeRoot = makeRoot();
    let manager: RunMetaManager | undefined;

    withProjectTemplateRunStartPermit(projectRoot, (permit) => {
      manager = new RunMetaManager(
        buildRunPaths(worktreeRoot, 'worktree-run'),
        'worktree task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: permit,
          projectTemplateCoordinationRoot: projectRoot,
        },
      );
      expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks)
        .toContainEqual(expect.objectContaining({ code: 'ACTIVE_RUN' }));
      expect(() => acquireProjectTemplateApplyLease(projectRoot))
        .toThrow(ProjectTemplateCoordinationError);
    });

    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks)
      .toContainEqual(expect.objectContaining({ code: 'ACTIVE_RUN' }));
    manager!.finalize('completed', 1);
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).passed)
      .toBe(true);
  });

  it('hands off only after actual and mirror names are durably published', () => {
    const projectRoot = makeRoot();
    const worktreeRoot = makeRoot();
    const runSlug = 'durable-handoff';
    const canonicalProjectRoot = realpathSync.native(projectRoot);
    const canonicalWorktreeRoot = realpathSync.native(worktreeRoot);
    const actualRunRoot = join(canonicalWorktreeRoot, '.takt', 'runs', runSlug);
    const mirrorSlug = resolveProjectTemplateRunMirrorSlug(
      canonicalProjectRoot,
      canonicalWorktreeRoot,
      runSlug,
    );
    const mirrorRunRoot = join(canonicalProjectRoot, '.takt', 'runs', mirrorSlug);
    const events: string[] = [];
    const io = createRunMetaStorageIo({
      before(operation, path) {
        if (
          operation === 'directory-fsync'
          && (path === actualRunRoot || path === mirrorRunRoot)
        ) {
          events.push(path === actualRunRoot ? 'actual-durable' : 'mirror-durable');
        }
      },
    });

    withProjectTemplateRunStartPermit(projectRoot, (permit) => {
      new RunMetaManager(
        buildRunPaths(worktreeRoot, runSlug),
        'durable handoff task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: permit,
          projectTemplateCoordinationRoot: projectRoot,
          runMetaStorageIo: io,
        },
      );
      events.push('handoff');
    });

    expect(events).toEqual([
      'actual-durable',
      'mirror-durable',
      'handoff',
    ]);
  });

  it('uses collision-safe mirror slugs for concurrent worktree runs', () => {
    const projectRoot = makeRoot();
    const firstWorktree = makeRoot();
    const secondWorktree = makeRoot();
    const managers: RunMetaManager[] = [];
    const runSlug = 'same-run-slug';

    for (const worktreeRoot of [firstWorktree, secondWorktree]) {
      withProjectTemplateRunStartPermit(projectRoot, (permit) => {
        managers.push(new RunMetaManager(
          buildRunPaths(worktreeRoot, runSlug),
          `task in ${worktreeRoot}`,
          'default',
          undefined,
          {
            projectTemplateRunStartPermit: permit,
            projectTemplateCoordinationRoot: projectRoot,
          },
        ));
      });
    }

    const expectedSlugs = [firstWorktree, secondWorktree].map((worktreeRoot) =>
      resolveProjectTemplateRunMirrorSlug(
        realpathSync.native(projectRoot),
        realpathSync.native(worktreeRoot),
        runSlug,
      ));
    expect(new Set(expectedSlugs).size).toBe(2);
    const activeSlugs = inspectProjectTemplateApplyGuard({ repoPath: projectRoot })
      .blocks
      .filter((block) => block.code === 'ACTIVE_RUN')
      .map((block) => 'slug' in block ? block.slug : undefined);
    expect(activeSlugs).toEqual(expect.arrayContaining(expectedSlugs));

    for (const manager of managers) manager.finalize('completed', 1);
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).passed)
      .toBe(true);
  });

  it('leaves a running mirror when a terminal mirror write fails', () => {
    const projectRoot = makeRoot();
    const worktreeRoot = makeRoot();
    const writes: string[] = [];
    let rejectMirrorWrite = false;
    let manager: RunMetaManager | undefined;
    const canonicalProjectRoot = realpathSync.native(projectRoot);
    const canonicalWorktreeRoot = realpathSync.native(worktreeRoot);
    const io = createRunMetaStorageIo({
      before(operation, path) {
        if (operation === 'rename') writes.push(path);
        if (
          rejectMirrorWrite
          && operation === 'file-fsync'
          && path.startsWith(join(canonicalProjectRoot, '.takt', 'runs'))
        ) {
          throw new Error('injected mirror write failure');
        }
      },
    });

    withProjectTemplateRunStartPermit(projectRoot, (permit) => {
      manager = new RunMetaManager(
        buildRunPaths(worktreeRoot, 'mirror-failure'),
        'mirror failure task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: permit,
          projectTemplateCoordinationRoot: projectRoot,
          runMetaStorageIo: io,
        },
      );
    });
    rejectMirrorWrite = true;
    const writesBeforeFinalize = writes.length;

    expect(() => manager!.finalize('completed', 1))
      .toThrow('injected mirror write failure');
    const finalizeWrites = writes.slice(writesBeforeFinalize);
    expect(finalizeWrites[0]).toBe(join(
      canonicalWorktreeRoot,
      '.takt',
      'runs',
      'mirror-failure',
      'meta.json',
    ));
    expect(finalizeWrites).toHaveLength(1);
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks)
      .toContainEqual(expect.objectContaining({ code: 'ACTIVE_RUN' }));
  });

  it('leaves missing mirror metadata that blocks apply when initial mirror publication fails', () => {
    const projectRoot = makeRoot();
    const worktreeRoot = makeRoot();
    const canonicalProjectRoot = realpathSync.native(projectRoot);
    let handedOff = false;
    const io = createRunMetaStorageIo({
      before(operation, path) {
        if (
          operation === 'file-fsync'
          && path.startsWith(join(canonicalProjectRoot, '.takt', 'runs'))
        ) {
          throw new Error('injected initial mirror write failure');
        }
      },
    });

    expect(() => withProjectTemplateRunStartPermit(projectRoot, (permit) => {
      new RunMetaManager(
        buildRunPaths(worktreeRoot, 'initial-mirror-failure'),
        'initial mirror failure task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: permit,
          projectTemplateCoordinationRoot: projectRoot,
          runMetaStorageIo: io,
        },
      );
      handedOff = true;
    })).toThrow('injected initial mirror write failure');

    expect(handedOff).toBe(false);
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks)
      .toContainEqual(expect.objectContaining({
        code: 'RUN_METADATA_MISSING',
      }));
  });

  it('rejects forged and expired run-start capabilities before publishing run evidence', () => {
    const root = makeRoot();
    let expiredPermit: ProjectTemplateRunStartPermit | undefined;

    withProjectTemplateRunStartPermit(root, (permit) => {
      expiredPermit = permit;
      expect(() => new RunMetaManager(
        buildRunPaths(root, 'forged-run'),
        'forged task',
        'default',
        undefined,
        {
          projectTemplateRunStartPermit: { ...permit },
          projectTemplateCoordinationRoot: root,
        },
      )).toThrow(ProjectTemplateCoordinationError);
      expect(existsSync(join(root, '.takt', 'runs', 'forged-run', 'meta.json')))
        .toBe(false);
    });

    expect(expiredPermit).toBeDefined();
    expect(() => new RunMetaManager(
      buildRunPaths(root, 'delayed-run'),
      'delayed task',
      'default',
      undefined,
      {
        projectTemplateRunStartPermit: expiredPermit!,
        projectTemplateCoordinationRoot: root,
      },
    )).toThrow(ProjectTemplateCoordinationError);
    expect(existsSync(join(root, '.takt', 'runs', 'delayed-run', 'meta.json')))
      .toBe(false);
  });

  it('reclaims a coordination mutex only when its recorded owner is dead', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(mutexPath, JSON.stringify({
      version: 1,
      token: 'crashed-mutex-owner',
      pid: 99_999,
    }));

    const lease = acquireProjectTemplateApplyLease(root);
    expect(lease.pid).toBe(process.pid);
    expect(existsSync(`${mutexPath}.reclaim`)).toBe(false);
    lease.release();
    expect(existsSync(mutexPath)).toBe(false);
  });

  it('recovers a dead reclaimer namespace through a separately owned recovery lock', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(mutexPath, JSON.stringify({
      version: 1,
      token: 'crashed-mutex-owner',
      pid: 99_999,
    }));
    const target = lstatSync(mutexPath);
    writeFileSync(`${mutexPath}.reclaim`, JSON.stringify({
      version: 2,
      token: 'crashed-reclaimer-claim',
      pid: 99_998,
      operation: 'reclaim',
      target: {
        device: String(target.dev),
        inode: String(target.ino),
        token: 'crashed-mutex-owner',
        pid: 99_999,
      },
    }));

    const lease = acquireProjectTemplateApplyLease(root);

    expect(lease.pid).toBe(process.pid);
    expect(existsSync(`${mutexPath}.reclaim`)).toBe(false);
    expect(existsSync(`${mutexPath}.reclaim.recovery`)).toBe(false);
    lease.release();
  });

  it('recovers the post-main-unlink crash window', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    const reclaimPath = `${mutexPath}.reclaim`;
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(reclaimPath, JSON.stringify({
      version: 2,
      token: 'reclaimer-crashed-after-main-unlink',
      pid: 99_999,
      operation: 'reclaim',
      target: {
        device: '1',
        inode: '2',
        token: 'already-unlinked-owner',
        pid: 99_998,
      },
    }));

    const lease = acquireProjectTemplateApplyLease(root);

    expect(lease.pid).toBe(process.pid);
    expect(existsSync(reclaimPath)).toBe(false);
    expect(existsSync(`${reclaimPath}.recovery`)).toBe(false);
    lease.release();
  });

  it('recovers a dead publication namespace after main creation', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    const reclaimPath = `${mutexPath}.reclaim`;
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(mutexPath, JSON.stringify({
      version: 1,
      token: 'partially-published-main',
      pid: 99_999,
    }));
    writeFileSync(reclaimPath, JSON.stringify({
      version: 2,
      token: 'crashed-publication-namespace',
      pid: 99_999,
      operation: 'publish',
      mainToken: 'partially-published-main',
    }));

    const lease = acquireProjectTemplateApplyLease(root);

    expect(lease.pid).toBe(process.pid);
    expect(existsSync(reclaimPath)).toBe(false);
    expect(existsSync(`${reclaimPath}.recovery`)).toBe(false);
    lease.release();
  });

  it('keeps an active reclaimer fail-closed even when the target owner is dead', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    const reclaimPath = `${mutexPath}.reclaim`;
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(mutexPath, JSON.stringify({
      version: 1,
      token: 'dead-target-owner',
      pid: 99_999,
    }));
    const target = lstatSync(mutexPath);
    writeFileSync(reclaimPath, JSON.stringify({
      version: 2,
      token: 'live-reclaimer',
      pid: process.pid,
      operation: 'reclaim',
      target: {
        device: String(target.dev),
        inode: String(target.ino),
        token: 'dead-target-owner',
        pid: 99_999,
      },
    }));

    expect(() => acquireProjectTemplateApplyLease(root))
      .toThrow(ProjectTemplateCoordinationError);
    expect(readFileSync(reclaimPath, 'utf8')).toContain('live-reclaimer');
    expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(false);
  });

  it('never steals an abandoned second-level recovery owner automatically', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    const reclaimPath = `${mutexPath}.reclaim`;
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(reclaimPath, JSON.stringify({
      version: 2,
      token: 'dead-publication',
      pid: 99_999,
      operation: 'publish',
      mainToken: 'unpublished-main',
    }));
    writeFileSync(`${reclaimPath}.recovery`, JSON.stringify({
      version: 3,
      token: 'abandoned-recovery',
      pid: 99_998,
      operation: 'namespace-recovery',
      namespaceToken: 'dead-publication',
    }));

    expect(() => acquireProjectTemplateApplyLease(root))
      .toThrow(ProjectTemplateCoordinationError);
    expect(existsSync(reclaimPath)).toBe(true);
    expect(existsSync(`${reclaimPath}.recovery`)).toBe(true);
    expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(false);
  });

  it('explicitly resumes an abandoned dead recovery owner after a dry run', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    const reclaimPath = `${mutexPath}.reclaim`;
    const recoveryPath = `${reclaimPath}.recovery`;
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(mutexPath, JSON.stringify({
      version: 1,
      token: 'dead-main-owner',
      pid: 99_999,
    }));
    const target = lstatSync(mutexPath);
    writeFileSync(reclaimPath, JSON.stringify({
      version: 2,
      token: 'dead-reclaimer',
      pid: 99_998,
      operation: 'reclaim',
      target: {
        device: String(target.dev),
        inode: String(target.ino),
        token: 'dead-main-owner',
        pid: 99_999,
      },
    }));
    writeFileSync(recoveryPath, JSON.stringify({
      version: 3,
      token: 'dead-recovery-owner',
      pid: 99_997,
      operation: 'namespace-recovery',
      namespaceToken: 'dead-reclaimer',
    }));

    expect(recoverAbandonedProjectTemplateCoordinationClaimsForRecovery(root, {
      apply: false,
      probeProcess: () => 'dead',
    })).toMatchObject({ status: 'recoverable', paths: [recoveryPath] });
    expect(existsSync(mutexPath)).toBe(true);
    expect(existsSync(reclaimPath)).toBe(true);
    expect(existsSync(recoveryPath)).toBe(true);

    expect(recoverAbandonedProjectTemplateCoordinationClaimsForRecovery(root, {
      apply: true,
      probeProcess: () => 'dead',
    })).toMatchObject({ status: 'recovered', paths: [recoveryPath] });
    expect(existsSync(mutexPath)).toBe(false);
    expect(existsSync(reclaimPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it.each(['alive', 'unknown'] as const)(
    'keeps an abandoned recovery owner %s state fail-closed',
    (processState) => {
      const root = makeRoot();
      const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
      const reclaimPath = `${mutexPath}.reclaim`;
      const recoveryPath = `${reclaimPath}.recovery`;
      mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(reclaimPath, JSON.stringify({
        version: 2,
        token: 'blocked-namespace',
        pid: 99_999,
        operation: 'publish',
        mainToken: 'blocked-main',
      }));
      writeFileSync(recoveryPath, JSON.stringify({
        version: 3,
        token: 'blocked-recovery',
        pid: 99_998,
        operation: 'namespace-recovery',
        namespaceToken: 'blocked-namespace',
      }));

      expect(recoverAbandonedProjectTemplateCoordinationClaimsForRecovery(root, {
        apply: true,
        probeProcess: () => processState,
      })).toMatchObject({ status: 'blocked', paths: [recoveryPath] });
      expect(existsSync(reclaimPath)).toBe(true);
      expect(existsSync(recoveryPath)).toBe(true);
    },
  );

  it('removes only the final abandoned recovery record after prior cleanup completed', () => {
    const root = makeRoot();
    const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
    const recoveryPath = `${mutexPath}.reclaim.recovery`;
    mkdirSync(join(mutexPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(recoveryPath, JSON.stringify({
      version: 3,
      token: 'cleanup-complete-recovery',
      pid: 99_999,
      operation: 'namespace-recovery',
      namespaceToken: 'already-removed-namespace',
    }));

    expect(recoverAbandonedProjectTemplateCoordinationClaimsForRecovery(root, {
      apply: true,
      probeProcess: () => 'dead',
    }).status).toBe('recovered');
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it.each([
    ['unlink', false],
    ['unlink', true],
    ['fsync', false],
    ['fsync', true],
  ] as const)(
    'does not retry after reclaim namespace %s failure when main cleanup failure is %s',
    (namespaceFailure, failMainCleanup) => {
      const root = makeRoot();
      const mutexPath = resolveProjectTemplateRunStartMutexPath(root);
      coordinationFault.namespaceFailure = namespaceFailure;
      coordinationFault.targetMainPath = mutexPath;
      coordinationFault.failMainCleanup = failMainCleanup;

      expect(() => acquireProjectTemplateApplyLease(root))
        .toThrow(ProjectTemplateCoordinationError);

      expect(coordinationFault.namespaceFailureInjected).toBe(true);
      expect(coordinationFault.mainCleanupFailureInjected).toBe(failMainCleanup);
      expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(false);
      expect(existsSync(mutexPath)).toBe(failMainCleanup);
      expect(existsSync(`${mutexPath}.reclaim`)).toBe(false);
    },
  );

  it('guards both direct run and personal daemon running-state publication', () => {
    const root = makeRoot();
    const lease = acquireProjectTemplateApplyLease(root);

    expect(() => new RunMetaManager(
      buildRunPaths(root, 'blocked-run'),
      'blocked task',
      'default',
    )).toThrow(ProjectTemplateCoordinationError);
    expect(() => writePersonalDaemonState({ repoPath: root }))
      .toThrow(ProjectTemplateCoordinationError);
    expect(existsSync(join(root, '.takt', 'runs', 'blocked-run', 'meta.json'))).toBe(false);
    expect(existsSync(join(root, '.devloop', 'daemon', 'state.json'))).toBe(false);

    lease.release();
  });

  it('keeps recovery-required durable after lease release until the owner clears it', () => {
    const root = makeRoot();
    const lease = acquireProjectTemplateApplyLease(root);
    const identity = { token: lease.token, transactionId: 'transaction-1' };
    writeProjectTemplateRecoveryRequiredMarker(root, identity);

    lease.release();

    expect(existsSync(resolveProjectTemplateApplyLeasePath(root))).toBe(false);
    expect(existsSync(resolveProjectTemplateRecoveryRequiredPath(root))).toBe(true);
    expect(inspectProjectTemplateApplyGuard({ repoPath: root }).blocks)
      .toContainEqual(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(() => withProjectTemplateRunStartPermit(root, () => undefined))
      .toThrow(ProjectTemplateCoordinationError);

    expect(() => clearProjectTemplateRecoveryRequiredMarker(root, {
      token: identity.token,
      transactionId: 'different-transaction',
    })).toThrow(ProjectTemplateCoordinationError);
    expect(existsSync(resolveProjectTemplateRecoveryRequiredPath(root))).toBe(true);

    clearProjectTemplateRecoveryRequiredMarker(root, identity);
    expect(existsSync(resolveProjectTemplateRecoveryRequiredPath(root))).toBe(false);
    expect(inspectProjectTemplateApplyGuard({ repoPath: root }).passed).toBe(true);
  });
});
