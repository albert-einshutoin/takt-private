import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProjectTemplatePlan as applyProjectTemplatePlanRaw,
  PROJECT_TEMPLATE_LOCK_PATH,
  recoverProjectTemplateApply,
  rollbackProjectTemplateApply,
} from '../../features/project-template/apply-executor.js';
import {
  calculateProjectTemplateManifestSha256,
  captureProjectTemplateTargetSnapshot,
  createProjectTemplateApplyPlan,
  inspectProjectTemplateApplyGuard,
  prepareProjectTemplateApplyPlan,
  type ProjectTemplateManifestV1,
  type ProjectTemplateIncomingContent,
  type ProjectTemplateIncomingInspectionEvidence,
  type TemplateLockV1,
} from '../../features/project-template/index.js';
import {
  consumeProjectTemplateApplyApprovalEvidence,
  issueTrustedProjectTemplateApplyApproval,
} from '../../features/project-template/apply-approval.js';
import {
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  readProjectTemplateApprovalRecord,
} from '../../features/project-template/apply-storage.js';
import { canonicalizeTaktpackJson } from '../../features/project-template/canonical-json.js';
import {
  readProjectTemplateMergeBaseline,
  writeProjectTemplateMergeBaseline,
} from '../../features/project-template/merge-baseline-store.js';

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

function incomingInspection(
  incomingManifest: ProjectTemplateManifestV1,
): ProjectTemplateIncomingInspectionEvidence {
  return {
    archiveSha256: 'd'.repeat(64),
    manifestSha256: calculateProjectTemplateManifestSha256(incomingManifest),
    currentTaktVersion: '0.48.0',
    compatibilityStatus: 'compatible',
  };
}

type ApplyOptions = Parameters<typeof applyProjectTemplatePlanRaw>[0];

function applyProjectTemplatePlan(
  options: Omit<ApplyOptions, 'incomingInspection' | 'baselineStrategy'> & {
    incomingInspection?: ProjectTemplateIncomingInspectionEvidence;
    baselineStrategy?: 'conflict' | 'adopt-identical';
  },
) {
  return applyProjectTemplatePlanRaw({
    ...options,
    incomingInspection: options.incomingInspection
      ?? incomingInspection(options.incomingManifest),
    baselineStrategy: options.baselineStrategy
      ?? (options.plan.baseLockSha256 === undefined ? 'adopt-identical' : 'conflict'),
  });
}

function resealPlan(
  plan: Awaited<ReturnType<typeof createPlan>>,
  mutate: (body: Record<string, unknown>) => void,
): Awaited<ReturnType<typeof createPlan>> {
  const body = structuredClone(plan) as unknown as Record<string, unknown>;
  delete body['planId'];
  mutate(body);
  return {
    ...body,
    planId: hash(canonicalizeTaktpackJson(body)),
  } as unknown as Awaited<ReturnType<typeof createPlan>>;
}

function baseLockFor(
  baseManifest: ProjectTemplateManifestV1,
  packVersion = '1.0.0',
): TemplateLockV1 {
  return {
    schemaVersion: '1.0',
    manifestSha256: calculateProjectTemplateManifestSha256(baseManifest),
    packVersion,
    source,
    capabilities: [...(baseManifest.capabilities ?? [])],
    entries: baseManifest.entries.map((entry) => ({
      path: entry.path,
      policy: entry.policy,
      mode: entry.mode,
      sha256: entry.sha256,
      capabilities: [...(entry.capabilities ?? [])],
    })),
  };
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
    incomingInspection: incomingInspection(incomingManifest),
    baselineStrategy: baseLock === undefined ? 'adopt-identical' : 'conflict',
  });
}

async function createSemanticConfigPlan(options: {
  root: string;
  base: string;
  incoming: string;
}) {
  const baseManifest = manifest({ 'config.yaml': options.base });
  baseManifest.entries[0]!.policy = 'merge';
  const baseLock = baseLockFor(baseManifest);
  const incomingManifest = manifest({ 'config.yaml': options.incoming });
  incomingManifest.entries[0]!.policy = 'merge';
  const blobs = incomingContents({ 'config.yaml': options.incoming });
  const snapshot = await captureProjectTemplateTargetSnapshot(
    options.root,
    ['config.yaml'],
  );
  const prepared = prepareProjectTemplateApplyPlan({
    baseLock,
    baseContents: [{
      path: 'config.yaml',
      content: Buffer.from(options.base),
    }],
    incomingManifest,
    localEntries: snapshot.entries,
    targetRootState: snapshot.rootState,
    missingPathTracking: snapshot.missingPathTracking,
    incomingContents: blobs,
    incomingInspection: incomingInspection(incomingManifest),
    baselineStrategy: 'conflict',
  });
  return { baseLock, incomingManifest, blobs, prepared };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template atomic apply executor', () => {
  it('applies resolved merge bytes and durably retains incoming baselines across rollback', async () => {
    const root = makeRoot();
    const base = 'provider_routing:\n  personas:\n    planner: codex\n';
    const local = 'provider_routing:\n  personas:\n    planner: claude\n';
    const incoming = `${base}timezone: Asia/Tokyo\n`;
    writeTakt(root, 'config.yaml', local);
    const { baseLock, incomingManifest, blobs, prepared } =
      await createSemanticConfigPlan({ root, base, incoming });
    writeFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      `${JSON.stringify(baseLock)}\n`,
    );
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: root });
    await writeProjectTemplateMergeBaseline({
      storage,
      expectedSha256: hash(base),
      content: Buffer.from(base),
    });

    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan: prepared.plan,
      incomingManifest,
      incomingContents: blobs,
      resolvedContents: prepared.resolvedContents,
    });

    expect(applied.status).toBe('committed');
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
      .toContain('planner: claude');
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
      .toContain('timezone: Asia/Tokyo');
    await expect(readProjectTemplateMergeBaseline({
      storage,
      expectedSha256: hash(incoming),
    })).resolves.toEqual(Buffer.from(incoming));

    const rolledBack = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: applied.status === 'committed' ? applied.backupId : '',
    });
    expect(rolledBack.status).toBe('rolled_back');
    await expect(readProjectTemplateMergeBaseline({
      storage,
      expectedSha256: hash(incoming),
    })).resolves.toEqual(Buffer.from(incoming));
  });

  it('rejects missing, duplicate, unknown, and tampered resolved bytes before the lease boundary', async () => {
    const root = makeRoot();
    const base = 'provider_routing:\n  personas:\n    planner: codex\n';
    const local = 'provider_routing:\n  personas:\n    planner: claude\n';
    const incoming = `${base}timezone: Asia/Tokyo\n`;
    writeTakt(root, 'config.yaml', local);
    const { baseLock, incomingManifest, blobs, prepared } =
      await createSemanticConfigPlan({ root, base, incoming });
    writeFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      `${JSON.stringify(baseLock)}\n`,
    );
    const resolved = prepared.resolvedContents[0]!;
    const cases: Array<{
      name: string;
      resolvedContents: ProjectTemplateIncomingContent[];
    }> = [
      { name: 'missing', resolvedContents: [] },
      { name: 'duplicate', resolvedContents: [resolved, resolved] },
      {
        name: 'unknown',
        resolvedContents: [{ path: 'other.yaml', content: resolved.content }],
      },
      {
        name: 'tampered',
        resolvedContents: [{
          path: resolved.path,
          content: Buffer.from('language: ja\n'),
        }],
      },
    ];
    const leasePath = join(root, '.takt-template-state', 'apply.lock');
    mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 });
    writeFileSync(leasePath, '{}', { mode: 0o600 });

    for (const testCase of cases) {
      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan: prepared.plan,
        incomingManifest,
        incomingContents: blobs,
        resolvedContents: testCase.resolvedContents,
      });
      expect(result, testCase.name).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(existsSync(leasePath), testCase.name).toBe(true);
    }

    writeTakt(root, 'config.yaml', base);
    const upstreamManifest = manifest({ 'config.yaml': incoming });
    upstreamManifest.entries[0]!.policy = 'merge';
    const upstreamBlobs = incomingContents({ 'config.yaml': incoming });
    const upstreamPlan = await createPlan(
      root,
      upstreamManifest,
      upstreamBlobs,
      baseLock,
    );
    const extraneous = await applyProjectTemplatePlan({
      projectRoot: root,
      plan: upstreamPlan,
      incomingManifest: upstreamManifest,
      incomingContents: upstreamBlobs,
      resolvedContents: upstreamBlobs,
    });
    expect(extraneous).toMatchObject({
      status: 'not_started',
      code: 'INVALID_APPLY_INPUT',
    });
    expect(existsSync(leasePath)).toBe(true);
  });

  it.each(['missing', 'corrupt'] as const)(
    'fails closed after lease acquisition when a formal merge baseline is %s',
    async (baselineState) => {
      const root = makeRoot();
      const base = 'provider_routing:\n  personas:\n    planner: codex\n';
      const local = 'provider_routing:\n  personas:\n    planner: claude\n';
      const incoming = `${base}timezone: Asia/Tokyo\n`;
      writeTakt(root, 'config.yaml', local);
      const { baseLock, incomingManifest, blobs, prepared } =
        await createSemanticConfigPlan({ root, base, incoming });
      writeFileSync(
        join(root, PROJECT_TEMPLATE_LOCK_PATH),
        `${JSON.stringify(baseLock)}\n`,
      );
      if (baselineState === 'corrupt') {
        const storage = await initializeProjectTemplateApplyStorage({ repoPath: root });
        writeFileSync(
          join(storage.baselinesRoot, hash(base)),
          'corrupt',
          { mode: 0o600 },
        );
      }

      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan: prepared.plan,
        incomingManifest,
        incomingContents: blobs,
        resolvedContents: prepared.resolvedContents,
      });

      expect(result).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8')).toBe(local);
    },
  );

  it.each([
    ['unchanged', 'language: en\n'],
    ['locally edited', 'language: ja\n'],
    ['locally deleted', undefined],
  ] as const)(
    'bootstraps a missing legacy baseline when semantic config is %s',
    async (_state, localContent) => {
      const root = makeRoot();
      const config = 'language: en\n';
      if (localContent !== undefined) writeTakt(root, 'config.yaml', localContent);
      const baseManifest = manifest({ 'config.yaml': config });
      baseManifest.entries[0]!.policy = 'merge';
      const baseLock = baseLockFor(baseManifest);
      writeFileSync(
        join(root, PROJECT_TEMPLATE_LOCK_PATH),
        `${JSON.stringify(baseLock)}\n`,
      );
      const incomingManifest = manifest({ 'config.yaml': config });
      incomingManifest.entries[0]!.policy = 'merge';
      const blobs = incomingContents({ 'config.yaml': config });
      const plan = await createPlan(root, incomingManifest, blobs, baseLock);

      const applied = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: blobs,
      });

      expect(applied.status).toBe('committed');
      expect(existsSync(join(root, '.takt', 'config.yaml')))
        .toBe(localContent !== undefined);
      if (localContent !== undefined) {
        expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
          .toBe(localContent);
      }
      const storage = await initializeProjectTemplateApplyStorage({ repoPath: root });
      await expect(readProjectTemplateMergeBaseline({
        storage,
        expectedSha256: hash(config),
      })).resolves.toEqual(Buffer.from(config));
    },
  );

  it('does not require or persist semantic baselines for non-config merge entries', async () => {
    const root = makeRoot();
    writeTakt(root, 'notes.txt', 'old\n');
    const baseManifest = manifest({ 'notes.txt': 'old\n' });
    baseManifest.entries[0]!.policy = 'merge';
    const baseLock = baseLockFor(baseManifest);
    writeFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      `${JSON.stringify(baseLock)}\n`,
    );
    const incomingManifest = manifest({ 'notes.txt': 'new\n' });
    incomingManifest.entries[0]!.policy = 'merge';
    const blobs = incomingContents({ 'notes.txt': 'new\n' });
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);

    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });

    expect(applied.status).toBe('committed');
    expect(readFileSync(join(root, '.takt', 'notes.txt'), 'utf8')).toBe('new\n');
    expect(readdirSync(join(root, '.takt-template-state', 'merge-baselines')))
      .toEqual([]);
  });

  it('rejects a re-sealed plan whose update action was changed to keep', async () => {
    const root = makeRoot();
    writeTakt(root, 'notes.txt', 'old\n');
    const baseManifest = manifest({ 'notes.txt': 'old\n' });
    const baseLock: TemplateLockV1 = {
      schemaVersion: '1.0',
      manifestSha256: calculateProjectTemplateManifestSha256(baseManifest),
      packVersion: '1.0.0',
      source,
      capabilities: [],
      entries: [{
        path: 'notes.txt',
        policy: 'managed',
        mode: '0644',
        sha256: hash('old\n'),
        capabilities: [],
      }],
    };
    writeFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH), `${JSON.stringify(baseLock)}\n`);
    const incomingManifest = manifest({ 'notes.txt': 'new\n' });
    const blobs = incomingContents({ 'notes.txt': 'new\n' });
    const original = await createPlan(root, incomingManifest, blobs, baseLock);
    expect(original.entries[0]).toMatchObject({
      path: 'notes.txt',
      action: 'update',
    });
    const forgedBody = structuredClone(original) as Record<string, unknown>;
    const forgedEntries = forgedBody['entries'] as Array<Record<string, unknown>>;
    forgedEntries[0]!['action'] = 'keep';
    delete forgedBody['planId'];
    const forgedPlan = {
      ...forgedBody,
      planId: hash(canonicalizeTaktpackJson(forgedBody)),
    } as unknown as typeof original;

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan: forgedPlan,
      incomingManifest,
      incomingContents: blobs,
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'INVALID_APPLY_INPUT',
    });
    expect(readFileSync(join(root, '.takt', 'notes.txt'), 'utf8')).toBe('old\n');
    expect(JSON.parse(readFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH), 'utf8')))
      .toMatchObject({ manifestSha256: baseLock.manifestSha256 });
  });

  it('rejects re-sealed entry and global semantic tampering without target, lock, or journal mutation', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'old\n');
    const baseManifest = manifest({ 'config.yaml': 'old\n' });
    const baseLock = baseLockFor(baseManifest);
    const lockPath = join(root, PROJECT_TEMPLATE_LOCK_PATH);
    const originalLock = `${JSON.stringify(baseLock)}\n`;
    writeFileSync(lockPath, originalLock);
    const incomingManifest = manifest({ 'config.yaml': 'new\n' });
    const blobs = incomingContents({ 'config.yaml': 'new\n' });
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);
    const cases: Array<{
      name: string;
      mutate: (body: Record<string, unknown>) => void;
    }> = [
      {
        name: 'incoming mode',
        mutate(body) {
          ((body['entries'] as Array<Record<string, unknown>>)[0]!)
            ['incomingMode'] = '0755';
        },
      },
      {
        name: 'incoming digest',
        mutate(body) {
          ((body['entries'] as Array<Record<string, unknown>>)[0]!)
            ['incomingSha256'] = 'e'.repeat(64);
        },
      },
      {
        name: 'entry capability',
        mutate(body) {
          ((body['entries'] as Array<Record<string, unknown>>)[0]!)
            ['capabilitiesAfter'] = ['executable'];
        },
      },
      {
        name: 'missing entry',
        mutate(body) {
          body['entries'] = [];
        },
      },
      {
        name: 'extra entry',
        mutate(body) {
          const entries = body['entries'] as Array<Record<string, unknown>>;
          entries.push({ ...entries[0]!, path: 'extra.yaml' });
        },
      },
      {
        name: 'global compatibility',
        mutate(body) {
          body['incomingCompatibility'] = 'unknown';
        },
      },
      {
        name: 'global archive digest',
        mutate(body) {
          body['incomingArchiveSha256'] = 'e'.repeat(64);
        },
      },
      {
        name: 'global capability',
        mutate(body) {
          body['capabilitiesAfter'] = ['executable'];
        },
      },
      {
        name: 'default apply flag',
        mutate(body) {
          body['defaultApplyPossible'] = false;
        },
      },
      {
        name: 'review flag',
        mutate(body) {
          body['reviewRequired'] = true;
        },
      },
    ];

    for (const testCase of cases) {
      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan: resealPlan(plan, testCase.mutate),
        incomingManifest,
        incomingContents: blobs,
      });

      expect(result, testCase.name).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'), testCase.name)
        .toBe('old\n');
      expect(readFileSync(lockPath, 'utf8'), testCase.name).toBe(originalLock);
      expect(existsSync(join(root, '.takt-template-state', 'journal.json')), testCase.name)
        .toBe(false);
      const stagingRoot = join(root, '.takt-template-state', 'staging');
      const backupsRoot = join(root, '.takt-template-state', 'backups');
      if (existsSync(stagingRoot)) {
        expect(readdirSync(stagingRoot), testCase.name).toEqual([]);
      }
      if (existsSync(backupsRoot)) {
        expect(readdirSync(backupsRoot), testCase.name).toEqual([]);
      }
    }
  });

  it.each(['add', 'delete'] as const)(
    'rejects a re-sealed %s action changed to keep',
    async (scenario) => {
      const root = makeRoot();
      let incomingManifest: ProjectTemplateManifestV1;
      let blobs: ProjectTemplateIncomingContent[];
      let baseLock: TemplateLockV1 | undefined;
      if (scenario === 'add') {
        incomingManifest = manifest({ 'notes.txt': 'new\n' });
        blobs = incomingContents({ 'notes.txt': 'new\n' });
      } else {
        writeTakt(root, 'notes.txt', 'old\n');
        const baseManifest = manifest({ 'notes.txt': 'old\n' });
        baseLock = baseLockFor(baseManifest);
        writeFileSync(
          join(root, PROJECT_TEMPLATE_LOCK_PATH),
          `${JSON.stringify(baseLock)}\n`,
        );
        incomingManifest = manifest({});
        blobs = [];
      }
      const plan = await createPlan(
        root,
        incomingManifest,
        blobs,
        baseLock,
      );
      expect(plan.entries[0]?.action).toBe(scenario);
      const forged = resealPlan(plan, (body) => {
        ((body['entries'] as Array<Record<string, unknown>>)[0]!)
          ['action'] = 'keep';
      });

      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan: forged,
        incomingManifest,
        incomingContents: blobs,
      });

      expect(result).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(existsSync(join(root, '.takt-template-state', 'journal.json')))
        .toBe(false);
      expect(existsSync(join(root, '.takt', 'notes.txt'))).toBe(scenario === 'delete');
    },
  );

  it('rejects receipt and incoming-content mismatches before mutation', async () => {
    const root = makeRoot();
    const incomingManifest = manifest({ 'config.yaml': 'new\n' });
    const blobs = incomingContents({ 'config.yaml': 'new\n' });
    const plan = await createPlan(root, incomingManifest, blobs);
    const cases = [
      {
        name: 'receipt archive mismatch',
        receipt: {
          ...incomingInspection(incomingManifest),
          archiveSha256: 'e'.repeat(64),
        },
        contents: blobs,
      },
      {
        name: 'receipt manifest mismatch',
        receipt: {
          ...incomingInspection(incomingManifest),
          manifestSha256: 'e'.repeat(64),
        },
        contents: blobs,
      },
      {
        name: 'receipt compatibility mismatch',
        receipt: {
          ...incomingInspection(incomingManifest),
          compatibilityStatus: 'unknown' as const,
        },
        contents: blobs,
      },
      {
        name: 'missing content',
        receipt: incomingInspection(incomingManifest),
        contents: [],
      },
      {
        name: 'extra content',
        receipt: incomingInspection(incomingManifest),
        contents: [
          ...blobs,
          { path: 'extra.yaml', content: Buffer.from('extra\n') },
        ],
      },
    ];

    for (const testCase of cases) {
      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: testCase.contents,
        incomingInspection: testCase.receipt,
      });
      expect(result, testCase.name).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(existsSync(join(root, '.takt', 'config.yaml')), testCase.name)
        .toBe(false);
      expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH)), testCase.name)
        .toBe(false);
      expect(existsSync(join(root, '.takt-template-state', 'journal.json')), testCase.name)
        .toBe(false);
    }
  });

  it('commits a legal keep plan and publishes the matching manifest lock', async () => {
    const root = makeRoot();
    writeTakt(root, 'settings.yaml', 'same\n');
    const incomingManifest = manifest({ 'settings.yaml': 'same\n' });
    const blobs = incomingContents({ 'settings.yaml': 'same\n' });
    const plan = await createPlan(root, incomingManifest, blobs);
    expect(plan.entries[0]).toMatchObject({
      action: 'keep',
      reasonCode: 'BASELINE_ADOPTED',
    });

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });

    expect(result.status).toBe('committed');
    expect(readFileSync(join(root, '.takt', 'settings.yaml'), 'utf8')).toBe('same\n');
    expect(JSON.parse(readFileSync(join(root, PROJECT_TEMPLATE_LOCK_PATH), 'utf8')))
      .toMatchObject({
        manifestSha256: calculateProjectTemplateManifestSha256(incomingManifest),
      });
  });

  it('applies a capability-bearing first install with independently bound approval evidence', async () => {
    const root = makeRoot();
    const contents = {
      'hooks/install.sh': '#!/bin/sh\necho approved\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    expect(plan).toMatchObject({
      reviewRequired: true,
      defaultApplyPossible: false,
      capabilitiesAfter: ['executable'],
    });
    const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      approvalEvidence,
    });

    expect(result.status).toBe('committed');
    expect(readFileSync(
      join(root, '.takt', 'hooks', 'install.sh'),
      'utf8',
    )).toBe(contents['hooks/install.sh']);
    expect(JSON.parse(readFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      'utf8',
    ))).toMatchObject({
      capabilities: ['executable'],
    });
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'approvals',
      `${approvalEvidence.approvalId}.json`,
    ))).toBe(true);
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'approval-claims',
      `${approvalEvidence.approvalId}.json`,
    ))).toBe(true);
  });

  it('rejects same-plan replay after rollback even when the issued record is restored', async () => {
    const root = makeRoot();
    const contents = {
      'hooks/install.sh': '#!/bin/sh\necho approved\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });
    const approvalPath = join(
      root,
      '.takt-template-state',
      'approvals',
      `${approvalEvidence.approvalId}.json`,
    );
    const issuedRecord = readFileSync(approvalPath);
    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      approvalEvidence,
    });
    expect(applied.status).toBe('committed');
    if (applied.status !== 'committed') return;
    await expect(rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: applied.backupId,
    })).resolves.toMatchObject({ status: 'rolled_back' });
    writeFileSync(approvalPath, issuedRecord, { mode: 0o600 });
    const journalPath = join(root, '.takt-template-state', 'journal.json');
    const journalBeforeReplay = readFileSync(journalPath, 'utf8');

    const replay = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
      approvalEvidence,
    });

    expect(replay).toMatchObject({
      status: 'not_started',
      code: 'INVALID_APPLY_INPUT',
    });
    expect(existsSync(join(root, '.takt', 'hooks', 'install.sh'))).toBe(false);
    expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBeforeReplay);
  });

  it('allows exactly one concurrent approval claim', async () => {
    const root = makeRoot();
    const contents = {
      'hooks/install.sh': '#!/bin/sh\necho approved\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });
    const storage = await initializeProjectTemplateApplyStorage({
      repoPath: root,
    });

    const results = await Promise.all([
      consumeProjectTemplateApplyApprovalEvidence({
        storage,
        plan,
        baselineStrategy: 'adopt-identical',
        evidence: approvalEvidence,
      }),
      consumeProjectTemplateApplyApprovalEvidence({
        storage,
        plan,
        baselineStrategy: 'adopt-identical',
        evidence: approvalEvidence,
      }),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(statSync(join(
      root,
      '.takt-template-state',
      'approval-claims',
      `${approvalEvidence.approvalId}.json`,
    )).mode & 0o777).toBe(0o600);
  });

  it.each(['file-fsync', 'directory-fsync'] as const)(
    'burns approval and fails closed when claim %s fails',
    async (faultOperation) => {
      const root = makeRoot();
      const contents = {
        'hooks/install.sh': '#!/bin/sh\necho approved\n',
      };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs);
      const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
        projectRoot: root,
        plan,
        baselineStrategy: 'adopt-identical',
        decision: 'approved',
      });
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (
            !injected
            && operation === faultOperation
            && (
              (
                operation === 'file-fsync'
                && path.endsWith(`${approvalEvidence.approvalId}.json`)
              )
              || (
                operation === 'directory-fsync'
                && basename(path) === 'approval-claims'
              )
            )
          ) {
            injected = true;
            throw new Error('injected approval claim durability fault');
          }
        },
      });
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: root,
        io,
      });

      await expect(consumeProjectTemplateApplyApprovalEvidence({
        storage,
        plan,
        baselineStrategy: 'adopt-identical',
        evidence: approvalEvidence,
      })).resolves.toBe(false);

      expect(injected).toBe(true);
      expect(existsSync(join(
        root,
        '.takt-template-state',
        'approval-claims',
        `${approvalEvidence.approvalId}.json`,
      ))).toBe(true);
      const retryStorage = await initializeProjectTemplateApplyStorage({
        repoPath: root,
      });
      await expect(consumeProjectTemplateApplyApprovalEvidence({
        storage: retryStorage,
        plan,
        baselineStrategy: 'adopt-identical',
        evidence: approvalEvidence,
      })).resolves.toBe(false);
      expect(existsSync(join(root, '.takt', 'hooks', 'install.sh'))).toBe(false);
      expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
      expect(existsSync(join(
        root,
        '.takt-template-state',
        'journal.json',
      ))).toBe(false);
    },
  );

  it.each(['unlink', 'rename'] as const)(
    'claims approval without relying on a fallible %s operation',
    async (forbiddenOperation) => {
      const root = makeRoot();
      const contents = {
        'hooks/install.sh': '#!/bin/sh\necho approved\n',
      };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs);
      const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
        projectRoot: root,
        plan,
        baselineStrategy: 'adopt-identical',
        decision: 'approved',
      });
      let invoked = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation) {
          if (operation === forbiddenOperation) {
            invoked = true;
            throw new Error('claim used a forbidden destructive operation');
          }
        },
      });
      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: root,
        io,
      });

      await expect(consumeProjectTemplateApplyApprovalEvidence({
        storage,
        plan,
        baselineStrategy: 'adopt-identical',
        evidence: approvalEvidence,
      })).resolves.toBe(true);
      expect(invoked).toBe(false);
    },
  );

  it('rejects missing, mismatched, replayed, rejected, and forged approval evidence before mutation', async () => {
    const root = makeRoot();
    const contents = {
      'hooks/install.sh': '#!/bin/sh\necho approved\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const valid = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });
    const approvalsRoot = join(root, '.takt-template-state', 'approvals');
    expect(statSync(approvalsRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(
      approvalsRoot,
      `${valid.approvalId}.json`,
    )).mode & 0o777).toBe(0o600);
    const replayManifest = manifest({
      'hooks/install.sh': '#!/bin/sh\necho different plan\n',
    });
    const replayPlan = await createPlan(
      root,
      replayManifest,
      incomingContents({
        'hooks/install.sh': '#!/bin/sh\necho different plan\n',
      }),
    );
    const replayed = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan: replayPlan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });
    const rejected = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'rejected',
    });
    const expired = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
      now: new Date('2020-01-01T00:00:00.000Z'),
      expiresInMs: 1,
    });
    const forgedRecord = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });
    const forgedRecordPath = join(
      root,
      '.takt-template-state',
      'approvals',
      `${forgedRecord.approvalId}.json`,
    );
    const forgedRecordBody = JSON.parse(
      readFileSync(forgedRecordPath, 'utf8'),
    ) as Record<string, unknown>;
    forgedRecordBody['reviewSurfaceSha256'] = 'f'.repeat(64);
    writeFileSync(forgedRecordPath, `${JSON.stringify(forgedRecordBody)}\n`);
    const cases: Array<{ name: string; evidence?: unknown }> = [
      { name: 'missing' },
      {
        name: 'mismatched nonce',
        evidence: { ...valid, nonce: '00000000-0000-0000-0000-000000000000' },
      },
      { name: 'replayed for another plan', evidence: replayed },
      { name: 'rejected decision', evidence: rejected },
      { name: 'expired decision', evidence: expired },
      { name: 'forged durable review context', evidence: forgedRecord },
      {
        name: 'forged approval reference',
        evidence: {
          ...valid,
          approvalId: 'approval-forged',
        },
      },
    ];

    for (const testCase of cases) {
      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: blobs,
        ...(testCase.evidence === undefined
          ? {}
          : { approvalEvidence: testCase.evidence as typeof valid }),
      });

      expect(result, testCase.name).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(existsSync(join(root, '.takt', 'hooks', 'install.sh')), testCase.name)
        .toBe(false);
      expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH)), testCase.name)
        .toBe(false);
      expect(existsSync(
        join(root, '.takt-template-state', 'journal.json'),
      ), testCase.name).toBe(false);
    }
  });

  it.each(['mode-0400', 'mode-0700', 'hardlink', 'symlink', 'oversize'] as const)(
    'rejects an unsafe approval record with %s before mutation',
    async (unsafeKind) => {
      const root = makeRoot();
      const contents = {
        'hooks/install.sh': '#!/bin/sh\necho approved\n',
      };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs);
      const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
        projectRoot: root,
        plan,
        baselineStrategy: 'adopt-identical',
        decision: 'approved',
      });
      const approvalPath = join(
        root,
        '.takt-template-state',
        'approvals',
        `${approvalEvidence.approvalId}.json`,
      );
      if (unsafeKind === 'mode-0400') {
        chmodSync(approvalPath, 0o400);
      } else if (unsafeKind === 'mode-0700') {
        chmodSync(approvalPath, 0o700);
      } else if (unsafeKind === 'hardlink') {
        const linkedSource = join(root, 'linked-approval.json');
        writeFileSync(linkedSource, readFileSync(approvalPath), { mode: 0o600 });
        unlinkSync(approvalPath);
        linkSync(linkedSource, approvalPath);
      } else if (unsafeKind === 'symlink') {
        const linkedSource = join(root, 'symlinked-approval.json');
        writeFileSync(linkedSource, readFileSync(approvalPath), { mode: 0o600 });
        unlinkSync(approvalPath);
        symlinkSync(linkedSource, approvalPath);
      } else {
        writeFileSync(approvalPath, Buffer.alloc(64 * 1024 + 1));
      }

      const result = await applyProjectTemplatePlan({
        projectRoot: root,
        plan,
        incomingManifest,
        incomingContents: blobs,
        approvalEvidence,
      });

      expect(result).toMatchObject({
        status: 'not_started',
        code: 'INVALID_APPLY_INPUT',
      });
      expect(existsSync(join(root, '.takt', 'hooks', 'install.sh'))).toBe(false);
      expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
      expect(existsSync(join(
        root,
        '.takt-template-state',
        'journal.json',
      ))).toBe(false);
    },
  );

  it.each(['replacement', 'chmod'] as const)(
    'rejects an approval record %s race observed after the opened-FD read',
    async (raceKind) => {
      const root = makeRoot();
      const contents = {
        'hooks/install.sh': '#!/bin/sh\necho approved\n',
      };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs);
      const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
        projectRoot: root,
        plan,
        baselineStrategy: 'adopt-identical',
        decision: 'approved',
      });
      const approvalPath = join(
        root,
        '.takt-template-state',
        'approvals',
        `${approvalEvidence.approvalId}.json`,
      );
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        after(operation, path) {
          if (
            !injected
            && operation === 'read'
            && path.endsWith(`${approvalEvidence.approvalId}.json`)
          ) {
            injected = true;
            if (raceKind === 'replacement') {
              const replacement = `${approvalPath}.replacement`;
              writeFileSync(replacement, readFileSync(approvalPath), {
                mode: 0o600,
              });
              renameSync(replacement, approvalPath);
            } else {
              chmodSync(approvalPath, 0o400);
            }
          }
        },
      });

      const storage = await initializeProjectTemplateApplyStorage({
        repoPath: root,
        io,
      });

      await expect(readProjectTemplateApprovalRecord({
        storage,
        approvalId: approvalEvidence.approvalId,
      })).rejects.toThrow();
      expect(injected).toBe(true);
      expect(existsSync(join(root, '.takt', 'hooks', 'install.sh'))).toBe(false);
      expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
      expect(existsSync(join(
        root,
        '.takt-template-state',
        'journal.json',
      ))).toBe(false);
    },
  );

  it('rejects a re-sealed reviewed plan even with newly generated matching approval evidence', async () => {
    const root = makeRoot();
    const contents = {
      'hooks/install.sh': '#!/bin/sh\necho approved\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const plan = await createPlan(root, incomingManifest, blobs);
    const forgedPlan = resealPlan(plan, (body) => {
      const summary = body['summary'] as Record<string, unknown>;
      summary['human'] = 'forged reviewed summary';
    });
    const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan: forgedPlan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan: forgedPlan,
      incomingManifest,
      incomingContents: blobs,
      approvalEvidence,
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'INVALID_APPLY_INPUT',
    });
    expect(existsSync(join(root, '.takt', 'hooks', 'install.sh'))).toBe(false);
    expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'journal.json',
    ))).toBe(false);
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'approvals',
      `${approvalEvidence.approvalId}.json`,
    ))).toBe(true);
  });

  it('rejects an approval record copied from another project with the same sealed plan', async () => {
    const sourceRoot = makeRoot();
    const targetRoot = makeRoot();
    const contents = {
      'hooks/install.sh': '#!/bin/sh\necho approved\n',
    };
    const incomingManifest = manifest(contents);
    const blobs = incomingContents(contents);
    const sourcePlan = await createPlan(sourceRoot, incomingManifest, blobs);
    const targetPlan = await createPlan(targetRoot, incomingManifest, blobs);
    expect(targetPlan.planId).toBe(sourcePlan.planId);
    const approvalEvidence = await issueTrustedProjectTemplateApplyApproval({
      projectRoot: sourceRoot,
      plan: sourcePlan,
      baselineStrategy: 'adopt-identical',
      decision: 'approved',
    });
    const approvalFileName = `${approvalEvidence.approvalId}.json`;
    const copiedApprovalRoot = join(
      targetRoot,
      '.takt-template-state',
      'approvals',
    );
    mkdirSync(copiedApprovalRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(copiedApprovalRoot, approvalFileName),
      readFileSync(join(
        sourceRoot,
        '.takt-template-state',
        'approvals',
        approvalFileName,
      )),
      { mode: 0o600 },
    );

    const result = await applyProjectTemplatePlan({
      projectRoot: targetRoot,
      plan: targetPlan,
      incomingManifest,
      incomingContents: blobs,
      approvalEvidence,
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'INVALID_APPLY_INPUT',
    });
    expect(existsSync(join(
      targetRoot,
      '.takt',
      'hooks',
      'install.sh',
    ))).toBe(false);
    expect(existsSync(join(
      targetRoot,
      PROJECT_TEMPLATE_LOCK_PATH,
    ))).toBe(false);
    expect(existsSync(join(
      targetRoot,
      '.takt-template-state',
      'journal.json',
    ))).toBe(false);
  });

  it('does not issue approval evidence for a plan with unresolved conflicts', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'local\n');
    const baseManifest = manifest({ 'config.yaml': 'base\n' });
    const baseLock = baseLockFor(baseManifest);
    writeFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      `${JSON.stringify(baseLock)}\n`,
    );
    const incomingManifest = manifest({ 'config.yaml': 'incoming\n' });
    const blobs = incomingContents({ 'config.yaml': 'incoming\n' });
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);
    expect(plan.entries[0]?.action).toBe('conflict');

    await expect(issueTrustedProjectTemplateApplyApproval({
      projectRoot: root,
      plan,
      baselineStrategy: 'conflict',
      decision: 'approved',
    })).rejects.toThrow('hard-blocked');

    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8')).toBe('local\n');
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'journal.json',
    ))).toBe(false);
  });

  it('rejects adoption when the independent baseline strategy requires conflict', async () => {
    const root = makeRoot();
    writeTakt(root, 'settings.yaml', 'same\n');
    const incomingManifest = manifest({ 'settings.yaml': 'same\n' });
    const blobs = incomingContents({ 'settings.yaml': 'same\n' });
    const snapshot = await captureProjectTemplateTargetSnapshot(
      root,
      ['settings.yaml'],
    );
    const receipt = incomingInspection(incomingManifest);
    const conflictPlan = createProjectTemplateApplyPlan({
      incomingManifest,
      localEntries: snapshot.entries,
      targetRootState: snapshot.rootState,
      missingPathTracking: snapshot.missingPathTracking,
      incomingContents: blobs,
      incomingInspection: receipt,
      baselineStrategy: 'conflict',
    });
    expect(conflictPlan.entries[0]).toMatchObject({
      action: 'conflict',
      reasonCode: 'LEGACY_BASELINE_REQUIRED',
    });
    const forgedAdoptionPlan = createProjectTemplateApplyPlan({
      incomingManifest,
      localEntries: snapshot.entries,
      targetRootState: snapshot.rootState,
      missingPathTracking: snapshot.missingPathTracking,
      incomingContents: blobs,
      incomingInspection: receipt,
      baselineStrategy: 'adopt-identical',
    });
    expect(forgedAdoptionPlan.entries[0]).toMatchObject({
      action: 'keep',
      reasonCode: 'BASELINE_ADOPTED',
    });

    const result = await applyProjectTemplatePlan({
      projectRoot: root,
      plan: forgedAdoptionPlan,
      incomingManifest,
      incomingContents: blobs,
      incomingInspection: receipt,
      baselineStrategy: 'conflict',
    });

    expect(result).toMatchObject({
      status: 'not_started',
      code: 'INVALID_APPLY_INPUT',
    });
    expect(readFileSync(join(root, '.takt', 'settings.yaml'), 'utf8')).toBe('same\n');
    expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
    expect(existsSync(join(root, '.takt-template-state', 'journal.json'))).toBe(false);
  });

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
      let createdTaktRemovalStarted = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (operation === 'rmdir' && basename(path) === '.takt') {
            createdTaktRemovalStarted = true;
          }
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
                && createdTaktRemovalStarted
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

  it.each(['existing', 'absent'] as const)(
    'rejects %s formal lock replacement observed during backup capture with zero target mutation',
    async (baseState) => {
      const root = makeRoot();
      const before = 'language: en\n';
      if (baseState === 'existing') writeTakt(root, 'config.yaml', before);
      const baseManifest = manifest(
        baseState === 'existing' ? { 'config.yaml': before } : {},
      );
      const baseLock = baseState === 'existing'
        ? baseLockFor(baseManifest)
        : undefined;
      const lockPath = join(root, PROJECT_TEMPLATE_LOCK_PATH);
      if (baseLock !== undefined) {
        writeFileSync(lockPath, `${JSON.stringify(baseLock)}\n`);
      }
      const contents = { 'config.yaml': 'language: ja\n' };
      const incomingManifest = manifest(contents);
      const blobs = incomingContents(contents);
      const plan = await createPlan(root, incomingManifest, blobs, baseLock);
      const replacement = baseState === 'existing'
        ? baseLock!
        : baseLockFor(manifest({ 'other.yaml': 'replacement\n' }));
      // Existing-lock replacement deliberately preserves semantic content but
      // changes its raw witness, proving capture cannot adopt an equivalent
      // replacement as the historical before-state.
      const replacementText = baseState === 'existing'
        ? `${JSON.stringify(replacement, null, 2)}\n`
        : `${JSON.stringify(replacement)}\n`;
      let replaced = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (
            !replaced
            && operation === 'file-fsync'
            && path.includes(`${sep}staging${sep}`)
          ) {
            replaced = true;
            writeFileSync(lockPath, replacementText);
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

      expect(replaced).toBe(true);
      expect(result).toMatchObject({
        status: 'not_started',
        code: 'BASE_LOCK_DRIFT',
      });
      expect(readFileSync(lockPath, 'utf8')).toBe(replacementText);
      if (baseState === 'existing') {
        expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8')).toBe(before);
      } else {
        expect(existsSync(join(root, '.takt', 'config.yaml'))).toBe(false);
      }
      expect(existsSync(join(root, '.takt-template-state', 'journal.json'))).toBe(false);
      expect(readdirSync(join(root, '.takt-template-state', 'staging'))).toEqual([]);
      expect(readdirSync(join(root, '.takt-template-state', 'backups'))).toEqual([]);
    },
  );

  it.each(['unsafe-symlink', 'read-fault'] as const)(
    'classifies capture-time formal lock %s as BASE_LOCK_DRIFT with zero target mutation',
    async (scenario) => {
      const root = makeRoot();
      const before = 'language: en\n';
      writeTakt(root, 'config.yaml', before);
      const baseManifest = manifest({ 'config.yaml': before });
      const baseLock = baseLockFor(baseManifest);
      const lockPath = join(root, PROJECT_TEMPLATE_LOCK_PATH);
      const originalLock = `${JSON.stringify(baseLock)}\n`;
      writeFileSync(lockPath, originalLock);
      const incomingManifest = manifest({ 'config.yaml': 'language: ja\n' });
      const blobs = incomingContents({ 'config.yaml': 'language: ja\n' });
      const plan = await createPlan(root, incomingManifest, blobs, baseLock);
      let captureWindow = false;
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        before(operation, path) {
          if (
            !captureWindow
            && operation === 'file-fsync'
            && path.includes(`${sep}staging${sep}`)
          ) {
            captureWindow = true;
            if (scenario === 'unsafe-symlink') {
              const replacementPath = join(root, 'replacement-lock.json');
              writeFileSync(replacementPath, originalLock);
              unlinkSync(lockPath);
              symlinkSync(replacementPath, lockPath);
              injected = true;
            }
          }
          if (
            scenario === 'read-fault'
            && captureWindow
            && !injected
            && operation === 'read'
            && basename(path) === PROJECT_TEMPLATE_LOCK_PATH
          ) {
            injected = true;
            throw new Error('injected formal lock read fault');
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

      expect(injected).toBe(true);
      expect(result).toMatchObject({
        status: 'not_started',
        code: 'BASE_LOCK_DRIFT',
      });
      expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8')).toBe(before);
      if (scenario === 'unsafe-symlink') {
        expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      } else {
        expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
      }
      expect(existsSync(join(root, '.takt-template-state', 'journal.json'))).toBe(false);
      expect(readdirSync(join(root, '.takt-template-state', 'staging'))).toEqual([]);
      expect(readdirSync(join(root, '.takt-template-state', 'backups'))).toEqual([]);
    },
  );

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

  it.each(['unknown', 'pruned', 'invalid'] as const)(
    'returns not_started without changing rollback journal or targets for an %s backup manifest',
    async (manifestState) => {
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
      if (applied.status !== 'committed') return;

      const journalPath = join(root, '.takt-template-state', 'journal.json');
      const journalBefore = readFileSync(journalPath, 'utf8');
      const backupRoot = join(
        root,
        '.takt-template-state',
        'backups',
        applied.backupId,
      );
      let backupId = applied.backupId;
      if (manifestState === 'unknown') {
        backupId = 'backup-does-not-exist';
      } else if (manifestState === 'pruned') {
        rmSync(backupRoot, { recursive: true });
      } else {
        writeFileSync(join(backupRoot, 'manifest.json'), '{invalid');
      }

      const result = await rollbackProjectTemplateApply({
        projectRoot: root,
        backupId,
      });

      expect(result).toMatchObject({
        status: 'not_started',
        code: 'BACKUP_UNAVAILABLE',
      });
      expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore);
      expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
        .toBe('language: ja\n');
      expect(existsSync(join(
        root,
        '.takt-template-state',
        'recovery-required.json',
      ))).toBe(false);
    },
  );

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

  it('compensates to an exact historical invalid config without creating recovery state', async () => {
    const root = makeRoot();
    writeTakt(root, 'config.yaml', 'language: [\n');
    const incomingManifest = manifest({ 'settings.yaml': 'enabled: true\n' });
    const blobs = incomingContents({ 'settings.yaml': 'enabled: true\n' });
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
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
      .toBe('language: [\n');
    expect(existsSync(join(root, '.takt', 'settings.yaml'))).toBe(false);
    expect(existsSync(join(root, PROJECT_TEMPLATE_LOCK_PATH))).toBe(false);
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'recovery-required.json',
    ))).toBe(false);
  });

  it('operator rollback accepts an exact historical invalid config witness', async () => {
    const root = makeRoot();
    const historical = 'language: [\n';
    writeTakt(root, 'config.yaml', historical);
    const baseManifest = manifest({ 'config.yaml': historical });
    const baseLock = baseLockFor(baseManifest);
    writeFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      `${JSON.stringify(baseLock)}\n`,
    );
    const incomingManifest = manifest({ 'config.yaml': 'language: ja\n' });
    const blobs = incomingContents({ 'config.yaml': 'language: ja\n' });
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);
    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });
    expect(applied.status).toBe('committed');

    const rollback = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: applied.status === 'committed' ? applied.backupId : '',
    });

    expect(rollback.status).toBe('rolled_back');
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
      .toBe(historical);
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'recovery-required.json',
    ))).toBe(false);
  });

  it('non-terminal recovery converges to an exact historical invalid config witness', async () => {
    const root = makeRoot();
    const historical = 'language: [\n';
    writeTakt(root, 'config.yaml', historical);
    const baseManifest = manifest({ 'config.yaml': historical });
    const baseLock = baseLockFor(baseManifest);
    writeFileSync(
      join(root, PROJECT_TEMPLATE_LOCK_PATH),
      `${JSON.stringify(baseLock)}\n`,
    );
    const incomingManifest = manifest({ 'config.yaml': 'language: ja\n' });
    const blobs = incomingContents({ 'config.yaml': 'language: ja\n' });
    const plan = await createPlan(root, incomingManifest, blobs, baseLock);
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
          && operation === 'rename'
          && path.endsWith('/.takt/config.yaml')
        ) {
          injected = true;
          throw new Error('injected historical restore fault');
        }
      },
    });
    const failedRollback = await rollbackProjectTemplateApply({
      projectRoot: root,
      backupId: applied.status === 'committed' ? applied.backupId : '',
      io,
    });
    expect(injected).toBe(true);
    expect(failedRollback.status).toBe('recovery_required');
    expect(JSON.parse(readFileSync(
      join(root, '.takt-template-state', 'journal.json'),
      'utf8',
    ))).toMatchObject({
      state: 'restore-failed',
      backupId: applied.status === 'committed' ? applied.backupId : '',
    });

    const recovered = await recoverProjectTemplateApply({ projectRoot: root });

    expect(recovered.status).toBe('rolled_back');
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
      .toBe(historical);
    expect(existsSync(join(
      root,
      '.takt-template-state',
      'recovery-required.json',
    ))).toBe(false);
  });

  it('accepts an exact committed journal without re-running doctor on unrelated later config', async () => {
    const root = makeRoot();
    const incomingManifest = manifest({ 'settings.yaml': 'enabled: true\n' });
    const blobs = incomingContents({ 'settings.yaml': 'enabled: true\n' });
    const plan = await createPlan(root, incomingManifest, blobs);
    const applied = await applyProjectTemplatePlan({
      projectRoot: root,
      plan,
      incomingManifest,
      incomingContents: blobs,
    });
    expect(applied.status).toBe('committed');
    // This unmanaged file appeared after commit. The committed journal already
    // proves that the post-apply doctor gate passed for the transaction.
    writeTakt(root, 'config.yaml', 'language: [\n');

    const recovered = await recoverProjectTemplateApply({ projectRoot: root });

    expect(recovered).toMatchObject({
      status: 'committed',
      backupId: applied.status === 'committed' ? applied.backupId : '',
    });
    expect(readFileSync(join(root, '.takt', 'config.yaml'), 'utf8'))
      .toBe('language: [\n');
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
