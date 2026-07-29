import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { invalidateAllResolvedConfigCache } from '../../infra/config/index.js';
import { runProjectTemplateDoctor } from '../../features/project-template/apply-doctor.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-template-doctor-'));
  roots.push(root);
  mkdirSync(join(root, '.takt', 'workflows'), { recursive: true });
  return root;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, '.takt', path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

afterEach(() => {
  invalidateAllResolvedConfigCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template doctor', () => {
  it('validates project config and every project workflow without mutation', () => {
    const root = makeRoot();
    write(root, 'config.yaml', 'language: ja\n');
    write(root, 'workflows/valid.yaml', `name: valid
max_steps: 1
initial_step: only
steps:
  - name: only
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(runProjectTemplateDoctor(root)).toEqual({
      passed: true,
      checks: [
        { kind: 'config', path: 'config.yaml', passed: true, diagnostics: [] },
        { kind: 'workflow', path: 'workflows/valid.yaml', passed: true, diagnostics: [] },
      ],
    });
  });

  it('returns bounded path-redacted diagnostics for invalid content', () => {
    const root = makeRoot();
    write(root, 'config.yaml', 'language: [\n');
    write(root, 'workflows/invalid.yaml', 'name: invalid\nsteps: nope\n');

    const report = runProjectTemplateDoctor(root);

    expect(report.passed).toBe(false);
    expect(report.checks.map((check) => check.path)).toEqual([
      'config.yaml',
      'workflows/invalid.yaml',
    ]);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it('fails closed on a symlink in the workflow tree', () => {
    const root = makeRoot();
    const outside = join(root, 'outside.yaml');
    writeFileSync(outside, 'name: outside\n');
    symlinkSync(outside, join(root, '.takt', 'workflows', 'linked.yaml'));

    expect(runProjectTemplateDoctor(root)).toEqual({
      passed: false,
      checks: [{
        kind: 'workflow-tree',
        path: 'workflows',
        passed: false,
        diagnostics: ['unsafe or unreadable workflow tree'],
      }],
    });
  });
});
