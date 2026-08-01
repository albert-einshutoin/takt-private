import { createHash } from 'node:crypto';
import {
  chmodSync,
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
} from '../../features/project-template/companion-lock-transaction.js';
import {
  captureProjectTemplateBackupFile,
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
