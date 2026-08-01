import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  materializeTaktpackContents,
  materializeTaktpackContentsWithIoSeam,
  type TaktpackInspectorIoPhase,
} from '../../features/project-template/archive-inspector.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-materialize-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function pack(projectRoot: string): Promise<string> {
  const contents = {
    'agents/reviewer.md': 'review carefully\n',
    'workflows/review.yaml': 'name: review\n',
    'workflows/review-copy.yaml': 'name: review\n',
  };
  for (const [path, content] of Object.entries(contents)) {
    const absolute = join(projectRoot, '.takt', path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  const plan = await createProjectTemplateExportPlan(projectRoot, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: 'a'.repeat(40),
    },
  });
  const output = join(projectRoot, 'template.taktpack');
  await writeTaktpack(output, plan);
  return output;
}

describe('bounded taktpack content materializer', () => {
  it('reuses canonical streaming inspection and returns manifest-matching blobs only', async () => {
    const projectRoot = root();
    const archive = await pack(projectRoot);

    const result = await materializeTaktpackContents(archive, {
      currentTaktVersion: '0.48.0',
    });

    expect(result.inspection.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inspection.compatibility.status).toBe('compatible');
    expect(result.contents.map((entry) => entry.path)).toEqual([
      'workflows/review-copy.yaml',
      'workflows/review.yaml',
    ]);
    expect(result.contents.map((entry) => Buffer.from(entry.content).toString('utf8')))
      .toEqual(['name: review\n', 'name: review\n']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.contents)).toBe(true);
    expect(result.contents.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('returns independent bytes for duplicate content and across calls', async () => {
    const projectRoot = root();
    const archive = await pack(projectRoot);
    const first = await materializeTaktpackContents(archive);
    const duplicateA = first.contents.find(
      (entry) => entry.path === 'workflows/review.yaml',
    )!;
    const duplicateB = first.contents.find(
      (entry) => entry.path === 'workflows/review-copy.yaml',
    )!;

    expect(duplicateA.content).not.toBe(duplicateB.content);
    duplicateA.content[0] = 0x58;
    expect(Buffer.from(duplicateB.content).toString('utf8')).toBe('name: review\n');
    const second = await materializeTaktpackContents(archive);
    expect(Buffer.from(second.contents.find(
      (entry) => entry.path === 'workflows/review.yaml',
    )!.content).toString('utf8')).toBe('name: review\n');
  });

  it('closes its archive descriptor on success and on semantic failure', async () => {
    const projectRoot = root();
    const archive = await pack(projectRoot);
    const phases: TaktpackInspectorIoPhase[] = [];
    await materializeTaktpackContentsWithIoSeam(archive, {}, {
      onPhase(phase) {
        phases.push(phase);
      },
    });
    expect(phases.at(-1)).toBe('close');

    const failedPhases: TaktpackInspectorIoPhase[] = [];
    await expect(materializeTaktpackContentsWithIoSeam(archive, {}, {
      onPhase(phase) {
        failedPhases.push(phase);
        if (phase === 'final-stat') throw new Error('fault');
      },
    })).rejects.toMatchObject({ code: 'ARCHIVE_READ_FAILED' });
    expect(failedPhases.at(-1)).toBe('close');
  });
});
