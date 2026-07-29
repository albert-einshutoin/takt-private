import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectProjectTemplateApplyGuard } from '../features/project-template/apply-guard.js';
import { beginProjectTemplatePreparation } from '../features/tasks/execute/projectTemplatePreparationReservation.js';

function readOnlyRunMeta(projectRoot: string): { status: string; workflow: string } {
  const runsRoot = join(projectRoot, '.takt', 'runs');
  const [slug] = readdirSync(runsRoot);
  return JSON.parse(readFileSync(join(runsRoot, slug!, 'meta.json'), 'utf8')) as {
    status: string;
    workflow: string;
  };
}

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
});
