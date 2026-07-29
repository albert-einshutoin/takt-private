import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProjectTemplateApplyLease,
  clearProjectTemplateRecoveryRequiredMarker,
  ProjectTemplateCoordinationError,
  withProjectTemplateRunStartPermit,
  writeProjectTemplateRecoveryRequiredMarker,
} from '../../features/project-template/apply-lease.js';
import {
  inspectProjectTemplateApplyGuard,
  resolveProjectTemplateApplyLeasePath,
  resolveProjectTemplateRecoveryRequiredPath,
  resolveProjectTemplateRunStartMutexPath,
} from '../../features/project-template/apply-guard.js';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import { RunMetaManager } from '../../features/tasks/execute/runMeta.js';
import { writePersonalDaemonState } from '../../devloopd/personalLifecycle.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-template-lease-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template apply/run-start coordination', () => {
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
    lease.release();
    expect(existsSync(mutexPath)).toBe(false);
  });

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
