import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProjectTemplateBackupFile,
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  pruneProjectTemplateBackupGenerations,
  readProjectTemplateBackupManifest,
  removeProjectTemplateBackupGeneration,
  removeProjectTemplateStagingTransaction,
  writeProjectTemplateApplyJournal,
  writeProjectTemplateBackupManifest,
  writeProjectTemplateStagingFile,
  type ProjectTemplateApplyJournal,
  type ProjectTemplateApplyStorageIoOperation,
  type ProjectTemplateBackupManifest,
} from '../../features/project-template/apply-storage.js';

const roots: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-apply-storage-'));
  roots.push(root);
  mkdirSync(join(root, '.takt'), { mode: 0o700 });
  return root;
}

function hash(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifest(backupId: string, createdAt: string): ProjectTemplateBackupManifest {
  return {
    schemaVersion: '1.0',
    backupId,
    planId: 'a'.repeat(64),
    preconditionToken: 'b'.repeat(64),
    createdAt,
    createdTargetDirectories: [],
    entries: [],
  };
}

function journal(): ProjectTemplateApplyJournal {
  return {
    schemaVersion: '1.0',
    transactionId: 'transaction-1',
    planId: 'a'.repeat(64),
    backupId: 'backup-1',
    state: 'prepared',
    completedOperations: [],
    createdTargetDirectories: [],
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project template apply storage', () => {
  it('creates a private repo-local control root on the target filesystem', async () => {
    const repoPath = makeRepo();

    const storage = await initializeProjectTemplateApplyStorage({ repoPath });

    expect(storage.controlRoot).toBe(join(storage.repoRoot, '.takt-template-state'));
    expect(storage.targetRoot).toBe(join(storage.repoRoot, '.takt'));
    expect(storage.lockTargetPath).toBe(join(storage.repoRoot, '.takt-template-lock.json'));
    expect(lstatSync(storage.controlRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.stagingRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.backupsRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.controlRoot).dev).toBe(lstatSync(storage.targetRoot).dev);
    expect(readFileSync(join(storage.controlRoot, '.gitignore'), 'utf8')).toBe('*\n');
    expect(lstatSync(join(storage.controlRoot, '.gitignore')).mode & 0o077).toBe(0);
  });

  it('writes a hash-verified 0600 staging file and rejects unsafe paths', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const content = Buffer.from('language: ja\n');

    const staged = await writeProjectTemplateStagingFile({
      storage,
      transactionId: 'transaction-1',
      target: { kind: 'template-entry', path: 'config/config.yaml' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
    });

    expect(readFileSync(staged.absolutePath)).toEqual(content);
    expect(lstatSync(staged.absolutePath).mode & 0o777).toBe(0o600);
    expect(staged).toMatchObject({
      target: { kind: 'template-entry', path: 'config/config.yaml' },
      sha256: hash(content),
      bytes: content.byteLength,
      targetMode: '0644',
    });
    await expect(writeProjectTemplateStagingFile({
      storage,
      transactionId: 'transaction-1',
      target: { kind: 'template-entry', path: '../outside' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
    })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('stages the formal template lock outside .takt without accepting a caller path', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const content = Buffer.from('{"schemaVersion":"1.0"}\n');

    const staged = await writeProjectTemplateStagingFile({
      storage,
      transactionId: 'transaction-1',
      target: { kind: 'lock' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
    });

    expect(staged.target).toEqual({ kind: 'lock' });
    expect(staged.relativePath).toBe('lock/.takt-template-lock.json');
    expect(staged.absolutePath.startsWith(storage.stagingRoot)).toBe(true);
    expect(storage.lockTargetPath).toBe(join(storage.repoRoot, '.takt-template-lock.json'));
  });

  it('rejects an existing control root with overly broad permissions', async () => {
    const repoPath = makeRepo();
    const controlRoot = join(repoPath, '.takt-template-state');
    mkdirSync(controlRoot, { mode: 0o700 });
    chmodSync(controlRoot, 0o755);

    await expect(initializeProjectTemplateApplyStorage({ repoPath }))
      .rejects.toMatchObject({ code: 'UNSAFE_CONTROL_ROOT' });
    expect(lstatSync(controlRoot).mode & 0o777).toBe(0o755);
  });

  it.each([
    ['symlink', (path: string, source: string) => symlinkSync(source, path)],
    ['hardlink', (path: string, source: string) => linkSync(source, path)],
  ])('rejects a %s instead of collecting it into a backup', async (_label, createLink) => {
    const repoPath = makeRepo();
    const source = join(repoPath, 'source');
    writeFileSync(source, 'secret');
    const target = join(repoPath, '.takt', 'config.yaml');
    createLink(target, source);
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });

    await expect(captureProjectTemplateBackupFile({
      storage,
      backupId: 'backup-1',
      target: { kind: 'template-entry', path: 'config.yaml' },
      expectedSha256: hash('secret'),
      expectedMode: `0${(lstatSync(source).mode & 0o777).toString(8).padStart(3, '0')}`,
      maxBytes: 1024,
    })).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
  });

  it('rejects a special target instead of traversing it during backup', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, '.takt', 'config.yaml'));
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });

    await expect(captureProjectTemplateBackupFile({
      storage,
      backupId: 'backup-1',
      target: { kind: 'template-entry', path: 'config.yaml' },
      expectedSha256: hash(''),
      expectedMode: '0700',
      maxBytes: 1024,
    })).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
  });

  it('writes canonical immutable manifests and replaceable journals', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const backupManifest = manifest('backup-1', '2026-07-30T00:00:00.000Z');

    const manifestPath = await writeProjectTemplateBackupManifest({
      storage,
      manifest: backupManifest,
    });
    const firstJournalPath = await writeProjectTemplateApplyJournal({
      storage,
      journal: journal(),
    });
    const committed = { ...journal(), state: 'committed' as const };
    const secondJournalPath = await writeProjectTemplateApplyJournal({
      storage,
      journal: committed,
    });

    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(backupManifest);
    expect(JSON.parse(readFileSync(firstJournalPath, 'utf8'))).toEqual(committed);
    expect(secondJournalPath).toBe(firstJournalPath);
    expect(lstatSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(firstJournalPath).mode & 0o777).toBe(0o600);
    await expect(readProjectTemplateBackupManifest({
      storage,
      backupId: 'backup-1',
    })).resolves.toEqual(backupManifest);
    await expect(writeProjectTemplateBackupManifest({
      storage,
      manifest: backupManifest,
    })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it.each([
    ['unrelated directory', [''], [{ kind: 'lock' as const }]],
    ['non-ancestor directory', ['', 'unrelated'], [{
      kind: 'template-entry' as const,
      path: 'generated/file.yaml',
    }]],
    ['non-canonical order', ['generated', ''], [{
      kind: 'template-entry' as const,
      path: 'generated/file.yaml',
    }]],
    ['duplicate directory', ['', ''], [{
      kind: 'template-entry' as const,
      path: 'generated/file.yaml',
    }]],
  ])('rejects %s in created-directory evidence', async (
    _label,
    createdTargetDirectories,
    targets,
  ) => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const invalid: ProjectTemplateBackupManifest = {
      ...manifest(`backup-${roots.length}`, '2026-07-30T00:00:00.000Z'),
      createdTargetDirectories,
      entries: targets.map((target) => ({
        target,
        action: 'add' as const,
        before: { kind: 'absent' as const },
        after: { kind: 'absent' as const },
      })),
    };

    await expect(writeProjectTemplateBackupManifest({
      storage,
      manifest: invalid,
    })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it.each<ProjectTemplateApplyStorageIoOperation>([
    'write',
    'chmod',
    'file-fsync',
    'directory-fsync',
    'rename',
  ])('exposes a deterministic %s fault seam', async (operation) => {
    const repoPath = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });
    const injected = new Error(`injected ${operation}`);
    const io = createProjectTemplateApplyStorageIo({
      before: (candidate) => {
        if (candidate === operation) throw injected;
      },
    });

    await expect(writeProjectTemplateApplyJournal({
      storage,
      journal: journal(),
      io,
    })).rejects.toMatchObject({
      code: 'IO_FAILURE',
      operation,
    });
  });

  it('keeps only the newest bounded backup generations without broad deletion', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    for (const [index, backupId] of ['backup-1', 'backup-2', 'backup-3'].entries()) {
      await writeProjectTemplateBackupManifest({
        storage,
        manifest: manifest(backupId, `2026-07-30T00:00:0${index}.000Z`),
      });
    }

    const result = await pruneProjectTemplateBackupGenerations({
      storage,
      maxGenerations: 2,
    });

    expect(result.removedBackupIds).toEqual(['backup-1']);
    expect(result.retainedBackupIds).toEqual(['backup-3', 'backup-2']);
    expect(lstatSync(join(storage.backupsRoot, 'backup-2')).isDirectory()).toBe(true);
    expect(lstatSync(join(storage.backupsRoot, 'backup-3')).isDirectory()).toBe(true);
  });

  it('never prunes a protected in-flight backup generation', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    for (const [index, backupId] of ['backup-1', 'backup-2', 'backup-3'].entries()) {
      await writeProjectTemplateBackupManifest({
        storage,
        manifest: manifest(backupId, `2026-07-30T00:00:0${index}.000Z`),
      });
    }

    const result = await pruneProjectTemplateBackupGenerations({
      storage,
      maxGenerations: 1,
      protectedBackupIds: ['backup-1'],
    });

    expect(result.removedBackupIds).toEqual(['backup-2']);
    expect(result.retainedBackupIds).toEqual(['backup-3', 'backup-1']);
    expect(lstatSync(join(storage.backupsRoot, 'backup-1')).isDirectory()).toBe(true);
  });

  it('removes only the named bounded staging or backup transaction root', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const content = Buffer.from('language: ja\n');
    const staged = await writeProjectTemplateStagingFile({
      storage,
      transactionId: 'transaction-1',
      target: { kind: 'template-entry', path: 'config/config.yaml' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
    });
    const backupManifestPath = await writeProjectTemplateBackupManifest({
      storage,
      manifest: manifest('backup-1', '2026-07-30T00:00:00.000Z'),
    });

    await expect(removeProjectTemplateStagingTransaction({
      storage,
      transactionId: 'transaction-1',
    })).resolves.toBe(true);
    await expect(removeProjectTemplateBackupGeneration({
      storage,
      backupId: 'backup-1',
    })).resolves.toBe(true);

    expect(existsSync(staged.absolutePath)).toBe(false);
    expect(existsSync(backupManifestPath)).toBe(false);
    expect(existsSync(storage.stagingRoot)).toBe(true);
    expect(existsSync(storage.backupsRoot)).toBe(true);
    await expect(removeProjectTemplateStagingTransaction({
      storage,
      transactionId: 'transaction-1',
    })).resolves.toBe(false);
  });

  it('refuses to traverse a symlink while cleaning a transaction root', async () => {
    const repoPath = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });
    const outside = join(repoPath, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(storage.stagingRoot, 'transaction-1'));

    await expect(removeProjectTemplateStagingTransaction({
      storage,
      transactionId: 'transaction-1',
    })).rejects.toMatchObject({ code: 'UNSAFE_CONTROL_ROOT' });
    expect(existsSync(outside)).toBe(true);
  });
});
