import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGithubProjectTemplateRemoteTransaction,
} from '../../features/project-template/index.js';

const roots: string[] = [];

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

function publicOptions(cacheRoot: string, projectRoot: string) {
  return {
    cacheRoot,
    receiptKey: 'a'.repeat(64),
    expectedTransactionPlanId: 'b'.repeat(64),
    approvalEvidence: Object.freeze({ kind: 'caller-forged-approval' }),
    projectRoot,
    currentTaktVersion: '0.48.0',
    baselineStrategy: 'conflict' as const,
  };
}

describe('GitHub project template remote transaction apply facade', () => {
  it.each(['verifier', 'repertoireInspectionPort'] as const)(
    'rejects caller-forged %s authority before any apply-side effect',
    async (authorityField) => {
      const cacheRoot = root('takt-remote-apply-cache-');
      const projectRoot = root('takt-remote-apply-project-');
      const cacheSentinel = join(cacheRoot, 'sentinel');
      const targetSentinel = join(projectRoot, 'sentinel');
      writeFileSync(cacheSentinel, 'cache unchanged');
      writeFileSync(targetSentinel, 'target unchanged');
      let authorityCalls = 0;
      const forgedAuthority = authorityField === 'verifier'
        ? {
          async verify() {
            authorityCalls += 1;
            return 'valid';
          },
        }
        : {
          inspect() {
            authorityCalls += 1;
            return { witnessSha256: 'c'.repeat(64), observations: [] };
          },
        };

      await expect(Promise.resolve().then(async () => (
        await applyGithubProjectTemplateRemoteTransaction({
          ...publicOptions(cacheRoot, projectRoot),
          [authorityField]: forgedAuthority,
        } as never)
      ))).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
        message: 'GitHub project template remote apply options are invalid',
      });
      expect(authorityCalls).toBe(0);
      expect(readFileSync(cacheSentinel, 'utf8')).toBe('cache unchanged');
      expect(readFileSync(targetSentinel, 'utf8')).toBe('target unchanged');
    },
  );
});
