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
import { syncTaktpackOutputDirectory } from '../../features/project-template/archive-writer.js';

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
  it('treats directory fsync as unsupported on Windows without reporting failure', () => {
    let calls = 0;

    const result = syncTaktpackOutputDirectory('C:\\pack', 'win32', () => {
      calls += 1;
      throw new Error('directory handles are unsupported');
    });

    expect(result).toBe('unsupported');
    expect(calls).toBe(0);
  });

  it('keeps POSIX directory durability failures observable before claiming success', () => {
    expect(() => syncTaktpackOutputDirectory('/pack', 'darwin', () => {
      throw new Error('fsync failed');
    })).toThrow('fsync failed');
  });

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

  it('writes canonical USTAR identity, numeric, checksum, and reserved header bytes', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'header.taktpack');

    await writeTaktpack(output, plan);

    const header = readFileSync(output).subarray(0, 512);
    expect(header.subarray(100, 108)).toEqual(Buffer.from('0000644\u0000', 'binary'));
    expect(header.subarray(108, 116)).toEqual(Buffer.from('0000000\u0000', 'binary'));
    expect(header.subarray(116, 124)).toEqual(Buffer.from('0000000\u0000', 'binary'));
    expect(header.subarray(136, 148)).toEqual(Buffer.from('00000000000\u0000', 'binary'));
    expect(header.subarray(148, 156).toString('binary')).toMatch(/^[0-7]{6}\u0000 $/);
    expect(header.subarray(265, 329)).toEqual(Buffer.alloc(64));
    expect(header.subarray(329, 337)).toEqual(Buffer.from('0000000\u0000', 'binary'));
    expect(header.subarray(337, 345)).toEqual(Buffer.from('0000000\u0000', 'binary'));
    expect(header.subarray(500, 512)).toEqual(Buffer.alloc(12));
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

  it('reopens and verifies every source when multiple paths share one blob hash', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: same\n');
    writeProjectFile(root, 'workflows/b.yaml', 'name: same\n');
    const plan = await makePlan(root);
    writeProjectFile(root, 'workflows/a.yaml', 'name: evil\n');
    const output = join(root, 'deduplicated.taktpack');

    await expect(writeTaktpack(output, plan)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    expect(existsSync(output)).toBe(false);
  });

  it('redacts absolute source paths when a planned source disappears', async () => {
    const root = makeRoot();
    const marker = 'LEAK_CANARY_SOURCE';
    writeProjectFile(root, `workflows/${marker}.yaml`, 'name: source\n');
    const plan = await makePlan(root);
    rmSync(join(root, '.takt', 'workflows', `${marker}.yaml`));

    const error = await writeTaktpack(join(root, 'missing.taktpack'), plan)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain(marker);
  });

  it('enforces the archive ceiling before reopening sources or creating output', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    writeProjectFile(root, 'workflows/a.yaml', 'name: changed\n');

    await expect(writeTaktpack(join(root, 'limited.taktpack'), plan, {
      limits: { maxArchiveBytes: 1 },
    })).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' });
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

  it('rejects a copied plan with recomputed-looking control data before creating a temp file', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const forged = {
      ...plan,
      report: {
        ...plan.report,
        counts: { ...plan.report.counts, merge: 99 },
      },
    };
    const output = join(root, 'forged.taktpack');

    await expect(writeTaktpack(output, forged)).rejects.toMatchObject({
      code: 'INVALID_EXPORT_PLAN',
      field: 'plan',
    });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
