import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recoverProjectTemplateCompanionLockTransaction,
  recoverProjectTemplateCompanionLockTransactionForTest,
} from '../../features/project-template/companion-lock-transaction.js';
import {
  captureProjectTemplateBackupFile,
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  resolveProjectTemplateApplyTarget,
  writeProjectTemplateApplyJournal,
  writeProjectTemplateBackupManifest,
  type ProjectTemplateApplyJournal,
  type ProjectTemplateApplyStorage,
  type ProjectTemplateApplyTarget,
  type ProjectTemplateBackupManifest,
  type ProjectTemplateBackupManifestEntry,
} from '../../features/project-template/apply-storage.js';

const roots: string[] = [];
const PLAN = 'a'.repeat(64);
const PRECONDITION = 'b'.repeat(64);
const BACKUP = 'backup-recovery-validation';
const TRANSACTION = 'remote-recovery-validation';

function hash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'takt-recovery-validation-'));
  roots.push(value);
  mkdirSync(join(value, '.takt'), { recursive: true });
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

type EntrySpec = {
  readonly target: Exclude<ProjectTemplateApplyTarget, { kind: 'lock' }>;
  readonly action: 'add' | 'update' | 'delete';
  readonly before?: string;
  readonly after?: string;
  readonly current: 'before' | 'after' | 'drift';
  readonly drift?: string;
  readonly currentMode?: number;
};

async function recoveryFixture(options: {
  readonly schemaVersion?: '1.0' | '1.1';
  readonly state?: ProjectTemplateApplyJournal['state'];
  readonly completedOperations?: readonly string[];
  readonly createdTargetDirectories?: readonly string[];
  readonly entries?: readonly EntrySpec[];
}) {
  const projectRoot = root();
  const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
  const schemaVersion = options.schemaVersion ?? '1.1';
  const specs = options.entries ?? [{
    target: { kind: 'content-lock' } as const,
    action: 'update' as const,
    before: 'old-content-lock\n',
    after: 'new-content-lock\n',
    current: 'after' as const,
  }];
  const entries: ProjectTemplateBackupManifestEntry[] = [];
  for (const spec of specs) {
    const resolved = resolveProjectTemplateApplyTarget(storage, spec.target);
    mkdirSync(dirname(resolved.absolutePath), { recursive: true });
    let before: ProjectTemplateBackupManifestEntry['before'] = { kind: 'absent' };
    if (spec.before !== undefined) {
      writeFileSync(resolved.absolutePath, spec.before, { mode: 0o600 });
      chmodSync(resolved.absolutePath, 0o600);
      const bytes = Buffer.from(spec.before);
      const captured = await captureProjectTemplateBackupFile({
        storage,
        backupId: BACKUP,
        target: spec.target,
        expectedSha256: hash(bytes),
        expectedMode: '0600',
        maxBytes: bytes.byteLength,
      });
      before = {
        kind: 'file', sha256: captured.sha256, bytes: captured.bytes,
        mode: captured.targetMode, blobRelativePath: captured.relativePath,
      };
    }
    const after = spec.after === undefined
      ? { kind: 'absent' as const }
      : {
          kind: 'file' as const,
          sha256: hash(Buffer.from(spec.after)),
          bytes: Buffer.byteLength(spec.after),
          mode: '0600',
          blobRelativePath: `blobs/${hash(Buffer.from(spec.after))}`,
        };
    const current = spec.current === 'before'
      ? spec.before
      : spec.current === 'after' ? spec.after : spec.drift ?? 'third-party\n';
    if (current === undefined) {
      rmSync(resolved.absolutePath, { force: true });
    } else {
      writeFileSync(resolved.absolutePath, current, { mode: spec.currentMode ?? 0o600 });
      chmodSync(resolved.absolutePath, spec.currentMode ?? 0o600);
    }
    entries.push({ target: spec.target, action: spec.action, before, after });
  }
  const createdTargetDirectories = options.createdTargetDirectories ?? [];
  const manifest: ProjectTemplateBackupManifest = {
    schemaVersion,
    backupId: BACKUP,
    planId: PLAN,
    preconditionToken: PRECONDITION,
    createdAt: new Date().toISOString(),
    createdTargetDirectories,
    entries,
  };
  await writeProjectTemplateBackupManifest({ storage, manifest });
  const journal: ProjectTemplateApplyJournal = {
    schemaVersion,
    transactionId: TRANSACTION,
    planId: PLAN,
    backupId: BACKUP,
    state: options.state ?? 'committing',
    completedOperations: options.completedOperations ?? [],
    createdTargetDirectories,
    updatedAt: new Date().toISOString(),
  };
  await writeProjectTemplateApplyJournal({ storage, journal });
  const manifestPath = join(storage.backupsRoot, BACKUP, 'manifest.json');
  const snapshot = () => ({
    journal: readFileSync(storage.journalPath),
    manifest: readFileSync(manifestPath),
    targets: specs.map((spec) => {
      const path = resolveProjectTemplateApplyTarget(storage, spec.target).absolutePath;
      try { return readFileSync(path); } catch { return undefined; }
    }),
  });
  return { projectRoot, storage, journal, manifest, manifestPath, specs, snapshot };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function expectBlocked(value: Awaited<ReturnType<typeof recoveryFixture>>) {
  const before = value.snapshot();
  await expect(recoverProjectTemplateCompanionLockTransaction({
    projectRoot: value.projectRoot,
  })).rejects.toMatchObject({
    code: 'RECOVERY_BLOCKED',
    operatorDetail: 'recovery-evidence-inconsistent',
  });
  expect(value.snapshot()).toEqual(before);
}

describe('companion lock cross-file recovery validation', () => {
  it('blocks a 1.0 journal paired with a 1.1 manifest', async () => {
    const value = await recoveryFixture({ schemaVersion: '1.1' });
    writeJson(value.storage.journalPath, { ...value.journal, schemaVersion: '1.0' });
    await expectBlocked(value);
  });

  it.each([
    ['duplicate', ['content-lock', 'content-lock']],
    ['unknown', ['entry:unknown.yaml']],
    ['out-of-order', ['repertoire-lock']],
  ] as const)('blocks %s completed operation evidence', async (_name, completedOperations) => {
    const value = await recoveryFixture({
      entries: [
        { target: { kind: 'content-lock' }, action: 'update', before: 'old-a', after: 'new-a', current: 'after' },
        { target: { kind: 'repertoire-lock' }, action: 'update', before: 'old-b', after: 'new-b', current: 'before' },
      ],
    });
    writeJson(value.storage.journalPath, { ...value.journal, completedOperations });
    await expectBlocked(value);
  });

  it('blocks committed state without the complete operation prefix', async () => {
    const value = await recoveryFixture({ state: 'committed', completedOperations: [] });
    await expectBlocked(value);
  });

  it('blocks mismatched and extra created directory evidence', async () => {
    const value = await recoveryFixture({
      entries: [{
        target: { kind: 'template-entry', path: 'workflows/review.yaml' },
        action: 'add', after: 'new', current: 'after',
      }],
      createdTargetDirectories: ['', 'workflows'],
    });
    writeJson(value.storage.journalPath, {
      ...value.journal,
      createdTargetDirectories: ['', 'extra'],
    });
    await expectBlocked(value);
  });
});

describe('companion lock rollback current-state guard', () => {
  function largeCohortEntries(fullMegabytes: number, trailingBytes = 0): EntrySpec[] {
    return [
      ...Array.from({ length: fullMegabytes }, (_, index): EntrySpec => ({
        target: { kind: 'template-entry', path: `large/${index}.yaml` },
        action: 'update',
        before: String(index % 10).repeat(1024 * 1024),
        after: `new-${index}`,
        current: 'after',
      })),
      ...(trailingBytes === 0 ? [] : [{
        target: { kind: 'template-entry' as const, path: 'large/trailing.yaml' },
        action: 'update' as const,
        before: 'x'.repeat(trailingBytes),
        after: 'new-trailing',
        current: 'after' as const,
      }]),
    ];
  }

  it('rolls back a normal five-megabyte cohort', async () => {
    const entries = largeCohortEntries(5);
    const value = await recoveryFixture({
      completedOperations: entries.map((entry) => (
        `entry:${(entry.target as { path: string }).path}`
      )),
      entries,
    });
    await expect(recoverProjectTemplateCompanionLockTransaction({
      projectRoot: value.projectRoot,
    })).resolves.toEqual({ status: 'rolled-back' });
  });

  it('recovers a template entry at the 512-character portable-path boundary', async () => {
    const path = `${'a'.repeat(255)}/${'b'.repeat(254)}/c`;
    const value = await recoveryFixture({
      completedOperations: [`entry:${path}`],
      entries: [{
        target: { kind: 'template-entry', path }, action: 'update',
        before: 'old', after: 'new', current: 'after',
      }],
    });
    await expect(recoverProjectTemplateCompanionLockTransaction({
      projectRoot: value.projectRoot,
    })).resolves.toEqual({ status: 'rolled-back' });
  });

  it('accepts the exact 32 MiB cohort boundary', async () => {
    const entries = largeCohortEntries(32);
    const value = await recoveryFixture({
      completedOperations: entries.map((entry) => (
        `entry:${(entry.target as { path: string }).path}`
      )),
      entries,
    });
    await expect(recoverProjectTemplateCompanionLockTransaction({
      projectRoot: value.projectRoot,
    })).resolves.toEqual({ status: 'rolled-back' });
  });

  it('accepts 32 MiB of template content plus companion evidence', async () => {
    const entries = [
      ...largeCohortEntries(32),
      {
        target: { kind: 'content-lock' as const }, action: 'update' as const,
        before: 'x', after: 'new-lock', current: 'after' as const,
      },
    ];
    const value = await recoveryFixture({
      completedOperations: [
        ...entries.slice(0, -1).map((entry) => (
          `entry:${(entry.target as { path: string }).path}`
        )),
        'content-lock',
      ],
      entries,
    });
    await expect(recoverProjectTemplateCompanionLockTransaction({
      projectRoot: value.projectRoot,
    })).resolves.toEqual({ status: 'rolled-back' });
  });

  it('blocks 32 MiB plus one byte without mutation and retains evidence', async () => {
    const entries = largeCohortEntries(32, 1);
    const value = await recoveryFixture({
      completedOperations: entries.map((entry) => (
        `entry:${(entry.target as { path: string }).path}`
      )),
      entries,
    });
    await expectBlocked(value);
  });

  it.each([0, 4])(
    'validates every backup blob before restoring when blob %i is corrupt',
    async (corruptIndex) => {
      const entries: readonly EntrySpec[] = [
        { target: { kind: 'template-entry', path: 'workflows/a.yaml' }, action: 'update', before: 'old-0', after: 'new-0', current: 'after' },
        { target: { kind: 'template-entry', path: 'workflows/b.yaml' }, action: 'update', before: 'old-1', after: 'new-1', current: 'after' },
        { target: { kind: 'content-lock' }, action: 'update', before: 'old-2', after: 'new-2', current: 'after' },
        { target: { kind: 'repertoire-lock' }, action: 'update', before: 'old-3', after: 'new-3', current: 'after' },
        { target: { kind: 'source-provenance' }, action: 'update', before: 'old-4', after: 'new-4', current: 'after' },
      ];
      const value = await recoveryFixture({
        completedOperations: [
          'entry:workflows/a.yaml', 'entry:workflows/b.yaml',
          'content-lock', 'repertoire-lock', 'source-provenance',
        ],
        entries,
      });
      const before = value.snapshot();
      const corrupt = value.manifest.entries[corruptIndex]!.before;
      if (corrupt.kind !== 'file') throw new Error('fixture requires backup file');
      const blobPath = join(value.storage.backupsRoot, BACKUP, corrupt.blobRelativePath);
      const originalBlob = readFileSync(blobPath);
      writeFileSync(blobPath, 'corrupt', { mode: 0o600 });

      const failure = await recoverProjectTemplateCompanionLockTransaction({
        projectRoot: value.projectRoot,
      }).catch((error: unknown) => error);
      expect(value.snapshot().targets).toEqual(before.targets);
      expect(failure).toMatchObject({ code: 'RECOVERY_BLOCKED' });

      writeFileSync(blobPath, originalBlob, { mode: 0o600 });
      await expect(recoverProjectTemplateCompanionLockTransaction({
        projectRoot: value.projectRoot,
      })).resolves.toEqual({ status: 'rolled-back' });
      expect(entries.map((entry) => readFileSync(
        resolveProjectTemplateApplyTarget(value.storage, entry.target).absolutePath,
      ))).toEqual(entries.map((entry) => Buffer.from(entry.before!)));
    },
  );

  it.each(['target-renamed', 'progress-journal-renamed'] as const)(
    'restarts a rolling rollback after %s fault',
    async (faultPoint) => {
      const value = await recoveryFixture({
        completedOperations: ['content-lock', 'repertoire-lock'],
        entries: [
          { target: { kind: 'content-lock' }, action: 'update', before: 'old-a', after: 'new-a', current: 'after' },
          { target: { kind: 'repertoire-lock' }, action: 'update', before: 'old-b', after: 'new-b', current: 'after' },
        ],
      });
      const contentPath = resolveProjectTemplateApplyTarget(
        value.storage, { kind: 'content-lock' },
      ).absolutePath;
      let journalRenames = 0;
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        after(operation, path) {
          if (injected || operation !== 'rename') return;
          if (faultPoint === 'target-renamed' && path === contentPath) {
            injected = true;
            throw new Error('injected target rename failure');
          }
          if (path === value.storage.journalPath && ++journalRenames === 2) {
            injected = true;
            throw new Error('injected progress journal failure');
          }
        },
      });
      await expect(recoverProjectTemplateCompanionLockTransactionForTest({
        projectRoot: value.projectRoot, io,
      })).rejects.toBeDefined();
      await expect(recoverProjectTemplateCompanionLockTransaction({
        projectRoot: value.projectRoot,
      })).resolves.toEqual({ status: 'rolled-back' });
      expect(readFileSync(contentPath, 'utf8')).toBe('old-a');
    },
  );

  it('blocks a target replacement immediately before its restore', async () => {
    const value = await recoveryFixture({
      completedOperations: ['content-lock'],
      entries: [{
        target: { kind: 'content-lock' }, action: 'update',
        before: 'old', after: 'new', current: 'after',
      }],
    });
    const targetPath = resolveProjectTemplateApplyTarget(
      value.storage, { kind: 'content-lock' },
    ).absolutePath;
    await expect(recoverProjectTemplateCompanionLockTransactionForTest({
      projectRoot: value.projectRoot,
      beforeTargetRestore() {
        writeFileSync(targetPath, 'third-party', { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: 'RECOVERY_BLOCKED' });
    expect(readFileSync(targetPath, 'utf8')).toBe('third-party');
  });

  const rollbackFaults = [
    ['before', 'rename', 'journal', 1], ['after', 'rename', 'journal', 1],
    ['before', 'unlink', 'entry:workflows/add.yaml', 0],
    ['after', 'unlink', 'entry:workflows/add.yaml', 0],
    ...[
      'entry:workflows/update.yaml', 'content-lock',
      'repertoire-lock', 'source-provenance',
    ].flatMap((key) => [
      ['before', 'rename', key, 0] as const,
      ['after', 'rename', key, 0] as const,
    ]),
    ...[2, 3, 4, 5, 6].flatMap((ordinal) => [
      ['before', 'rename', 'journal', ordinal] as const,
      ['after', 'rename', 'journal', ordinal] as const,
    ]),
    ['before', 'unlink', 'journal', 0],
  ] as const;

  it.each(rollbackFaults)(
    'restarts after rolling rollback fault %s %s %s %i',
    async (timing, operation, targetKey, journalOrdinal) => {
      const entries: readonly EntrySpec[] = [
        { target: { kind: 'template-entry', path: 'workflows/add.yaml' }, action: 'add', after: 'new-add', current: 'after' },
        { target: { kind: 'template-entry', path: 'workflows/update.yaml' }, action: 'update', before: 'old-update', after: 'new-update', current: 'after' },
        { target: { kind: 'content-lock' }, action: 'delete', before: 'old-content', current: 'after' },
        { target: { kind: 'repertoire-lock' }, action: 'update', before: 'old-repertoire', after: 'new-repertoire', current: 'after' },
        { target: { kind: 'source-provenance' }, action: 'update', before: 'old-source', after: 'new-source', current: 'after' },
      ];
      const value = await recoveryFixture({
        completedOperations: [
          'entry:workflows/add.yaml', 'entry:workflows/update.yaml',
          'content-lock', 'repertoire-lock', 'source-provenance',
        ],
        entries,
      });
      const targetPath = targetKey === 'journal'
        ? value.storage.journalPath
        : resolveProjectTemplateApplyTarget(
          value.storage,
          targetKey.startsWith('entry:')
            ? { kind: 'template-entry', path: targetKey.slice('entry:'.length) }
            : { kind: targetKey } as ProjectTemplateApplyTarget,
        ).absolutePath;
      let journalRenames = 0;
      let injected = false;
      const fail = (observedOperation: string, path: string) => {
        if (injected || observedOperation !== operation || path !== targetPath) return;
        if (targetKey === 'journal' && operation === 'rename'
          && ++journalRenames !== journalOrdinal) return;
        injected = true;
        throw new Error('injected rolling rollback fault');
      };
      const io = createProjectTemplateApplyStorageIo({ [timing]: fail });
      await expect(recoverProjectTemplateCompanionLockTransactionForTest({
        projectRoot: value.projectRoot, io,
      })).rejects.toBeDefined();
      expect(injected).toBe(true);
      await expect(recoverProjectTemplateCompanionLockTransaction({
        projectRoot: value.projectRoot,
      })).resolves.toMatchObject({ status: expect.stringMatching(/none|rolled-back/) });
      for (const entry of entries) {
        const path = resolveProjectTemplateApplyTarget(value.storage, entry.target).absolutePath;
        if (entry.before === undefined) expect(existsSync(path)).toBe(false);
        else expect(readFileSync(path, 'utf8')).toBe(entry.before);
      }
    },
  );

  it.each([
    ['add', undefined, 'new', 'intruder'],
    ['update', 'old', 'new', 'intruder'],
    ['delete', 'old', undefined, 'intruder'],
  ] as const)('blocks a third-party %s target edit', async (action, before, after, drift) => {
    const value = await recoveryFixture({
      entries: [{
        target: { kind: 'template-entry', path: `${action}.yaml` },
        action, before, after, current: 'drift', drift,
      }],
    });
    await expectBlocked(value);
  });

  it('preflights every entry before restoring an earlier target', async () => {
    const value = await recoveryFixture({
      completedOperations: ['content-lock'],
      entries: [
        { target: { kind: 'content-lock' }, action: 'update', before: 'old-a', after: 'new-a', current: 'after' },
        { target: { kind: 'repertoire-lock' }, action: 'update', before: 'old-b', after: 'new-b', current: 'drift' },
      ],
    });
    await expectBlocked(value);
  });

  it('blocks mode-only drift', async () => {
    const value = await recoveryFixture({
      entries: [{
        target: { kind: 'content-lock' }, action: 'update',
        before: 'same', after: 'same', current: 'after', currentMode: 0o644,
      }],
    });
    await expectBlocked(value);
  });

  it('preflights content and all three companion locks as one transaction', async () => {
    const value = await recoveryFixture({
      completedOperations: [
        'entry:workflows/review.yaml', 'content-lock', 'repertoire-lock',
      ],
      entries: [
        { target: { kind: 'template-entry', path: 'workflows/review.yaml' }, action: 'update', before: 'old-0', after: 'new-0', current: 'after' },
        { target: { kind: 'content-lock' }, action: 'update', before: 'old-1', after: 'new-1', current: 'after' },
        { target: { kind: 'repertoire-lock' }, action: 'update', before: 'old-2', after: 'new-2', current: 'after' },
        { target: { kind: 'source-provenance' }, action: 'update', before: 'old-3', after: 'new-3', current: 'drift' },
      ],
    });
    await expectBlocked(value);
  });

  it('keeps 1.0 recovery compatible when its evidence is coherent', async () => {
    const value = await recoveryFixture({
      schemaVersion: '1.0',
      completedOperations: ['lock'],
      entries: [{
        target: { kind: 'lock' } as never,
        action: 'update', before: 'old', after: 'new', current: 'after',
      }],
    });
    await expect(recoverProjectTemplateCompanionLockTransaction({
      projectRoot: value.projectRoot,
    })).resolves.toEqual({ status: 'rolled-back' });
  });
});
