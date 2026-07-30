import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectProjectTemplateApplyGuard } from '../features/project-template/apply-guard.js';
import {
  abortProjectTemplatePreparationAfterError,
  beginProjectTemplatePreparation,
} from '../features/tasks/execute/projectTemplatePreparationReservation.js';

function readOnlyRunMeta(projectRoot: string): { status: string; workflow: string } {
  const runsRoot = join(projectRoot, '.takt', 'runs');
  const [slug] = readdirSync(runsRoot);
  return JSON.parse(readFileSync(join(runsRoot, slug!, 'meta.json'), 'utf8')) as {
    status: string;
    workflow: string;
  };
}

function reservationMetaPath(projectRoot: string): string {
  const [slug] = readdirSync(join(projectRoot, '.takt', 'runs'));
  return join(projectRoot, '.takt', 'runs', slug!, 'meta.json');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('project template preparation reservation', () => {
  it('publishes active evidence synchronously and completes once', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'takt-preparation-reservation-'));
    mkdirSync(join(projectRoot, '.takt'), { recursive: true });

    const reservation = beginProjectTemplatePreparation({
      projectRoot,
      task: 'coordinate queued task preparation',
      workflow: 'task-preparation',
    });

    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).blocks)
      .toContainEqual(expect.objectContaining({ code: 'ACTIVE_RUN' }));
    expect(readOnlyRunMeta(projectRoot)).toMatchObject({
      status: 'running',
      workflow: 'task-preparation',
    });

    reservation.complete();
    reservation.complete();
    reservation.abort();

    expect(readOnlyRunMeta(projectRoot).status).toBe('completed');
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).passed).toBe(true);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('publishes aborted evidence when work stops before completion', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'takt-preparation-abort-'));

    const reservation = beginProjectTemplatePreparation({
      projectRoot,
      task: 'coordinate direct resume',
      workflow: 'direct-resume-preparation',
    });
    reservation.abort();
    reservation.complete();

    expect(readOnlyRunMeta(projectRoot)).toMatchObject({
      status: 'aborted',
      workflow: 'direct-resume-preparation',
    });
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).passed).toBe(true);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('preserves both the primary and abort publication failures', () => {
    const primary = new Error('workflow failed');
    const terminalization = new Error('abort fsync failed');

    expect(() => abortProjectTemplatePreparationAfterError({
      complete() {},
      abort() {
        throw terminalization;
      },
    }, primary)).toThrow(expect.objectContaining({
      errors: [primary, terminalization],
    }));
  });

  it('heartbeats long-lived preparation evidence while the owner is live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'takt-preparation-heartbeat-'));
    const reservation = beginProjectTemplatePreparation({
      projectRoot,
      task: 'watch for queued work',
      workflow: 'watch-preparation',
    });
    const before = readOnlyRunMeta(projectRoot) as {
      status: string;
      workflow: string;
      updatedAt: string;
      ownerPid: number;
    };

    vi.setSystemTime(new Date('2026-07-30T00:01:00.000Z'));
    vi.advanceTimersByTime(60_000);
    const after = readOnlyRunMeta(projectRoot) as typeof before;

    expect(after.ownerPid).toBe(process.pid);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.status).toBe('running');
    reservation.complete();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('captures heartbeat publication failure without throwing from the timer', () => {
    vi.useFakeTimers();
    const projectRoot = mkdtempSync(join(tmpdir(), 'takt-preparation-heartbeat-fault-'));
    const reservation = beginProjectTemplatePreparation({
      projectRoot,
      task: 'long pipeline',
      workflow: 'pipeline-preparation',
    });
    const metaPath = reservationMetaPath(projectRoot);
    const original = readFileSync(metaPath);
    rmSync(metaPath);
    mkdirSync(metaPath);

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();

    rmSync(metaPath, { recursive: true });
    writeFileSync(metaPath, original);
    expect(() => reservation.complete()).toThrow();
    expect(readOnlyRunMeta(projectRoot).status).toBe('completed');
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).passed).toBe(true);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('aggregates primary, heartbeat, and terminalization failures fail-closed', () => {
    vi.useFakeTimers();
    const projectRoot = mkdtempSync(join(tmpdir(), 'takt-preparation-all-faults-'));
    const reservation = beginProjectTemplatePreparation({
      projectRoot,
      task: 'watch pipeline',
      workflow: 'watch-preparation',
    });
    const metaPath = reservationMetaPath(projectRoot);
    rmSync(metaPath);
    mkdirSync(metaPath);
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    const primary = new Error('pipeline failed');

    let caught: unknown;
    try {
      abortProjectTemplatePreparationAfterError(reservation, primary);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(3);
    expect((caught as AggregateError).errors).toContain(primary);
    expect(inspectProjectTemplateApplyGuard({ repoPath: projectRoot }).passed).toBe(false);
    rmSync(projectRoot, { recursive: true, force: true });
  });
});
