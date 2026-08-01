import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTaktpack } from '../../features/project-template/archive-writer.js';
import { createProjectTemplateExportPlan } from '../../features/project-template/export-plan.js';
import {
  deriveLocalProjectTemplateTransaction,
} from '../../features/project-template/local-transaction-derivation.js';
import { parseTemplateLock } from '../../features/project-template/lock.js';
import {
  parseProjectTemplateRepertoireDependencyLockJson,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  parseProjectTemplateSourceProvenanceJson,
} from '../../features/project-template/source-provenance.js';

const roots: string[] = [];
const COMMIT = 'a'.repeat(40);

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function fixture(): Promise<{ archivePath: string; targetRoot: string }> {
  const sourceRoot = root('takt-local-derive-source-');
  const sourcePath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  writeFileSync(join(sourceRoot, '.takt', 'config.yaml'), 'model: local\n');
  const plan = await createProjectTemplateExportPlan(sourceRoot, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: { kind: 'local', uri: '.', ref: 'workspace', commit: COMMIT },
  });
  const archivePath = join(sourceRoot, 'template.taktpack');
  await writeTaktpack(archivePath, plan);
  return { archivePath, targetRoot: root('takt-local-derive-target-') };
}

describe('local project template transaction derivation', () => {
  it('derives a sealed first-install transaction from an exact 000 cohort', async () => {
    const { archivePath, targetRoot } = await fixture();
    const derived = await deriveLocalProjectTemplateTransaction({
      archivePath,
      projectRoot: targetRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'adopt-identical',
    });

    const contentLock = parseTemplateLock(JSON.parse(
      new TextDecoder().decode(derived.companionOutputs.contentLock),
    ));
    const dependencyLock = parseProjectTemplateRepertoireDependencyLockJson(
      derived.companionOutputs.repertoireLock,
    );
    const sourceLock = parseProjectTemplateSourceProvenanceJson(
      derived.companionOutputs.sourceProvenance,
    );
    expect(derived.preview.transactionPlanId).toMatch(/^[a-f0-9]{64}$/);
    expect(derived.preview.bindings.previousLocksSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(contentLock.source).toEqual({
      kind: 'local', uri: '.', ref: 'workspace', commit: COMMIT,
    });
    expect(dependencyLock.dependencies).toEqual([]);
    expect(sourceLock.source).toMatchObject({
      kind: 'local-import', uri: '.', ref: 'workspace', commit: COMMIT,
    });
    expect(sourceLock.dependencyVerification).toMatchObject({
      method: 'local-empty-v1', count: 0,
    });
    expect(derived.contentEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'workflows/review.yaml',
        action: 'write',
        mode: '0644',
      }),
    ]));
    expect(derived.mergeBaselines).toEqual([
      expect.objectContaining({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        content: new TextEncoder().encode('model: local\n'),
      }),
    ]);
  });

  it('derives an exact existing 111 cohort without changing authority kind', async () => {
    const { archivePath, targetRoot } = await fixture();
    const first = await deriveLocalProjectTemplateTransaction({
      archivePath,
      projectRoot: targetRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'adopt-identical',
    });
    for (const [path, content] of Object.entries(first.companionOutputs)) {
      const filename = path === 'contentLock'
        ? '.takt-template-lock.json'
        : path === 'repertoireLock'
          ? '.takt-template-repertoire-lock.json'
          : '.takt-template-source-lock.json';
      writeFileSync(join(targetRoot, filename), content);
    }
    const content = first.contentEntries[0];
    if (content?.action !== 'write') throw new Error('expected content write');
    mkdirSync(dirname(join(targetRoot, '.takt', content.path)), { recursive: true });
    writeFileSync(join(targetRoot, '.takt', content.path), content.content);

    const existing = await deriveLocalProjectTemplateTransaction({
      archivePath,
      projectRoot: targetRoot,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'adopt-identical',
    });

    expect(existing.preview.hardConflict).toBe(false);
    expect(existing.preview.bindings).toMatchObject({
      previousRepertoireLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      previousSourceProvenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(parseProjectTemplateSourceProvenanceJson(
      existing.companionOutputs.sourceProvenance,
    ).source).toHaveProperty('kind', 'local-import');
  });
});
