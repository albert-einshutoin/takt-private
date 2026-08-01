import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import {
  captureTaktpackOutputPrecondition,
  syncTaktpackOutputDirectory,
  writeTaktpackWithOutputPrecondition,
  writeTaktpackWithIoSeam,
  type TaktpackWriterIoPhase,
} from '../../features/project-template/archive-writer.js';

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
  it('exposes only a path-redacted deterministic projection from an output authority', async () => {
    const root = makeRoot();
    const output = join(root, 'projection.taktpack');

    const first = await captureTaktpackOutputPrecondition(output);
    const second = await captureTaktpackOutputPrecondition(output);

    expect(first.projection).toEqual(second.projection);
    expect(first.projection).toMatchObject({
      schemaVersion: '1.0',
      pathSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      target: { state: 'absent' },
    });
    expect(JSON.stringify(first.projection)).not.toContain(root);
    expect(Object.keys(first.authority)).toEqual([]);
  });

  it('rejects cloned, reused, and foreign-path output authorities before creating temp files', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'authorized.taktpack');
    const foreign = join(root, 'foreign.taktpack');
    const clonedCapture = await captureTaktpackOutputPrecondition(output);

    await expect(writeTaktpackWithOutputPrecondition(
      output,
      plan,
      { ...clonedCapture.authority } as typeof clonedCapture.authority,
    )).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_TARGET' });

    const foreignCapture = await captureTaktpackOutputPrecondition(output);
    await expect(writeTaktpackWithOutputPrecondition(
      foreign,
      plan,
      foreignCapture.authority,
    )).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_TARGET' });

    const singleUse = await captureTaktpackOutputPrecondition(output);
    await writeTaktpackWithOutputPrecondition(output, plan, singleUse.authority);
    rmSync(output);
    await expect(writeTaktpackWithOutputPrecondition(
      output,
      plan,
      singleUse.authority,
    )).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_TARGET' });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('does not let force authorize an absent target that appeared after capture', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'appeared.taktpack');
    const captured = await captureTaktpackOutputPrecondition(output);
    writeFileSync(output, 'foreign');

    await expect(writeTaktpackWithOutputPrecondition(
      output,
      plan,
      captured.authority,
      { force: true },
    )).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_TARGET' });
    expect(readFileSync(output, 'utf8')).toBe('foreign');
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('rejects a parent identity swap captured by the output authority', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const outputDirectory = join(root, 'exports');
    const movedDirectory = join(root, 'moved-exports');
    mkdirSync(outputDirectory);
    const output = join(outputDirectory, 'pack.taktpack');
    const captured = await captureTaktpackOutputPrecondition(output);
    renameSync(outputDirectory, movedDirectory);
    mkdirSync(outputDirectory);

    await expect(writeTaktpackWithOutputPrecondition(
      output,
      plan,
      captured.authority,
      { force: true },
    )).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_TARGET' });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(movedDirectory)).toEqual([]);
    expect(readdirSync(outputDirectory)).toEqual([]);
  });

  it('revalidates exact target identity at the publication boundary even with force', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'replaced-at-publish.taktpack');
    writeFileSync(output, 'approved');
    const captured = await captureTaktpackOutputPrecondition(output);

    await expect(writeTaktpackWithOutputPrecondition(
      output,
      plan,
      captured.authority,
      { force: true },
      {
        onPhase(phase) {
          if (phase === 'publish') {
            rmSync(output);
            writeFileSync(output, 'replacement');
          }
        },
      },
    )).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_TARGET' });
    expect(readFileSync(output, 'utf8')).toBe('replacement');
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

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

  it('catches a missing output-directory pipeline rejection without crashing or leaking paths', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const marker = 'LEAK_CANARY_OUTPUT';
    const output = join(root, marker, 'pack.taktpack');

    const error = await writeTaktpack(output, plan).catch((caught: unknown) => caught);
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toMatchObject({
      code: 'ARCHIVE_WRITE_FAILED',
      field: 'output',
      artifactState: 'not-published',
    });
    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    ['pipeline', 'ARCHIVE_WRITE_FAILED', 'not-published'],
    ['archive-read', 'ARCHIVE_WRITE_FAILED', 'not-published'],
    ['file-fsync', 'DURABILITY_FAILED', 'not-published'],
    ['publish', 'ARCHIVE_WRITE_FAILED', 'not-published'],
    ['directory-fsync', 'DURABILITY_FAILED', 'published'],
  ] as const)(
    'normalizes a %s I/O fault and reports artifact state',
    async (phase, code, artifactState) => {
      const root = makeRoot();
      writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
      const plan = await makePlan(root);
      const output = join(root, `${phase}.taktpack`);

      const error = await writeTaktpackWithIoSeam(output, plan, {}, {
        onPhase(currentPhase) {
          if (currentPhase === phase) throw new Error(`raw ${phase} ${root}`);
        },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code, artifactState });
      expect(String(error)).not.toContain(root);
      expect(existsSync(output)).toBe(artifactState === 'published');
    },
  );

  it('does not let a cleanup failure mask the primary pipeline failure', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const phases: TaktpackWriterIoPhase[] = [];

    const error = await writeTaktpackWithIoSeam(join(root, 'primary.taktpack'), plan, {}, {
      onPhase(phase) {
        phases.push(phase);
        if (phase === 'pipeline' || phase === 'cleanup') {
          throw new Error(`raw ${phase} ${root}`);
        }
      },
    }).catch((caught: unknown) => caught);

    expect(phases).toContain('cleanup');
    expect(error).toMatchObject({
      code: 'ARCHIVE_WRITE_FAILED',
      artifactState: 'not-published',
    });
    expect(String(error)).not.toContain(root);
  });

  it('records publication before a post-link temp unlink failure', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'post-link.taktpack');

    const error = await writeTaktpackWithIoSeam(output, plan, {}, {
      onPhase(phase) {
        if (phase === 'post-link-unlink') {
          throw new Error(`raw unlink ${root}`);
        }
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'CLEANUP_FAILED',
      artifactState: 'published',
      field: 'temporaryArchive',
    });
    expect(existsSync(output)).toBe(true);
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(String(error)).not.toContain(root);
  });

  it('does not let final cleanup mask a post-link unlink failure', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'post-link-primary.taktpack');

    const error = await writeTaktpackWithIoSeam(output, plan, {}, {
      onPhase(phase) {
        if (phase === 'post-link-unlink' || phase === 'cleanup') {
          throw new Error(`raw ${phase} ${root}`);
        }
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'CLEANUP_FAILED',
      artifactState: 'published',
      field: 'temporaryArchive',
    });
    expect(existsSync(output)).toBe(true);
    expect(String(error)).not.toContain(root);
  });

  it('records forced rename publication before directory durability failure', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'forced-state.taktpack');
    writeFileSync(output, 'old');

    const error = await writeTaktpackWithIoSeam(output, plan, { force: true }, {
      onPhase(phase) {
        if (phase === 'directory-fsync') throw new Error(`raw fsync ${root}`);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'DURABILITY_FAILED',
      artifactState: 'published',
    });
    expect(readFileSync(output, 'utf8')).not.toBe('old');
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

  it.each([
    'archive-read',
    'file-fsync',
    'publish',
  ] as const)(
    'honors an abort requested by the %s seam before publication',
    async (abortPhase) => {
      const root = makeRoot();
      writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
      const plan = await makePlan(root);
      const output = join(root, `${abortPhase}-aborted.taktpack`);
      const controller = new AbortController();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);

      try {
        const error = await writeTaktpackWithIoSeam(
          output,
          plan,
          { signal: controller.signal },
          {
            onPhase(phase) {
              if (phase === abortPhase) controller.abort();
            },
          },
        ).catch((caught: unknown) => caught);
        await new Promise((resolve) => setImmediate(resolve));

        expect(error).toMatchObject({ name: 'AbortError' });
        expect(existsSync(output)).toBe(false);
        expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  it('finishes directory durability after publication even if cancellation arrives there', async () => {
    const root = makeRoot();
    writeProjectFile(root, 'workflows/a.yaml', 'name: a\n');
    const plan = await makePlan(root);
    const output = join(root, 'published-before-abort.taktpack');
    const controller = new AbortController();

    const result = await writeTaktpackWithIoSeam(
      output,
      plan,
      { signal: controller.signal },
      {
        onPhase(phase) {
          if (phase === 'directory-fsync') controller.abort();
        },
      },
    );

    expect(controller.signal.aborted).toBe(true);
    expect(result.outputPath).toBe(output);
    expect(existsSync(output)).toBe(true);
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
