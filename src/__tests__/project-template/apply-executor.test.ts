import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProjectTemplatePlan,
  PROJECT_TEMPLATE_LOCK_PATH,
  recoverProjectTemplateApply,
  rollbackProjectTemplateApply,
} from '../../features/project-template/apply-executor.js';
import {
  calculateProjectTemplateManifestSha256,
  captureProjectTemplateTargetSnapshot,
  createProjectTemplateApplyPlan,
  inspectProjectTemplateApplyGuard,
  type ProjectTemplateManifestV1,
  type ProjectTemplateIncomingContent,
  type TemplateLockV1,
} from '../../features/project-template/index.js';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
} from '../../features/project-template/apply-storage.js';

const roots: string[] = [];
const source = {
  kind: 'local' as const,
  uri: '.',
  ref: 'workspace' as const,
  commit: 'a'.repeat(40),
};

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-template-apply-'));
  roots.push(root);
  mkdirSync(join(root, '.takt'), { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  return root;
}

function writeTakt(root: string, path: string, content: string, mode = 0o644): void {
  const absolutePath = join(root, '.takt', path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { mode });
}

function manifest(contents: Readonly<Record<string, string>>): ProjectTemplateManifestV1 {
  return {
    schemaVersion: '1.0',
    packVersion: '2.0.0',
    takt: { minVersion: '0.48.0' },
    source,
    capabilities: Object.keys(contents).some((path) => path.endsWith('.sh'))
      ? ['executable']
      : [],
    entries: Object.entries(contents).map(([path, content]) => ({
      path,
      policy: 'managed',
      mode: path.endsWith('.sh') ? '0755' : '0644',
      sha256: hash(content),
      ...(path.endsWith('.sh') ? { capabilities: ['executable' as const] } : {}),
    })),
  };
}

function incomingContents(
  contents: Readonly<Record<string, string>>,
): ProjectTemplateIncomingContent[] {
  return Object.entries(contents).map(([path, content]) => ({
    path,
    content: Buffer.from(content),
  }));
}

async function createPlan(
  root: string,
  incomingManifest: ProjectTemplateManifestV1,
  contents: ProjectTemplateIncomingContent[],
  baseLock?: TemplateLockV1,
) {
  const candidates = [
    ...new Set([
      ...(baseLock?.entries.map((entry) => entry.path) ?? []),
      ...incomingManifest.entries.map((entry) => entry.path),
    ]),
  ];
  const snapshot = await captureProjectTemplateTargetSnapshot(root, candidates);
  return createProjectTemplateApplyPlan({
    ...(baseLock === undefined ? {} : { baseLock }),
    incomingManifest,
    localEntries: snapshot.entries,
    targetRootState: snapshot.rootState,
    missingPathTracking: snapshot.missingPathTracking,
    incomingContents: contents,
    incomingInspection: {
      archiveSha256: 'd'.repeat(64),
      manifestSha256: calculateProjectTemplateManifestSha256(incomingManifest),
      currentTaktVersion: '0.48.0',
      compatibilityStatus: 'compatible',
    },
    baselineStrategy: baseLock === undefined ? 'adopt-identical' : 'conflict',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template atomic apply executor', () => {
  it('commits all planned files and a formal lock, then restores hash and mode', async () => {
    const root = makeRoot();
    writeTakt(root, 'old.yaml', 'old\n', 0o600);
    const baseManifest = manifest({ 'old.yaml': 'old\n' });
    const baseLock: TemplateLockV1 = {
      schemaVersion: '1.0',
      manifestSha256: calculateProjectTemplateManifestSha256(baseManifest),
      packVersion: '1.0.0',
      source,
      capabilities: [],
      entries: [{
        path: 'old.yaml',
        policy: 'managed',
        mode: '0600',
        sha256: hash('old\n'),
        capabilities: [],
      }],
    };
    writeFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH), `${JSON.stringify(baseLock)}\n`);
    const contents = {
      'old.yaml': 'next\n',
      'generated/check.txt': 'ready\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });

    expect(result.status).toBe('committed');
    expect(readFileSync(join(root, '.takt', 'old.yaml'), 'utf-8')).toBe('next\n');
    expect(readFileSync(join(root, '.takt', 'generated/check.txt'), 'utf-8')).toBe(
      'ready\n',
    );
    expect(statSync(join(root, '.takt', 'generated/check.txt')).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH), 'utf-8')))
      .toMatchObject({ packVersion: '2.0.0' });
    expect(execFileSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
    })).not.toContain('.takt-template-state');
    const backupManifest = JSON.parse(readFileSync(
      join(
        root,
        '.takt-template-state',
        'backups',
        result.status === 'committed' ? result.backupId : '',
        'manifest.json',
      ),
      'utf-8',
    )) as {
      entries: Array<{ target: { path?: string }; before: { modifiedAt?: string } }>;
    };
    const oldFileBackup = backupManifest.entries.find(
      (entry) => entry.target.path === 'old.yaml',
    );
    expect(oldFileBackup?.before.modifiedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const rollback = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: result.status === 'committed' ? result.backupId : '',
    });

    expect(rollback.status).toBe('rolled_back');
    expect(readFileSync(join(root, '.takt', 'old.yaml'), 'utf-8')).toBe('old\n');
    expect(statSync(join(root, '.takt', 'old.yaml')).mode & 0o777).toBe(0o600);
    expect(() => readFileSync(join(root, '.takt', 'generated/check.txt'))).toThrow();
  });

  it('uses content rather than unsupported POSIX mode bits as the Windows transaction witness', async () => {
    const root = makeRoot();
    const contents = { 'generated/config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const io = createProjectTemplateApplyStorageIo({
      after(operation, path) {
        if (
          operation === 'rename'
          && (
            path.startsWith(`${join(root, '.takt')}${sep}`)
            || path === join(root, PROJECT_TEMPLATE_LOCK_PATH)
          )
        ) {
          // Model the reduced chmod representation documented by Node on Windows.
          chmodSync(path, 0o666);
        }
      },
    });

    try {
      Object.defineProperty(process, 'platform', {
        ...platformDescriptor,
        value: 'win32',
      });
      const applied = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: blobs,
        io,
      });
      expect(applied.status).toBe('committed');
      await expect(rollbackProjectTemplateApply({
        projectRoot: root,
        backupId: applied.status === 'committed' ? applied.backupId : '',
        io,
      })).resolves.toMatchObject({ status: 'rolled_back' });
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('removes transaction-created target parents after rollback so a missing-root plan can retry', async () => {
    const root = makeRoot();
    rmSync(join(root, '.takt'), { recursive: true });
    const contents = { 'generated/nested/config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });
    expect(applied.status).toBe('committed');
    const expectedCreatedDirectories = ['', 'generated', 'generated/nested'];
    const backupId = applied.status === 'committed' ? applied.backupId : '';
    expect(JSON.parse(readFileSync(join(
      root,
      '.takt-template-state',
      'backups',
      backupId,
      'manifest.json',
    ), 'utf8'))).toMatchObject({
      createdTargetDirectories: expectedCreatedDirectories,
    });
    expect(JSON.parse(readFileSync(join(
      root,
      '.takt-template-state',
      'journal.json',
    ), 'utf8'))).toMatchObject({
      createdTargetDirectories: expectedCreatedDirectories,
    });

    const rollback = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId,
    });

    expect(rollback.status).toBe('rolled_back');
    expect(existsSync(join(root, '.takt'))).toBe(false);
    mkdirSync(join(root, '.takt'));
    const terminalRecovery = await recoverProjectTemplateApply({ projectRoot: root });
    expect(terminalRecovery.status).toBe('rolled_back');
    expect(existsSync(join(root, '.takt'))).toBe(true);
    rmSync(join(root, '.takt'), { recursive: true });
    const retried = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });
    expect(retried.status).toBe('committed');
  });

  it('preserves existing and newly non-empty parent directories during rollback', async () => {
    const root = makeRoot();
    const contents = {
      'created/managed.yaml': 'managed: true\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });
    expect(applied.status).toBe('committed');
    writeFileSync(join(root, '.takt', 'created', 'user.txt'), 'preserve\n');

    const rollback = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: applied.status === 'committed' ? applied.backupId : '',
    });

    expect(rollback.status).toBe('rolled_back');
    expect(existsSync(join(root, '.takt'))).toBe(true);
    expect(readFileSync(join(root, '.takt', 'created', 'user.txt'), 'utf8')).toBe('preserve\n');
    expect(existsSync(join(root, '.takt', 'created', 'managed.yaml'))).toBe(false);
  });

  it.each(['rmdir', 'directory-fsync'] as const)(
    'converges recovery when created-directory %s fails during rollback',
    async (faultOperation) => {
      const root = makeRoot();
      rmSync(join(root, '.takt'), { recursive: true });
      const contents = { 'generated/config.yaml': 'language: ja\n' };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs);
      const applied = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: blobs,
      });
      expect(applied.status).toBe('committed');
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (
            !injected
            && operation === faultOperation
            && (
              (
                operation === 'rmdir'
                && basename(path) === '.takt'
              )
              || (
                operation === 'directory-fsync'
                && basename(path) === basename(root)
              )
            )
          ) {
            injected = true;
            throw new Error('injected created-directory cleanup fault');
          }
        },
      });

      const rollback = await rollbackProjectTemplateApply({
        projectRoot: root,
        backupId: applied.status === 'committed' ? applied.backupId : '',
        io,
      });

      expect(injected).toBe(true);
      expect(rollback.status).toBe('recovery_required');
      await expect(recoverProjectTemplateApply({ projectRoot: root }))
        .resolves.toMatchObject({ status: 'rolled_back' });
      expect(existsSync(join(root, '.takt'))).toBe(false);
    },
  );

  it('rejects target drift before creating backup or changing bytes', async () => {
    const root = makeRoot();
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    writeTakt(root, 'config.yaml', 'local drift\n');

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });

    expect(result).toMatchObject({ status: 'not_started', code: 'TARGET_DRIFT' });
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf-8')).toBe('local drift\n');
  });

  it('removes partial staging artifacts after preparation fails and permits retry', async () => {
    const root = makeRoot();
    const contents = { 'generated/config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          !injected
          && operation === 'file-fsync'
          && path.includes(`${sep}staging${sep}`)
        ) {
          injected = true;
          throw new Error('injected staging preparation fault');
        }
      },
    });

    const failed = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(failed).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(readdirSync(join(root, '.takt-template-state', 'staging'))).toEqual([]);
    expect(readdirSync(join(root, '.takt-template-state', 'backups'))).toEqual([]);
    await expect(applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    })).resolves.toMatchObject({ status: 'committed' });
  });

  it('removes partial backup artifacts after capture fails and permits retry', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'language: en\n');
    const baseManifest = manifest({ 'config.yaml': 'language: en\n' });
    const baseLock: TemplateLockV1 = {
      schemaVersion: '1.0',
      manifestSha256: calculateProjectTemplateManifestSha256(baseManifest),
      packVersion: '1.0.0',
      source,
      capabilities: [],
      entries: [{
        path: 'config.yaml',
        policy: 'managed',
        mode: '0644',
        sha256: hash('language: en\n'),
        capabilities: [],
      }],
    };
    writeFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH), `${JSON.stringify(baseLock)}\n`);
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          !injected
          && operation === 'file-fsync'
          && path.includes(`${sep}backups${sep}`)
        ) {
          injected = true;
          throw new Error('injected backup preparation fault');
        }
      },
    });

    const failed = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(failed).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(readdirSync(join(root, '.takt-template-state', 'staging'))).toEqual([]);
    expect(readdirSync(join(root, '.takt-template-state', 'backups'))).toEqual([]);
    await expect(applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    })).resolves.toMatchObject({ status: 'committed' });
  });

  it('does not publish a terminal journal when the backup manifest fails before publication', async () => {
    const root = makeRoot();
    const contents = { 'generated/config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          !injected
          && operation === 'file-fsync'
          && path.includes(`${sep}backups${sep}`)
          && path.includes('.manifest.json.')
        ) {
          injected = true;
          throw new Error('injected manifest publication fault');
        }
      },
    });

    const failed = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(injected).toBe(true);
    expect(failed).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(existsSync(join(root, '.takt-template-state', 'journal.json'))).toBe(false);
    await expect(recoverProjectTemplateApply({ projectRoot: root }))
      .resolves.toMatchObject({ status: 'not_started', code: 'NO_RECOVERY_STATE' });
    await expect(applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    })).resolves.toMatchObject({ status: 'committed' });
  });

  it('fails closed when preparation artifact cleanup fails', async () => {
    const root = makeRoot();
    const contents = { 'generated/config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    let preparationFailed = false;
    let cleanupFailed = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          !preparationFailed
          && operation === 'file-fsync'
          && path.includes(`${sep}staging${sep}`)
        ) {
          preparationFailed = true;
          throw new Error('injected preparation fault');
        }
        if (
          preparationFailed
          && !cleanupFailed
          && operation === 'rmdir'
          && path.includes(`${sep}staging${sep}`)
        ) {
          cleanupFailed = true;
          throw new Error('injected cleanup fault');
        }
      },
    });

    const failed = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(cleanupFailed).toBe(true);
    expect(failed).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(inspectProjectTemplateApplyGuard({ repoPath: root }).passed).toBe(true);
    await expect(applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    })).resolves.toMatchObject({ status: 'committed' });
  });

  it('reclaims crash-left preparation orphans under the next apply lease', async () => {
    const root = makeRoot();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: root });
    mkdirSync(join(storage.stagingRoot, 'crashed-transaction'), { recursive: true });
    writeFileSync(join(storage.stagingRoot, 'crashed-transaction', 'partial'), 'partial');
    mkdirSync(join(storage.backupsRoot, 'crashed-backup', 'blobs'), { recursive: true });
    writeFileSync(join(storage.backupsRoot, 'crashed-backup', 'blobs', 'partial'), 'partial');
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);

    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });

    expect(applied.status).toBe('committed');
    expect(existsSync(join(storage.stagingRoot, 'crashed-transaction'))).toBe(false);
    expect(existsSync(join(storage.backupsRoot, 'crashed-backup'))).toBe(false);
  });

  it('does not create control or target bytes while an active run exists', async () => {
    const root = makeRoot();
    const runRoot = join(root, '.takt', 'runs', 'active-run');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'meta.json'), JSON.stringify({
      task: 'active task',
      workflow: 'default',
      status: 'running',
      startTime: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:30:00.000Z',
    }));
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      now: new Date('2026-07-29T00:45:00.000Z'),
    });

    expect(result).toMatchObject({ status: 'not_started', code: 'APPLY_GUARD_BLOCKED' });
    expect(existsSync(join(root, '.takt-template-state'))).toBe(false);
    expect(existsSync(join(root, '.takt', 'config.yaml'))).toBe(false);
  });

  it('blocks rollback when any applied path drifted', async () => {
    const root = makeRoot();
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });
    expect(applied.status).toBe('committed');
    chmodSync(join(root, '.takt', 'config.yaml'), 0o600);

    const result = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: applied.status === 'committed' ? applied.backupId : '',
    });

    expect(result).toMatchObject({ status: 'not_started', code: 'ROLLBACK_DRIFT' });
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf-8')).toBe('language: ja\n');
    expect(statSync(join(root, '.takt', 'config.yaml')).mode & 0o777).toBe(0o600);
  });

  it.each(['write', 'chmod', 'file-fsync', 'rename'] as const)(
    'leaves the target byte-identical when %s fails before publish',
    async (faultOperation) => {
      const root = makeRoot();
      const contents = { 'config.yaml': 'language: ja\n' };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs);
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation) {
          if (!injected && operation === faultOperation) {
            injected = true;
            throw new Error('injected storage fault');
          }
        },
      });

      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: blobs,
        io,
      });

      expect(result.status).toBe('not_started');
      expect(() => readFileSync(join(root, '.takt', 'config.yaml'))).toThrow();
      expect(injected).toBe(true);
    },
  );

  it('writes a terminal journal when the first target publish fails before mutation', async () => {
    const root = makeRoot();
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (operation === 'rename' && path.endsWith('/.takt/config.yaml')) {
          throw new Error('injected first target publish fault');
        }
      },
    });

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(() => readFileSync(join(root, '.takt', 'config.yaml'))).toThrow();
    expect(inspectProjectTemplateApplyGuard({ repoPath: root }).passed).toBe(true);
  });

  it('compensates a directory fsync failure after a visible rename', async () => {
    const root = makeRoot();
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (
          !injected
          && operation === 'directory-fsync'
          && path.endsWith('/.takt')
        ) {
          injected = true;
          throw new Error('injected post-publish durability fault');
        }
      },
    });

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(() => readFileSync(join(root, '.takt', 'config.yaml'))).toThrow();
    expect(() => readFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toThrow();
    expect(injected).toBe(true);
  });

  it('automatically restores the original tree when post-apply doctor fails', async () => {
    const root = makeRoot();
    rmSync(join(root, '.takt'), { recursive: true });
    const contents = { 'workflows/broken.yaml': 'broken: [\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'APPLY_FAILED_ROLLED_BACK',
    });
    expect(existsSync(join(root, '.takt', 'workflows', 'broken.yaml'))).toBe(false);
    expect(existsSync(join(root, '.takt'))).toBe(false);
    expect(inspectProjectTemplateApplyGuard({ repoPath: root }).passed).toBe(true);
  });

  it('converges idempotently from a non-terminal journal even if its marker was lost', async () => {
    const root = makeRoot();
    rmSync(join(root, '.takt'), { recursive: true });
    const contents = { 'config.yaml': 'language: ja\n' };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const io = createProjectTemplateApplyStorageIo({
      before(operation, path) {
        if (operation === 'directory-fsync' && path.endsWith('/.takt')) {
          throw new Error('injected target directory durability fault');
        }
      },
    });

    const failed = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      io,
    });

    expect(failed).toMatchObject({
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
      message: 'project template recovery is required',
    });
    const markerPath = join(root, '.takt-template-state', 'recovery-required.json');
    expect(existsSync(markerPath)).toBe(true);
    // Models termination in the narrow interval where the durable journal is
    // present but the explicit marker could not be retained.
    unlinkSync(markerPath);
    writeFileSync(
      join(root, '.takt-template-state', 'apply.lock'),
      JSON.stringify({
        version: 1,
        token: 'crashed-apply-owner',
        pid: 99_999,
      }),
    );

    const recovered = await recoverProjectTemplateApply({ projectRoot: root });
    expect(recovered.status).toBe('rolled_back');
    expect(existsSync(join(root, '.takt'))).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
    await expect(recoverProjectTemplateApply({ projectRoot: root }))
      .resolves.toMatchObject({ status: 'rolled_back' });
  });
});
