import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  inspectTaktpack,
  writeTaktpack,
} from '../../src/index.js';

const roots: string[] = [];

function projectWith(path: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-e2e-'));
  roots.push(root);
  const file = join(root, '.takt', path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return root;
}

const options = {
  packVersion: '1.0.0',
  takt: { minVersion: '0.48.0' },
  source: {
    kind: 'local' as const,
    uri: '.',
    ref: 'workspace' as const,
    commit: 'a'.repeat(40),
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template pack E2E', () => {
  it('exports and inspects a content-addressed pack without extraction', async () => {
    const root = projectWith('workflows/review.yaml', 'name: review\n');
    const plan = await createProjectTemplateExportPlan(root, options);
    const output = join(root, 'portable.taktpack');

    await writeTaktpack(output, plan);
    const inspected = await inspectTaktpack(output, { currentTaktVersion: '0.48.0' });

    expect(inspected.compatibility.status).toBe('compatible');
    expect(inspected.manifest.entries.map((entry) => entry.path)).toEqual([
      'workflows/review.yaml',
    ]);
  });

  it.each([
    ['secret', 'workflows/deploy.yaml', 'Authorization: Bearer synthetic-token-value'],
    ['absolute path', 'workflows/deploy.yaml', 'cache: /Users/example/private/cache'],
  ])('rejects %s content before creating an export plan', async (_label, path, content) => {
    const root = projectWith(path, content);

    await expect(createProjectTemplateExportPlan(root, options)).rejects.toMatchObject({
      code: 'INVALID_EXPORT_PLAN',
    });
  });

  it('round-trips a valid 2,600-entry pack whose control documents exceed 1 MiB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'taktpack-large-e2e-'));
    roots.push(root);
    const longSegments = [
      'a'.repeat(110),
      'b'.repeat(110),
      'c'.repeat(110),
      'd'.repeat(110),
    ];
    for (let index = 0; index < 2_600; index += 1) {
      const path = join(
        root,
        '.takt',
        'workflows',
        ...longSegments,
        `review-${index.toString().padStart(4, '0')}-${'e'.repeat(40)}.yaml`,
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `name: review-${index}\n`);
    }
    const plan = await createProjectTemplateExportPlan(root, options);
    const output = join(root, 'large.taktpack');

    await writeTaktpack(output, plan);
    const archive = readFileSync(output);
    const packBytes = Number.parseInt(archive.subarray(124, 136).toString('ascii'), 8);
    const manifestHeader = 512 + Math.ceil(packBytes / 512) * 512;
    const manifestBytes = Number.parseInt(
      archive.subarray(manifestHeader + 124, manifestHeader + 136).toString('ascii'),
      8,
    );
    const inspected = await inspectTaktpack(output);

    expect(packBytes).toBeGreaterThan(1.6 * 1024 * 1024);
    expect(manifestBytes).toBeGreaterThan(1.55 * 1024 * 1024);
    expect(inspected.manifest.entries).toHaveLength(2_600);
  }, 120_000);
});
