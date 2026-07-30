import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  ProjectTemplateApplyStorageError,
} from '../../features/project-template/apply-storage.js';
import {
  MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES,
  readProjectTemplateMergeBaseline,
  writeProjectTemplateMergeBaseline,
} from '../../features/project-template/merge-baseline-store.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-merge-baseline-'));
  roots.push(root);
  return root;
}

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project template merge baseline store', () => {
  it('stores and reuses verified immutable content', async () => {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: makeRoot(),
    });
    const content = Buffer.from('provider: codex\n');
    const expectedSha256 = digest(content);

    await expect(writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256,
      content,
    })).resolves.toBe('stored');
    await expect(writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256,
      content,
    })).resolves.toBe('reused');
    await expect(readProjectTemplateMergeBaseline({
      storage,
      expectedSha256,
    })).resolves.toEqual(content);
    expect(statSync(join(storage.baselinesRoot, expectedSha256)).mode & 0o777)
      .toBe(0o600);
  });

  it('rejects invalid digests, mismatched content, and oversized YAML', async () => {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: makeRoot(),
    });
    const content = Buffer.from('language: ja\n');

    await expect(writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256: digest(content).toUpperCase(),
      content,
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await expect(writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256: digest(Buffer.from('different\n')),
      content,
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await expect(writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256: digest(Buffer.alloc(
        MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES + 1,
      )),
      content: Buffer.alloc(MAX_PROJECT_TEMPLATE_MERGE_BASELINE_BYTES + 1),
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it.each(['mode', 'hardlink', 'symlink'] as const)(
    'fails closed for an unsafe %s baseline',
    async (kind) => {
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: makeRoot(),
      });
      const content = Buffer.from('base_branch: main\n');
      const expectedSha256 = digest(content);
      const path = join(storage.baselinesRoot, expectedSha256);
      await writeProjectTemplateMergeBaseline({
        storage,
        expectedSha256,
        content,
      });

      if (kind === 'mode') chmodSync(path, 0o644);
      if (kind === 'hardlink') linkSync(path, `${path}.alias`);
      if (kind === 'symlink') {
        rmSync(path);
        const external = join(storage.repoRoot, 'external.yaml');
        writeFileSync(external, content);
        symlinkSync(external, path);
      }

      await expect(readProjectTemplateMergeBaseline({
        storage,
        expectedSha256,
      })).rejects.toBeInstanceOf(Error);
    },
  );

  it.each(['file-fsync', 'directory-fsync'] as const)(
    're-establishes durability after a prior %s failure',
    async (operation) => {
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: makeRoot(),
      });
      const content = Buffer.from('auto_fetch: false\n');
      const expectedSha256 = digest(content);
      let injected = false;
      const faultIo = createProjectTemplateApplyStorageIo({
        before(candidate, path) {
          const targetMatches = operation === 'file-fsync'
            ? path === join(storage.baselinesRoot, expectedSha256)
            : path === storage.baselinesRoot;
          if (!injected && candidate === operation && targetMatches) {
            injected = true;
            throw new Error(`injected ${operation}`);
          }
        },
      });

      await expect(writeProjectTemplateMergeBaseline({
        storage: { ...storage, io: faultIo },
        expectedSha256,
        content,
      })).rejects.toBeInstanceOf(Error);
      expect(injected).toBe(true);
      expect(readFileSync(join(storage.baselinesRoot, expectedSha256)))
        .toEqual(content);

      await expect(writeProjectTemplateMergeBaseline({
        storage,
        expectedSha256,
        content,
      })).resolves.toBe('reused');
    },
  );

  it('surfaces typed hash errors without exposing repository paths', async () => {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: makeRoot(),
    });
    const error = await writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256: 'not-a-hash',
      content: Buffer.alloc(0),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectTemplateApplyStorageError);
    expect((error as Error).message).not.toContain(storage.repoRoot);
  });
});
