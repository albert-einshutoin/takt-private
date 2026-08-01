import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureProjectTemplateBackupFile,
  consumeProjectTemplateApprovalRecord,
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  openProjectTemplateApplyStorageReadOnly,
  parseProjectTemplateApplyJournal,
  pruneProjectTemplateBackupGenerations,
  readProjectTemplateApprovalRecord,
  readProjectTemplateBackupManifest,
  removeProjectTemplateBackupGeneration,
  removeProjectTemplateStagingTransaction,
  resolveProjectTemplateApplyTarget,
  writeProjectTemplateApplyJournal,
  writeProjectTemplateApprovalRecord,
  writeProjectTemplateBackupManifest,
  writeProjectTemplateStagingFile,
  type ProjectTemplateApplyJournal,
  type ProjectTemplateApplyStorageIo,
  type ProjectTemplateApplyStorageIoOperation,
  type ProjectTemplateBackupManifest,
} from '../../features/project-template/apply-storage.js';
import { canonicalizeTaktpackJson } from '../../features/project-template/canonical-json.js';

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
  it.each([
    ['content-lock', '.takt-template-lock.json', 'content-lock'],
    [
      'repertoire-lock',
      '.takt-template-repertoire-lock.json',
      'repertoire-lock',
    ],
    [
      'source-provenance',
      '.takt-template-source-lock.json',
      'source-provenance',
    ],
  ] as const)(
    'resolves the schema 1.1 %s target outside template content',
    async (kind, displayPath, key) => {
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: makeRepo(),
      });
      const resolved = resolveProjectTemplateApplyTarget(
        storage,
        { kind } as never,
      );
      expect(resolved).toMatchObject({
        target: { kind },
        key,
        displayPath,
      });
      expect(resolved.absolutePath).toBe(join(storage.repoRoot, displayPath));
      expect(resolved.stagingRelativePath).toBe(
        `locks/${displayPath}`,
      );
    },
  );

  it('round-trips a strict schema 1.1 backup target union', async () => {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: makeRepo(),
    });
    const value = {
      schemaVersion: '1.1',
      backupId: 'backup-schema-11',
      planId: 'a'.repeat(64),
      preconditionToken: 'b'.repeat(64),
      createdAt: '2026-08-01T00:00:00.000Z',
      createdTargetDirectories: [],
      entries: [
        { kind: 'content-lock' },
        { kind: 'repertoire-lock' },
        { kind: 'source-provenance' },
      ].map((target) => ({
        target,
        action: 'add',
        before: { kind: 'absent' },
        after: { kind: 'absent' },
      })),
    };

    await writeProjectTemplateBackupManifest({
      storage,
      manifest: value as never,
    });
    await expect(readProjectTemplateBackupManifest({
      storage,
      backupId: value.backupId,
    })).resolves.toEqual(value);
  });

  it('reads schema 1.0 recovery manifests but rejects mixed and unknown targets', async () => {
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: makeRepo(),
    });
    const legacy = {
      ...manifest('backup-schema-10', '2026-08-01T00:00:00.000Z'),
      entries: [{
        target: { kind: 'lock' },
        action: 'add',
        before: { kind: 'absent' },
        after: { kind: 'absent' },
      }],
    };
    await writeProjectTemplateBackupManifest({ storage, manifest: legacy });
    await expect(readProjectTemplateBackupManifest({
      storage,
      backupId: legacy.backupId,
    })).resolves.toEqual(legacy);

    for (const [schemaVersion, target] of [
      ['1.0', { kind: 'content-lock' }],
      ['1.1', { kind: 'lock' }],
      ['1.1', { kind: 'unknown-lock' }],
      ['1.1', { kind: 'content-lock', path: 'forged' }],
    ] as const) {
      await expect(writeProjectTemplateBackupManifest({
        storage,
        manifest: {
          ...legacy,
          schemaVersion,
          backupId: `backup-invalid-${schemaVersion.replace('.', '-')}-${target.kind}`,
          entries: [{ ...legacy.entries[0]!, target }],
        } as never,
      })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    }
  });

  it('parses schema 1.0 recovery journals and strictly separates 1.1 operations', () => {
    expect(parseProjectTemplateApplyJournal(journal()))
      .toEqual(journal());
    const current = {
      ...journal(),
      schemaVersion: '1.1',
      completedOperations: [
        'content-lock',
        'repertoire-lock',
        'source-provenance',
      ],
    };
    expect(parseProjectTemplateApplyJournal(current)).toEqual(current);

    for (const value of [
      { ...current, schemaVersion: '2.0' },
      { ...current, completedOperations: ['lock'] },
      { ...journal(), completedOperations: ['content-lock'] },
      { ...current, unexpected: true },
    ]) {
      expect(() => parseProjectTemplateApplyJournal(value))
        .toThrow(expect.objectContaining({ code: 'INVALID_JOURNAL' }));
    }
  });

  it('opens existing baseline authority read-only and closes all directory FDs', async () => {
    const root = makeRepo();
    const initialized = await initializeProjectTemplateApplyStorage({ repoPath: root });
    const before = {
      control: lstatSync(initialized.controlRoot).mtimeMs,
      baselines: lstatSync(initialized.baselinesRoot).mtimeMs,
    };
    const phases: string[] = [];
    const opened = await openProjectTemplateApplyStorageReadOnly({
      repoPath: root,
      ioSeam: { onPhase(phase) { phases.push(phase); } },
    });
    expect(opened.baselinesInode).toBe(initialized.baselinesInode);
    expect(phases).toEqual([
      'repository-opened',
      'control-opened',
      'baselines-opened',
      'all-closed',
    ]);
    expect({
      control: lstatSync(initialized.controlRoot).mtimeMs,
      baselines: lstatSync(initialized.baselinesRoot).mtimeMs,
    }).toEqual(before);

    const failedPhases: string[] = [];
    await expect(openProjectTemplateApplyStorageReadOnly({
      repoPath: root,
      ioSeam: {
        onPhase(phase) {
          failedPhases.push(phase);
          if (phase === 'control-opened') throw new Error('private path');
        },
      },
    })).rejects.not.toThrow('private path');
    expect(failedPhases.at(-1)).toBe('all-closed');
  });

  it('rejects non-UTF-8 approval bytes instead of replacement-decoding them', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const approvalId = 'approval-invalid-utf8';
    await writeProjectTemplateApprovalRecord({
      storage,
      approvalId,
      record: { schemaVersion: '1.0' },
    });
    writeFileSync(join(
      storage.controlRoot,
      'approvals',
      `${approvalId}.json`,
    ), Buffer.from([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a,
    ]), { mode: 0o600 });

    await expect(readProjectTemplateApprovalRecord({ storage, approvalId }))
      .rejects.toThrow();
  });

  it('writes exact approval, burn, and disposition bytes without mutable hooks', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const recordId = 'approval-record-audit';
    const burnId = 'approval-burn-audit';
    const dispositionId = 'approval-disposition-audit';
    const record = {
      schemaVersion: '1.0',
      approvalId: recordId,
      nonce: '00000000-0000-0000-0000-000000000000',
    };
    const burnClaim = {
      schemaVersion: '1.0',
      approvalId: burnId,
      context: 'project-template-apply-preview-review',
      state: 'burned',
      burnedAt: '2026-08-01T00:00:00.000Z',
    };
    const dispositionClaim = {
      schemaVersion: '1.0',
      approvalId: dispositionId,
      nonce: '00000000-0000-0000-0000-000000000001',
      disposition: 'consumed',
      claimedAt: '2026-08-01T00:00:00.000Z',
    };
    const expected = {
      record: `${canonicalizeTaktpackJson(record)}\n`,
      burn: `${canonicalizeTaktpackJson(burnClaim)}\n`,
      disposition: `${canonicalizeTaktpackJson(dispositionClaim)}\n`,
    };
    const bufferPrototype = Buffer.prototype as Buffer & {
      utf8Write(value: string, offset?: number, length?: number): number;
    };
    const originals = {
      bufferFrom: Buffer.from,
      utf8Write: bufferPrototype.utf8Write,
      stringify: JSON.stringify,
      descriptors: Object.getOwnPropertyDescriptors,
      isArray: Array.isArray,
    };
    const hooks = { buffer: 0, utf8Write: 0, json: 0, object: 0, array: 0 };
    Object.defineProperty(Buffer, 'from', {
      configurable: true,
      writable: true,
      value: () => {
        hooks.buffer += 1;
        return originals.bufferFrom.call(Buffer, '{"forged":true}\n');
      },
    });
    Object.defineProperty(Buffer.prototype, 'utf8Write', {
      configurable: true,
      writable: true,
      value(this: Buffer, value: string, offset?: number, length?: number) {
        hooks.utf8Write += 1;
        return originals.utf8Write.call(this, value, offset, length);
      },
    });
    Object.defineProperty(JSON, 'stringify', {
      configurable: true,
      writable: true,
      value: () => {
        hooks.json += 1;
        return '"forged"';
      },
    });
    Object.defineProperty(Object, 'getOwnPropertyDescriptors', {
      configurable: true,
      writable: true,
      value: () => {
        hooks.object += 1;
        return {};
      },
    });
    Object.defineProperty(Array, 'isArray', {
      configurable: true,
      writable: true,
      value: () => {
        hooks.array += 1;
        return false;
      },
    });
    try {
      await writeProjectTemplateApprovalRecord({
        storage,
        approvalId: recordId,
        record,
      });
      await consumeProjectTemplateApprovalRecord({
        storage,
        approvalId: burnId,
        claim: burnClaim,
      });
      await consumeProjectTemplateApprovalRecord({
        storage,
        approvalId: dispositionId,
        claim: dispositionClaim,
      });
    } finally {
      Object.defineProperty(Buffer, 'from', {
        configurable: true,
        writable: true,
        value: originals.bufferFrom,
      });
      Object.defineProperty(Buffer.prototype, 'utf8Write', {
        configurable: true,
        writable: true,
        value: originals.utf8Write,
      });
      Object.defineProperty(JSON, 'stringify', {
        configurable: true,
        writable: true,
        value: originals.stringify,
      });
      Object.defineProperty(Object, 'getOwnPropertyDescriptors', {
        configurable: true,
        writable: true,
        value: originals.descriptors,
      });
      Object.defineProperty(Array, 'isArray', {
        configurable: true,
        writable: true,
        value: originals.isArray,
      });
    }

    expect(readFileSync(join(
      storage.controlRoot,
      'approvals',
      `${recordId}.json`,
    ), 'utf8')).toBe(expected.record);
    expect(readFileSync(join(
      storage.controlRoot,
      'approval-claims',
      `${burnId}.json`,
    ), 'utf8')).toBe(expected.burn);
    expect(readFileSync(join(
      storage.controlRoot,
      'approval-claims',
      `${dispositionId}.json`,
    ), 'utf8')).toBe(expected.disposition);
    expect(hooks).toEqual({
      buffer: 0,
      utf8Write: 0,
      json: 0,
      object: 0,
      array: 0,
    });
  });

  it('creates a private repo-local control root on the target filesystem', async () => {
    const repoPath = makeRepo();

    const storage = await initializeProjectTemplateApplyStorage({ repoPath });

    expect(storage.controlRoot).toBe(join(storage.repoRoot, '.takt-template-state'));
    expect(storage.targetRoot).toBe(join(storage.repoRoot, '.takt'));
    expect(storage.lockTargetPath).toBe(join(storage.repoRoot, '.takt-template-lock.json'));
    expect(lstatSync(storage.controlRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.stagingRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.backupsRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.baselinesRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(storage.controlRoot).dev).toBe(lstatSync(storage.targetRoot).dev);
    expect(readFileSync(join(storage.controlRoot, '.gitignore'), 'utf8')).toBe('*\n');
    expect(lstatSync(join(storage.controlRoot, '.gitignore')).mode & 0o077).toBe(0);
  });

  it('initializes the same fresh repository concurrently without false failure', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const repoPath = makeRepo();
      const [first, second] = await Promise.all([
        initializeProjectTemplateApplyStorage({ repoPath }),
        initializeProjectTemplateApplyStorage({ repoPath }),
      ]);
      expect(first.repoRoot).toBe(second.repoRoot);
      expect(readFileSync(join(first.controlRoot, '.gitignore'), 'utf8'))
        .toBe('*\n');
      expect(lstatSync(join(first.controlRoot, '.gitignore')).mode & 0o777)
        .toBe(0o600);
    }
  });

  it.each(['symlink', 'hardlink'] as const)(
    'keeps rejecting a hostile preexisting control .gitignore %s',
    async (kind) => {
      const repoPath = makeRepo();
      const storage = await initializeProjectTemplateApplyStorage({ repoPath });
      const ignorePath = join(storage.controlRoot, '.gitignore');
      const source = join(repoPath, 'hostile-ignore');
      writeFileSync(source, '*\n', { mode: 0o600 });
      unlinkSync(ignorePath);
      if (kind === 'symlink') symlinkSync(source, ignorePath);
      else linkSync(source, ignorePath);

      await expect(initializeProjectTemplateApplyStorage({ repoPath }))
        .rejects.toMatchObject({ code: 'UNSAFE_CONTROL_ROOT' });
    },
  );

  it('rejects a same-content mode swap before opening control .gitignore', async () => {
    const repoPath = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });
    const ignorePath = join(storage.controlRoot, '.gitignore');
    let swapped = false;
    const io = createProjectTemplateApplyStorageIo({
      before: (operation, path) => {
        if (!swapped && operation === 'read' && path === ignorePath) {
          swapped = true;
          chmodSync(path, 0o644);
        }
      },
    });

    await expect(initializeProjectTemplateApplyStorage({ repoPath, io }))
      .rejects.toMatchObject({ code: 'UNSAFE_CONTROL_ROOT' });
    expect(swapped).toBe(true);
  });

  it('rejects a same-content pathname replacement after reading control .gitignore', async () => {
    const repoPath = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });
    const ignorePath = join(storage.controlRoot, '.gitignore');
    let replaced = false;
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (!replaced && operation === 'read' && path === ignorePath) {
          replaced = true;
          const replacement = join(storage.controlRoot, '.gitignore.replacement');
          writeFileSync(replacement, '*\n', { mode: 0o600 });
          renameSync(replacement, ignorePath);
        }
      },
    });

    await expect(initializeProjectTemplateApplyStorage({ repoPath, io }))
      .rejects.toMatchObject({ code: 'UNSAFE_CONTROL_ROOT' });
    expect(replaced).toBe(true);
  });

  it('passes repository device identity into the private control ignore read', async () => {
    const repoPath = makeRepo();
    await initializeProjectTemplateApplyStorage({ repoPath });
    const baseIo = createProjectTemplateApplyStorageIo();
    let privateReads = 0;
    const io: ProjectTemplateApplyStorageIo = {
      ...baseIo,
      readPrivateFile: async (path, maxBytes, expectedDevice) => {
        privateReads += 1;
        return await baseIo.readPrivateFile(path, maxBytes, expectedDevice + 1);
      },
    };

    await expect(initializeProjectTemplateApplyStorage({ repoPath, io }))
      .rejects.toMatchObject({ code: 'UNSAFE_CONTROL_ROOT' });
    expect(privateReads).toBe(1);
  });

  it('durably publishes each newly created control directory in its parent', async () => {
    const repoPath = makeRepo();
    const events: Array<[ProjectTemplateApplyStorageIoOperation, string]> = [];
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (operation === 'mkdir' || operation === 'directory-fsync') {
          events.push([operation, path]);
        }
      },
    });

    const storage = await initializeProjectTemplateApplyStorage({ repoPath, io });

    expect(events.slice(0, 8)).toEqual([
      ['mkdir', storage.controlRoot],
      ['directory-fsync', storage.repoRoot],
      ['mkdir', storage.stagingRoot],
      ['directory-fsync', storage.controlRoot],
      ['mkdir', storage.backupsRoot],
      ['directory-fsync', storage.controlRoot],
      ['mkdir', storage.baselinesRoot],
      ['directory-fsync', storage.controlRoot],
    ]);
  });

  it('re-fsyncs parents for private directories that already exist', async () => {
    const repoPath = makeRepo();
    const canonicalRepoPath = realpathSync.native(repoPath);
    const controlRoot = join(repoPath, '.takt-template-state');
    const canonicalControlRoot = join(canonicalRepoPath, '.takt-template-state');
    mkdirSync(join(controlRoot, 'staging'), { recursive: true, mode: 0o700 });
    mkdirSync(join(controlRoot, 'backups'), { mode: 0o700 });
    mkdirSync(join(controlRoot, 'merge-baselines'), { mode: 0o700 });
    writeFileSync(join(controlRoot, '.gitignore'), '*\n', { mode: 0o600 });
    const events: Array<[ProjectTemplateApplyStorageIoOperation, string]> = [];
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (operation === 'mkdir' || operation === 'directory-fsync') {
          events.push([operation, path]);
        }
      },
    });

    await initializeProjectTemplateApplyStorage({ repoPath, io });

    expect(events).toEqual([
      ['directory-fsync', canonicalRepoPath],
      ['directory-fsync', canonicalControlRoot],
      ['directory-fsync', canonicalControlRoot],
      ['directory-fsync', canonicalControlRoot],
    ]);
  });

  it('durably publishes every newly created nested staging directory', async () => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const events: Array<[ProjectTemplateApplyStorageIoOperation, string]> = [];
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (operation === 'mkdir' || operation === 'directory-fsync') {
          events.push([operation, path]);
        }
      },
    });
    const content = Buffer.from('language: ja\n');

    const staged = await writeProjectTemplateStagingFile({
      storage,
      transactionId: 'nested-transaction',
      target: { kind: 'template-entry', path: 'config/nested/config.yaml' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
      io,
    });
    const transactionRoot = join(storage.stagingRoot, 'nested-transaction');
    const entriesRoot = join(transactionRoot, 'entries');
    const configRoot = join(entriesRoot, 'config');
    const nestedRoot = dirname(staged.absolutePath);

    expect(events.slice(0, 8)).toEqual([
      ['mkdir', transactionRoot],
      ['directory-fsync', storage.stagingRoot],
      ['mkdir', entriesRoot],
      ['directory-fsync', transactionRoot],
      ['mkdir', configRoot],
      ['directory-fsync', entriesRoot],
      ['mkdir', nestedRoot],
      ['directory-fsync', configRoot],
    ]);
  });

  it('durably publishes newly created backup generation and blob directories', async () => {
    const repoPath = makeRepo();
    const target = join(repoPath, '.takt', 'config.yaml');
    writeFileSync(target, 'language: ja\n', { mode: 0o644 });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath });
    const events: Array<[ProjectTemplateApplyStorageIoOperation, string]> = [];
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (operation === 'mkdir' || operation === 'directory-fsync') {
          events.push([operation, path]);
        }
      },
    });

    await captureProjectTemplateBackupFile({
      storage,
      backupId: 'durable-backup',
      target: { kind: 'template-entry', path: 'config.yaml' },
      expectedSha256: hash('language: ja\n'),
      expectedMode: '0644',
      maxBytes: 1024,
      io,
    });
    const backupRoot = join(storage.backupsRoot, 'durable-backup');
    const blobsRoot = join(backupRoot, 'blobs');

    expect(events.slice(0, 4)).toEqual([
      ['mkdir', backupRoot],
      ['directory-fsync', storage.backupsRoot],
      ['mkdir', blobsRoot],
      ['directory-fsync', backupRoot],
    ]);
  });

  it.each([
    ['mkdir', 'mkdir' as const],
    ['parent directory fsync', 'directory-fsync' as const],
  ])('fails closed when new private directory %s fails', async (_label, faultOperation) => {
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    const transactionRoot = join(storage.stagingRoot, 'faulted-transaction');
    const io = createProjectTemplateApplyStorageIo({
      before: (operation, path) => {
        if (
          operation === faultOperation
          && (
            operation === 'mkdir'
              ? path === transactionRoot
              : path === storage.stagingRoot
          )
        ) {
          throw new Error(`injected ${operation}`);
        }
      },
    });
    const content = Buffer.from('language: ja\n');

    await expect(writeProjectTemplateStagingFile({
      storage,
      transactionId: 'faulted-transaction',
      target: { kind: 'template-entry', path: 'config.yaml' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
      io,
    })).rejects.toMatchObject({ operation: faultOperation });
    expect(existsSync(join(transactionRoot, 'entries'))).toBe(false);
  });

  it('re-fsyncs an existing private directory after a failed publication retry', async () => {
    const repoPath = makeRepo();
    const canonicalRepoPath = realpathSync.native(repoPath);
    const controlRoot = join(repoPath, '.takt-template-state');
    let failOnce = true;
    const fsynced: string[] = [];
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (operation !== 'directory-fsync') return;
        fsynced.push(path);
        if (failOnce && path === canonicalRepoPath) {
          failOnce = false;
          throw new Error('injected first parent fsync failure');
        }
      },
    });

    await expect(initializeProjectTemplateApplyStorage({ repoPath, io }))
      .rejects.toMatchObject({ operation: 'directory-fsync' });
    expect(existsSync(controlRoot)).toBe(true);

    fsynced.length = 0;
    await expect(initializeProjectTemplateApplyStorage({ repoPath, io }))
      .resolves.toBeDefined();
    expect(fsynced[0]).toBe(canonicalRepoPath);
  });

  it('treats directory fsync as best-effort on Windows', async () => {
    const repoPath = makeRepo();
    const fsyncAttempts: string[] = [];
    const io = createProjectTemplateApplyStorageIo({
      before: (operation, path) => {
        if (operation === 'directory-fsync') {
          fsyncAttempts.push(path);
          throw new Error('directory fsync is unsupported');
        }
      },
    }, 'win32');

    await expect(initializeProjectTemplateApplyStorage({
      repoPath,
      io,
      platform: 'win32',
    })).resolves.toBeDefined();
    expect(fsyncAttempts).toEqual([]);
  });

  it('does not treat POSIX mode bits as Windows control-plane evidence', async () => {
    const repoPath = makeRepo();
    const controlRoot = join(repoPath, '.takt-template-state');
    mkdirSync(join(controlRoot, 'staging'), { recursive: true, mode: 0o755 });
    mkdirSync(join(controlRoot, 'backups'), { mode: 0o755 });
    writeFileSync(join(controlRoot, '.gitignore'), '*\n', { mode: 0o644 });

    const storage = await initializeProjectTemplateApplyStorage({
      repoPath,
      platform: 'win32',
    });
    const content = Buffer.from('language: ja\n');
    await expect(writeProjectTemplateStagingFile({
      storage,
      transactionId: 'windows-transaction',
      target: { kind: 'template-entry', path: 'config.yaml' },
      content,
      expectedSha256: hash(content),
      targetMode: '0644',
    })).resolves.toMatchObject({ bytes: content.byteLength });
    await expect(writeProjectTemplateBackupManifest({
      storage,
      manifest: manifest('windows-backup', '2026-07-30T00:00:00.000Z'),
    })).resolves.toContain('manifest.json');
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

  it('stops directory iteration as soon as its entry budget is exceeded', async () => {
    const repoPath = makeRepo();
    const directory = join(repoPath, 'bounded-directory');
    mkdirSync(directory);
    writeFileSync(join(directory, 'first'), '');
    writeFileSync(join(directory, 'second'), '');
    const io = createProjectTemplateApplyStorageIo();

    await expect(io.readdir(directory, 1))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
