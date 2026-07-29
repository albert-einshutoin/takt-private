import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
