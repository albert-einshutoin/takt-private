import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectProductPolicyReplayCandidatesFromEvents,
  loadProductPolicyReplayFixtureDirectory,
  runProductPolicyReplayCorpus,
  writeProductPolicyReplayCandidateFile,
} from '../devloopd/productPolicyReplayCorpus.js';
import { appendDevloopLedgerEvent, buildDevloopLedgerEvent } from '../devloopd/ledger.js';

describe('devloopd product-policy replay corpus', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = join(tmpdir(), `takt-policy-replay-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempRoots.push(dir);
    return dir;
  }

  it('collects sanitized candidates from ledger decisions', () => {
    const candidates = collectProductPolicyReplayCandidatesFromEvents([
      buildDevloopLedgerEvent('devloop_automation_state', {
        changedPaths: ['/Users/shutoide/private/src/security.ts'],
        title: 'feat: allow unauthenticated access',
        body: 'token=sk-secret-test should never be persisted',
        diff: [
          'diff --git a//Users/shutoide/private/src/security.ts b//Users/shutoide/private/src/security.ts',
          '@@ -1,3 +1,4 @@',
          '+const apiKey = "sk-secret-test";',
          '+allowUnauthenticatedRequests = true;',
        ].join('\n'),
        productPolicyImpact: {
          impact: 'product_policy',
          reasons: ['security posture changed at /Users/shutoide/private/src/security.ts'],
        },
        status: 'blocked',
      }, new Date('2026-07-06T00:00:00.000Z')),
    ]);
    const serialized = JSON.stringify(candidates);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      expectedImpact: null,
      classifierImpact: 'product_policy',
      humanOverride: 'human_review',
    });
    expect(serialized).toContain('[LOCAL_PATH]');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('/Users/shutoide');
    expect(serialized).not.toContain('sk-secret-test');
  });

  it('writes candidate files outside active fixtures by default', () => {
    const repoPath = makeTempDir();
    const ledgerPath = join(repoPath, '.devloop', 'ledger.jsonl');
    appendDevloopLedgerEvent(ledgerPath, buildDevloopLedgerEvent('devloop_automation_state', {
      changedPaths: ['src/app/cli/index.ts'],
      title: 'feat: rename public option',
      productPolicyImpact: { impact: 'product_policy', reasons: ['public API contract changed'] },
      status: 'blocked',
    }, new Date('2026-07-06T00:00:00.000Z')));

    const result = writeProductPolicyReplayCandidateFile({ repoPath, ledgerPath: '.devloop/ledger.jsonl' });
    const file = JSON.parse(readFileSync(result.path, 'utf-8')) as { cases?: Array<{ expectedImpact?: unknown }> };

    expect(result.path).toBe(join(repoPath, '.devloop', 'product-policy-replay-candidates.json'));
    expect(file.cases).toHaveLength(1);
    expect(file.cases?.[0]?.expectedImpact).toBeNull();
  });

  it('requires active fixtures to carry explicit expected labels', () => {
    const fixtureDir = makeTempDir();
    writeFileSync(join(fixtureDir, 'missing-label.json'), JSON.stringify({
      version: 1,
      cases: [{
        id: 'missing-label',
        input: { changedPaths: ['src/app.ts'], title: 'chore: local refactor' },
      }],
    }), 'utf-8');

    const loaded = loadProductPolicyReplayFixtureDirectory(fixtureDir);
    const report = runProductPolicyReplayCorpus({ repoPath: process.cwd(), fixtureDir });

    expect(loaded.fixtures).toHaveLength(0);
    expect(loaded.errors.join('\n')).toContain('expectedImpact');
    expect(report.passed).toBe(false);
    expect(report.validationErrors.join('\n')).toContain('expectedImpact');
  });

  it('fails replay on product-policy false negatives', () => {
    const fixtureDir = makeTempDir();
    writeFileSync(join(fixtureDir, 'false-negative.json'), JSON.stringify({
      version: 1,
      cases: [{
        id: 'false-negative',
        expectedImpact: 'product_policy',
        input: {
          changedPaths: ['src/local/refactor.ts'],
          title: 'chore: rename local variable',
          diff: 'diff --git a/src/local/refactor.ts b/src/local/refactor.ts\n@@\n+const value = 1;',
        },
      }],
    }), 'utf-8');

    const report = runProductPolicyReplayCorpus({ repoPath: process.cwd(), fixtureDir });

    expect(report.passed).toBe(false);
    expect(report.eval.falseNegatives).toBe(1);
    expect(report.eval.mismatches[0]).toMatchObject({
      id: 'false-negative',
      expectedImpact: 'product_policy',
      actualImpact: 'implementation',
    });
  });
});
