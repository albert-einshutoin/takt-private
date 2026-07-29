import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taktpack-writer-'));
  roots.push(root);
  return root;
}

function writeProjectFile(root: string, path: string, content: string): void {
  const absolutePath = join(root, '.takt', path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function makePlan(root: string) {
  return createProjectTemplateExportPlan(root, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: 'a'.repeat(40),
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('taktpack deterministic writer', () => {
  it('produces identical bytes from the same export plan', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/b.yaml', 'name: b\n');
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const first = join(root, 'first.taktpack');
    const second = join(root, 'second.taktpack');

    const firstResult = await writeTaktpack(first, plan);
    const secondResult = await writeTaktpack(second, plan);

    expect(readFileSync(first)).toEqual(readFileSync(second));
    expect(firstResult.archiveSha256).toBe(secondResult.archiveSha256);
  });

  it('rejects a source that changed after planning', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    writeProjectFile(root, 'workflows/a.yaml', 'name: changed\n');
    const output = join(root, 'changed.taktpack');

    await expect(writeTaktpack(output, plan)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('does not overwrite an existing output without force', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'existing.taktpack');
    writeFileSync(output, 'keep-me');

    const error = await writeTaktpack(output, plan).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(String(error)).not.toContain(root);
    expect(readFileSync(output, 'utf8')).toBe('keep-me');
  });

  it('replaces an existing output only after the new pack is complete when forced', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'existing.taktpack');
    writeFileSync(output, 'old-pack');

    await writeTaktpack(output, plan, { force: true });

    expect(readFileSync(output, 'utf8')).not.toBe('old-pack');
  });

  it('rejects a symlink output target even when force is enabled', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const target = join(root, 'target.txt');
    const output = join(root, 'linked.taktpack');
    writeFileSync(target, 'keep-target');
    symlinkSync(target, output);

    await expect(writeTaktpack(output, plan, { force: true })).rejects.toMatchObject({
      code: 'UNSAFE_OUTPUT_TARGET',
    });
    expect(readFileSync(target, 'utf8')).toBe('keep-target');
  });

  it('leaves no partial artifact when export is aborted', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'aborted.taktpack');
    const controller = new AbortController();
    controller.abort();

    await expect(writeTaktpack(output, plan, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
