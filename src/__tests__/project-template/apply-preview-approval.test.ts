import { createHash, type Hash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeProjectTemplateApplyPreviewApproval,
  isProjectTemplateApplyPreviewApprovalEvidence,
  issueTrustedProjectTemplateApplyPreviewApproval,
  revokeProjectTemplateApplyPreviewApproval,
} from '../../features/project-template/apply-preview-approval.js';
import {
  isProjectTemplateApplyApprovalEvidence,
} from '../../features/project-template/apply-approval.js';
import {
  createProjectTemplateApplyPlan,
} from '../../features/project-template/apply-plan.js';
import type {
  ProjectTemplateApplyPlanInput,
} from '../../features/project-template/apply-plan-types.js';
import {
  createProjectTemplateApplyPreview,
  renderProjectTemplateApplyPreviewJson,
} from '../../features/project-template/apply-preview.js';
import {
  consumeProjectTemplateApprovalRecord,
  createProjectTemplateApplyStorageIo,
  initializeProjectTemplateApplyStorage,
  type ProjectTemplateApplyStorageIo,
  type ProjectTemplateApplyStorageIoOperation,
} from '../../features/project-template/apply-storage.js';
import {
  calculateProjectTemplateManifestSha256,
} from '../../features/project-template/binding.js';
import {
  canonicalizeTaktpackJson,
} from '../../features/project-template/canonical-json.js';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  inspectProjectTemplateRepertoireDependencies,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  createProjectTemplateRepertoireDependencyPlan,
} from '../../features/project-template/repertoire-dependency-plan.js';

const roots: string[] = [];
const SOURCE_SHA = 'a'.repeat(64);
const source = {
  kind: 'local' as const,
  uri: '.',
  ref: 'workspace' as const,
  commit: 'a'.repeat(40),
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-preview-approval-'));
  roots.push(root);
  mkdirSync(join(root, '.takt'), { mode: 0o700 });
  return root;
}

function contentInput(options: {
  inspection?: boolean;
  compatibility?: 'compatible' | 'incompatible';
  local?: string;
  incoming?: string;
} = {}): ProjectTemplateApplyPlanInput {
  const path = 'workflows/test.yaml';
  const local = options.local ?? 'same';
  const incoming = options.incoming ?? 'same';
  const input: ProjectTemplateApplyPlanInput = {
    baseLock: {
      schemaVersion: '1.0',
      manifestSha256: 'b'.repeat(64),
      packVersion: '1.0.0',
      source,
      capabilities: [],
      entries: [{
        path,
        policy: 'managed',
        mode: '0644',
        sha256: sha256('same'),
        capabilities: [],
      }],
    },
    incomingManifest: {
      schemaVersion: '1.0',
      packVersion: '2.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      entries: [{
        path,
        policy: 'managed',
        mode: '0644',
        sha256: sha256(incoming),
      }],
    },
    localEntries: [{
      path,
      mode: '0644',
      sha256: sha256(local),
      bytes: Buffer.byteLength(local),
      content: Buffer.from(local),
      gitTrackingStatus: 'tracked-clean',
    }],
    targetRootState: 'directory',
    missingPathTracking: {},
    incomingContents: [{ path, content: Buffer.from(incoming) }],
  };
  if (options.inspection !== false) {
    input.incomingInspection = {
      archiveSha256: 'c'.repeat(64),
      manifestSha256: calculateProjectTemplateManifestSha256(
        input.incomingManifest,
      ),
      currentTaktVersion: '0.48.0',
      compatibilityStatus: options.compatibility ?? 'compatible',
    };
  }
  return input;
}

function dependencyPlan(manifestSha256: string) {
  const inspection = inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256,
      dependencies: [],
      deadlineMs: Number.MAX_SAFE_INTEGER,
    },
    port: {
      inspect: () => ({ witnessSha256: 'd'.repeat(64), observations: [] }),
    },
  });
  return createProjectTemplateRepertoireDependencyPlan({
    inspectionClaim:
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(inspection),
    incomingLock: {
      schemaVersion: '1.0',
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256,
      dependencies: [],
    },
    previousLock: { state: 'absent' },
  });
}

function preview(options: Parameters<typeof contentInput>[0] = {
  inspection: false,
}) {
  const contentPlan = createProjectTemplateApplyPlan(contentInput(options));
  return createProjectTemplateApplyPreview({
    contentPlan,
    repertoireDependencyPlan: dependencyPlan(
      contentPlan.incomingManifestSha256,
    ),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template apply preview approval issuance G6.1', () => {
  it('snapshots caller time before the first asynchronous boundary', async () => {
    const projectRoot = makeRepo();
    const original = new Date('2026-08-01T00:00:00.000Z');
    const baseIo = createProjectTemplateApplyStorageIo();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const io: ProjectTemplateApplyStorageIo = {
      ...baseIo,
      realpath: async (path) => {
        await gate;
        return await baseIo.realpath(path);
      },
    };

    const pending = issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: preview(),
      baselineStrategy: 'conflict',
      now: original,
      io,
    });
    original.setTime(Date.parse('2030-01-01T00:00:00.000Z'));
    release();
    const evidence = await pending;
    const record = JSON.parse(readFileSync(join(
      projectRoot,
      '.takt-template-state',
      'approvals',
      `${evidence.approvalId}.json`,
    ), 'utf8')) as Record<string, unknown>;
    expect(record['issuedAt']).toBe('2026-08-01T00:00:00.000Z');
    expect(record['expiresAt']).toBe('2026-08-01T00:05:00.000Z');
    expect(Date.parse(record['issuedAt'] as string))
      .toBeLessThan(Date.parse(record['expiresAt'] as string));
  });

  it('durably issues minimal process-local evidence bound to the exact review', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const now = new Date('2026-08-01T00:00:00.000Z');

    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'adopt-identical',
      now,
    });

    expect(Object.keys(evidence)).toEqual(['schemaVersion', 'approvalId']);
    expect(evidence).toEqual({
      schemaVersion: '1.0',
      approvalId: expect.stringMatching(/^approval-[a-f0-9-]{36}$/),
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(isProjectTemplateApplyApprovalEvidence(evidence)).toBe(false);
    const approvalRoot = join(projectRoot, '.takt-template-state', 'approvals');
    const approvalPath = join(approvalRoot, `${evidence.approvalId}.json`);
    const record = JSON.parse(readFileSync(approvalPath, 'utf8')) as Record<string, unknown>;
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    expect(record).toEqual({
      schemaVersion: '1.0',
      approvalId: evidence.approvalId,
      nonce: expect.stringMatching(/^[a-f0-9-]{36}$/),
      decision: 'approved',
      context: 'project-template-apply-preview-review',
      projectIdentity: sha256(canonicalizeTaktpackJson({
        repoRoot: realpathSync.native(projectRoot),
        device: storage.device,
        inode: storage.inode,
      })),
      previewId: value.previewId,
      contentPlanId: value.bindings.contentPlanId,
      contentPreconditionToken: value.bindings.contentPreconditionToken,
      repertoireDependencyPlanId: value.bindings.repertoireDependencyPlanId,
      repertoireDependencyPreconditionToken:
        value.bindings.repertoireDependencyPreconditionToken,
      baselineStrategy: 'adopt-identical',
      reviewSurfaceSha256: sha256(
        'takt.project-template.apply-preview-review.v1\0'
          + renderProjectTemplateApplyPreviewJson(value),
      ),
      issuedAt: now.toISOString(),
      expiresAt: '2026-08-01T00:05:00.000Z',
    });
    expect(lstatSync(approvalRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(approvalPath).mode & 0o777).toBe(0o600);
    const serializedEvidence = canonicalizeTaktpackJson(evidence);
    expect(serializedEvidence).not.toContain(String(record['nonce']));
    expect(serializedEvidence).not.toContain(value.bindings.contentPreconditionToken);
    expect(serializedEvidence).not.toContain(
      value.bindings.repertoireDependencyPreconditionToken,
    );
  });

  it('requires review without hard conflicts or default applicability', async () => {
    const projectRoot = makeRepo();
    const values = [
      preview({ inspection: true }),
      preview({ inspection: true, compatibility: 'incompatible' }),
    ];
    expect(values[0]).toMatchObject({
      reviewRequired: false, hardConflict: false, defaultApplyPossible: true,
    });
    expect(values[1]).toMatchObject({
      reviewRequired: true, hardConflict: true, defaultApplyPossible: false,
    });
    for (const value of values) {
      await expect(issueTrustedProjectTemplateApplyPreviewApproval({
        projectRoot,
        preview: value,
        baselineStrategy: 'conflict',
      })).rejects.toThrow();
    }
    expect(existsSync(join(
      projectRoot,
      '.takt-template-state',
      'approvals',
    ))).toBe(false);
  });

  it('rejects cloned and hostile previews before caller IO or hooks', async () => {
    const original = preview();
    const getter = vi.fn();
    const ioGet = vi.fn();
    const accessor = {};
    Object.defineProperty(accessor, 'previewId', { get: getter });
    const io = new Proxy({}, { get: ioGet });
    for (const value of [
      { ...original },
      new Proxy({}, { get: getter }),
      accessor,
      runInNewContext('({ schemaVersion: "1.0" })'),
    ]) {
      await expect(issueTrustedProjectTemplateApplyPreviewApproval({
        projectRoot: '/private/secret/repository',
        preview: value as never,
        baselineStrategy: 'conflict',
        io: io as never,
      })).rejects.toThrow('exact process-local sealed value');
    }
    expect(getter).not.toHaveBeenCalled();
    expect(ioGet).not.toHaveBeenCalled();
  });

  it('enforces exact baseline, time, and five-minute TTL types before IO', async () => {
    const value = preview();
    const ioGet = vi.fn();
    const io = new Proxy({}, { get: ioGet });
    const invalid = [
      { baselineStrategy: 'unknown' },
      { baselineStrategy: 'conflict', expiresInMs: 0 },
      { baselineStrategy: 'conflict', expiresInMs: 300_001 },
      { baselineStrategy: 'conflict', expiresInMs: 1.5 },
      { baselineStrategy: 'conflict', now: new Date(Number.NaN) },
    ];
    for (const extra of invalid) {
      await expect(issueTrustedProjectTemplateApplyPreviewApproval({
        projectRoot: '/private/secret/repository',
        preview: value,
        io: io as never,
        ...extra,
      } as never)).rejects.toThrow();
    }
    expect(ioGet).not.toHaveBeenCalled();
  });

  it('keeps the review digest deterministic while binding project identity', async () => {
    const value = preview();
    const firstRoot = makeRepo();
    const secondRoot = makeRepo();
    const firstEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: firstRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const secondEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: secondRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const readRecord = (root: string, approvalId: string) => JSON.parse(
      readFileSync(join(
        root,
        '.takt-template-state',
        'approvals',
        `${approvalId}.json`,
      ), 'utf8'),
    ) as Record<string, unknown>;
    const first = readRecord(firstRoot, firstEvidence.approvalId);
    const second = readRecord(secondRoot, secondEvidence.approvalId);
    expect(first['reviewSurfaceSha256']).toBe(second['reviewSurfaceSha256']);
    expect(first['projectIdentity']).not.toBe(second['projectIdentity']);
    expect(first['approvalId']).not.toBe(second['approvalId']);
    expect(first['nonce']).not.toBe(second['nonce']);
  });

  it('does not consult mutable serialization or hash hooks at issuance', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const stringify = JSON.stringify;
    const hashPrototype = Object.getPrototypeOf(createHash('sha256')) as Hash;
    const update = hashPrototype.update;
    const digest = hashPrototype.digest;
    let calls = 0;
    try {
      JSON.stringify = (() => {
        calls += 1;
        throw new Error('poisoned stringify');
      }) as typeof JSON.stringify;
      hashPrototype.update = (() => {
        calls += 1;
        throw new Error('poisoned update');
      }) as typeof hashPrototype.update;
      hashPrototype.digest = (() => {
        calls += 1;
        throw new Error('poisoned digest');
      }) as typeof hashPrototype.digest;
      await expect(issueTrustedProjectTemplateApplyPreviewApproval({
        projectRoot,
        preview: value,
        baselineStrategy: 'conflict',
      })).resolves.toMatchObject({ schemaVersion: '1.0' });
    } finally {
      JSON.stringify = stringify;
      hashPrototype.update = update;
      hashPrototype.digest = digest;
    }
    expect(calls).toBe(0);
  });

  it('does not publish evidence or leave a file when durable writing fails', async () => {
    const projectRoot = makeRepo();
    await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const io = createProjectTemplateApplyStorageIo({
      before: (operation, path) => {
        if (operation === 'write' && path.includes('/approvals/')) {
          throw new Error(`raw failure ${projectRoot} credential=secret`);
        }
      },
    });
    await expect(issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: preview(),
      baselineStrategy: 'conflict',
      io,
    })).rejects.toThrow(
      'project template apply preview approval issuance failed',
    );
    const approvalRoot = join(projectRoot, '.takt-template-state', 'approvals');
    expect(readdirSync(approvalRoot)).toEqual([]);
  });

  it.each([
    ['after write', 'write', 'after', 0],
    ['before rename', 'rename', 'before', 0],
    ['file fsync', 'file-fsync', 'after', 0],
    ['after rename', 'rename', 'after', 1],
    ['directory fsync', 'directory-fsync', 'before', 1],
  ] as const)(
    'burns authority without destructively cleaning final record after %s failure',
    async (_label, faultOperation, faultTiming, expectedRecords) => {
      const projectRoot = makeRepo();
      const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
      const value = preview();
      let injected = false;
      const io = createProjectTemplateApplyStorageIo({
        [faultTiming]: (
          operation: ProjectTemplateApplyStorageIoOperation,
          path: string,
        ) => {
          if (
            !injected
            && operation === faultOperation
            && (
              path.includes('/approvals/')
              || path.endsWith('/approvals')
            )
          ) {
            injected = true;
            throw new Error(`private injected failure token=${faultOperation}`);
          }
        },
      });
      await expect(issueTrustedProjectTemplateApplyPreviewApproval({
        projectRoot,
        preview: value,
        baselineStrategy: 'conflict',
        io,
      })).rejects.toThrow(
        'project template apply preview approval issuance failed',
      );
      expect(injected).toBe(true);
      expect(readdirSync(join(storage.controlRoot, 'approvals')))
        .toHaveLength(expectedRecords);
      const claims = readdirSync(join(storage.controlRoot, 'approval-claims'));
      expect(claims).toHaveLength(1);
      const claimText = readFileSync(join(
        storage.controlRoot,
        'approval-claims',
        claims[0]!,
      ), 'utf8');
      expect(JSON.parse(claimText)).toMatchObject({
        context: 'project-template-apply-preview-review',
        state: 'burned',
      });
      expect(claimText).not.toContain(projectRoot);
      expect(claimText).not.toContain(value.bindings.contentPreconditionToken);
      expect(claimText).not.toContain(
        value.bindings.repertoireDependencyPreconditionToken,
      );
      expect(claimText).not.toContain('nonce');
    },
  );

  it('burns the id without deleting a mismatched approval record', async () => {
    const projectRoot = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    let renameFailed = false;
    let approvalUnlinks = 0;
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (
          !renameFailed
          && operation === 'rename'
          && path.includes('/approvals/')
        ) {
          renameFailed = true;
          writeFileSync(path, '{"foreign":true}\n', { mode: 0o600 });
          throw new Error('injected post-rename uncertainty');
        }
      },
      before: (operation, path) => {
        if (
          operation === 'unlink'
          && path.includes('/approvals/')
          && path.endsWith('.json')
        ) {
          approvalUnlinks += 1;
        }
      },
    });
    await expect(issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: preview(),
      baselineStrategy: 'conflict',
      io,
    })).rejects.toThrow(
      'project template apply preview approval issuance failed',
    );
    const records = readdirSync(join(storage.controlRoot, 'approvals'));
    expect(records).toHaveLength(1);
    const approvalId = records[0]!.replace(/\.json$/, '');
    expect(readFileSync(join(
      storage.controlRoot,
      'approvals',
      records[0]!,
    ), 'utf8')).toBe('{"foreign":true}\n');
    expect(approvalUnlinks).toBe(0);
    const claimPath = join(
      storage.controlRoot,
      'approval-claims',
      `${approvalId}.json`,
    );
    expect(JSON.parse(readFileSync(claimPath, 'utf8'))).toEqual({
      schemaVersion: '1.0',
      approvalId,
      context: 'project-template-apply-preview-review',
      state: 'burned',
      burnedAt: expect.any(String),
    });
    expect(lstatSync(claimPath).mode & 0o777).toBe(0o600);
  });

  it('burns the id when a prepared approval temp cannot be removed', async () => {
    const projectRoot = makeRepo();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    let writeFailed = false;
    const io = createProjectTemplateApplyStorageIo({
      after: (operation, path) => {
        if (
          !writeFailed
          && operation === 'write'
          && path.includes('/approvals/')
        ) {
          writeFailed = true;
          throw new Error('injected prepared-record uncertainty');
        }
      },
      before: (operation, path) => {
        if (operation === 'unlink' && path.includes('/approvals/')) {
          throw new Error('injected prepared-record cleanup failure');
        }
      },
    });
    await expect(issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: preview(),
      baselineStrategy: 'conflict',
      io,
    })).rejects.toThrow(
      'project template apply preview approval issuance failed',
    );
    const [tempName] = readdirSync(join(storage.controlRoot, 'approvals'));
    expect(tempName).toMatch(/^\.approval-[a-f0-9-]{36}\.json\..+\.tmp$/);
    const approvalId = tempName!.slice(1, tempName!.indexOf('.json.'));
    expect(JSON.parse(readFileSync(join(
      storage.controlRoot,
      'approval-claims',
      `${approvalId}.json`,
    ), 'utf8'))).toMatchObject({
      approvalId,
      context: 'project-template-apply-preview-review',
      state: 'burned',
    });
  });

  it('supports repeated concurrent issuance against a fresh repository', async () => {
    const value = preview();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const projectRoot = makeRepo();
      const evidence = await Promise.all([
        issueTrustedProjectTemplateApplyPreviewApproval({
          projectRoot,
          preview: value,
          baselineStrategy: 'conflict',
        }),
        issueTrustedProjectTemplateApplyPreviewApproval({
          projectRoot,
          preview: value,
          baselineStrategy: 'conflict',
        }),
      ]);
      expect(evidence[0].approvalId).not.toBe(evidence[1].approvalId);
      const records = readdirSync(join(
        projectRoot,
        '.takt-template-state',
        'approvals',
      )).filter((name) => name.endsWith('.json'));
      expect(records).toHaveLength(2);
    }
  });
});

describe('project template revocable preview approval authority G6.2', () => {
  it('consumes once and durably records a token-free disposition claim', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const recordPath = join(
      storage.controlRoot,
      'approvals',
      `${evidence.approvalId}.json`,
    );
    const issuedRecord = readFileSync(recordPath);

    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(true);
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence,
    })).resolves.toBe(true);
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(false);
    writeFileSync(recordPath, issuedRecord, { mode: 0o600 });
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence,
    })).resolves.toBe(false);
    await expect(revokeProjectTemplateApplyPreviewApproval({
      storage,
      evidence,
    })).resolves.toBe(false);
    const claim = readFileSync(join(
      storage.controlRoot,
      'approval-claims',
      `${evidence.approvalId}.json`,
    ), 'utf8');
    expect(JSON.parse(claim)).toEqual({
      schemaVersion: '1.0',
      approvalId: evidence.approvalId,
      nonce: expect.stringMatching(/^[a-f0-9-]{36}$/),
      context: 'project-template-apply-preview-review',
      projectIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      disposition: 'consumed',
      previewId: value.previewId,
      contentPlanId: value.bindings.contentPlanId,
      repertoireDependencyPlanId: value.bindings.repertoireDependencyPlanId,
      claimedAt: expect.any(String),
    });
    expect(claim).not.toContain('preconditionToken');
  });

  it('revokes an active authority even when its approval record is missing', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    unlinkSync(join(
      storage.controlRoot,
      'approvals',
      `${evidence.approvalId}.json`,
    ));

    await expect(revokeProjectTemplateApplyPreviewApproval({
      storage,
      evidence,
    })).resolves.toBe(true);
    const claim = JSON.parse(readFileSync(join(
      storage.controlRoot,
      'approval-claims',
      `${evidence.approvalId}.json`,
    ), 'utf8')) as Record<string, unknown>;
    expect(claim).toEqual({
      schemaVersion: '1.0',
      approvalId: evidence.approvalId,
      nonce: expect.stringMatching(/^[a-f0-9-]{36}$/),
      context: 'project-template-apply-preview-review',
      projectIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      previewId: value.previewId,
      contentPlanId: value.bindings.contentPlanId,
      repertoireDependencyPlanId: value.bindings.repertoireDependencyPlanId,
      disposition: 'revoked',
      claimedAt: expect.any(String),
    });
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(false);
  });

  it('accepts a fresh process-local preview with identical sealed bindings', async () => {
    const projectRoot = makeRepo();
    const issuedPreview = preview();
    const freshPreview = preview();
    expect(freshPreview).not.toBe(issuedPreview);
    expect(freshPreview.previewId).toBe(issuedPreview.previewId);
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: issuedPreview,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });

    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: freshPreview,
      baselineStrategy: 'conflict',
      evidence,
    })).resolves.toBe(true);
  });

  it('rejects cloned and hostile evidence without invoking its hooks', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const get = vi.fn();
    const accessor = {};
    Object.defineProperty(accessor, 'approvalId', { get });
    for (const forged of [
      { ...evidence },
      new Proxy({}, { get }),
      accessor,
      runInNewContext('({ schemaVersion: "1.0", approvalId: "approval-x" })'),
    ]) {
      expect(isProjectTemplateApplyPreviewApprovalEvidence(forged)).toBe(false);
      await expect(consumeProjectTemplateApplyPreviewApproval({
        storage,
        preview: value,
        baselineStrategy: 'conflict',
        evidence: forged,
      })).resolves.toBe(false);
      await expect(revokeProjectTemplateApplyPreviewApproval({
        storage,
        evidence: forged,
      })).resolves.toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(true);
  });

  it('requires preview membership before reservation without invoking hooks', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const get = vi.fn();
    const accessor = {};
    Object.defineProperty(accessor, 'previewId', { get });
    for (const forged of [
      { ...value },
      new Proxy({}, { get }),
      accessor,
      runInNewContext('({ schemaVersion: "1.0" })'),
    ]) {
      await expect(consumeProjectTemplateApplyPreviewApproval({
        storage,
        preview: forged,
        baselineStrategy: 'conflict',
        evidence,
      })).resolves.toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(true);
    await expect(revokeProjectTemplateApplyPreviewApproval({
      storage,
      evidence,
    })).resolves.toBe(true);
  });

  it('rejects non-exact operation DTOs without invoking accessors', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const get = vi.fn();
    const accessor = { preview: value, baselineStrategy: 'conflict', evidence };
    Object.defineProperty(accessor, 'storage', { enumerable: true, get });
    for (const options of [
      accessor,
      new Proxy({}, { get }),
      runInNewContext('({ storage: {}, evidence: {} })'),
      { storage, preview: value, baselineStrategy: 'conflict', evidence, extra: true },
      { storage, preview: value, baselineStrategy: 'conflict', evidence, now: null },
    ]) {
      await expect(consumeProjectTemplateApplyPreviewApproval(options))
        .resolves.toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(true);
    await expect(revokeProjectTemplateApplyPreviewApproval({ storage, evidence }))
      .resolves.toBe(true);
  });

  it.each([
    ['schemaVersion', '2.0'],
    ['approvalId', 'approval-foreign'],
    ['nonce', '00000000-0000-0000-0000-000000000000'],
    ['nonce', undefined],
    ['decision', 'rejected'],
    ['context', 'project-template-apply-review'],
    ['projectIdentity', 'f'.repeat(64)],
    ['previewId', 'f'.repeat(64)],
    ['contentPlanId', 'f'.repeat(64)],
    ['contentPreconditionToken', 'f'.repeat(64)],
    ['repertoireDependencyPlanId', 'f'.repeat(64)],
    ['repertoireDependencyPreconditionToken', 'f'.repeat(64)],
    ['baselineStrategy', 'adopt-identical'],
    ['reviewSurfaceSha256', 'f'.repeat(64)],
    ['issuedAt', 'not-a-time'],
    ['expiresAt', '2026-08-01T00:00:00.000Z'],
    ['extraField', 'unexpected'],
  ] as const)('rejects a record with tampered %s', async (field, replacement) => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const recordPath = join(
      storage.controlRoot,
      'approvals',
      `${evidence.approvalId}.json`,
    );
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    record[field] = replacement;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence,
      now: new Date('2026-08-01T00:01:00.000Z'),
    })).resolves.toBe(false);
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(false);
  });

  it('rejects exact expiry boundary, cross-project use, and another preview', async () => {
    const issuedAt = new Date('2026-08-01T00:00:00.000Z');
    const value = preview();

    const expiryRoot = makeRepo();
    const expired = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: expiryRoot,
      preview: value,
      baselineStrategy: 'conflict',
      now: issuedAt,
    });
    const expiryStorage = await initializeProjectTemplateApplyStorage({ repoPath: expiryRoot });
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage: expiryStorage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence: expired,
      now: new Date('2026-08-01T00:05:00.000Z'),
    })).resolves.toBe(false);

    const sourceRoot = makeRepo();
    const crossProject = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: sourceRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const otherStorage = await initializeProjectTemplateApplyStorage({ repoPath: makeRepo() });
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage: otherStorage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence: crossProject,
    })).resolves.toBe(false);

    const mismatchRoot = makeRepo();
    const mismatched = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: mismatchRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const mismatchStorage = await initializeProjectTemplateApplyStorage({ repoPath: mismatchRoot });
    const otherPreview = preview({
      inspection: false,
      local: 'same',
      incoming: 'next',
    });
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage: mismatchStorage,
      preview: otherPreview,
      baselineStrategy: 'conflict',
      evidence: mismatched,
    })).resolves.toBe(false);
  });

  it('reserves authority synchronously across consume and revoke races', async () => {
    const value = preview();
    const consumeRoot = makeRepo();
    const consumeEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: consumeRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const consumeStorage = await initializeProjectTemplateApplyStorage({ repoPath: consumeRoot });
    const doubleConsume = await Promise.all([
      consumeProjectTemplateApplyPreviewApproval({
        storage: consumeStorage,
        preview: value,
        baselineStrategy: 'conflict',
        evidence: consumeEvidence,
      }),
      consumeProjectTemplateApplyPreviewApproval({
        storage: consumeStorage,
        preview: value,
        baselineStrategy: 'conflict',
        evidence: consumeEvidence,
      }),
    ]);
    expect(doubleConsume.filter(Boolean)).toHaveLength(1);

    const raceRoot = makeRepo();
    const raceEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot: raceRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const raceStorage = await initializeProjectTemplateApplyStorage({ repoPath: raceRoot });
    const consumeRevoke = await Promise.all([
      consumeProjectTemplateApplyPreviewApproval({
        storage: raceStorage,
        preview: value,
        baselineStrategy: 'conflict',
        evidence: raceEvidence,
      }),
      revokeProjectTemplateApplyPreviewApproval({
        storage: raceStorage,
        evidence: raceEvidence,
      }),
    ]);
    expect(consumeRevoke.filter(Boolean)).toHaveLength(1);
  });

  it('checks a preexisting burn claim before reading the approval record', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    await consumeProjectTemplateApprovalRecord({
      storage,
      approvalId: evidence.approvalId,
      claim: {
        schemaVersion: '1.0',
        approvalId: evidence.approvalId,
        context: 'project-template-apply-preview-review',
        state: 'burned',
        burnedAt: new Date().toISOString(),
      },
    });
    let approvalReads = 0;
    const io = createProjectTemplateApplyStorageIo({
      before: (operation, path) => {
        if (operation === 'read' && path.includes('/approvals/')) {
          approvalReads += 1;
          throw new Error('approval record must not be read after burn');
        }
      },
    });
    const checkedStorage = { ...storage, io };
    writeFileSync(join(
      storage.controlRoot,
      'approvals',
      `${evidence.approvalId}.json`,
    ), 'not-json', { mode: 0o600 });

    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage: checkedStorage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence,
    })).resolves.toBe(false);
    expect(approvalReads).toBe(0);
  });

  it.each([
    ['write', 'after'],
    ['chmod', 'before'],
    ['file-fsync', 'before'],
    ['directory-fsync', 'before'],
  ] as const)('never retries authority after claim %s uncertainty', async (
    faultOperation,
    faultTiming,
  ) => {
    const projectRoot = makeRepo();
    const value = preview();
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    let injected = false;
    const io = createProjectTemplateApplyStorageIo({
      [faultTiming]: (
        operation: ProjectTemplateApplyStorageIoOperation,
        path: string,
      ) => {
        if (
          !injected
          && operation === faultOperation
          && (
            path.includes('/approval-claims/')
            || path.endsWith('/approval-claims')
          )
        ) {
          injected = true;
          throw new Error(`private claim fault ${projectRoot} token=secret`);
        }
      },
    });
    const faultStorage = { ...storage, io };
    await expect(consumeProjectTemplateApplyPreviewApproval({
      storage: faultStorage,
      preview: value,
      baselineStrategy: 'conflict',
      evidence,
    })).resolves.toBe(false);
    expect(injected).toBe(true);
    await expect(revokeProjectTemplateApplyPreviewApproval({
      storage,
      evidence,
    })).resolves.toBe(false);
    expect(isProjectTemplateApplyPreviewApprovalEvidence(evidence)).toBe(false);
  });

  it('snapshots consume time before awaiting claim storage', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const issuedAt = new Date('2026-08-01T00:00:00.000Z');
    const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
      now: issuedAt,
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const baseIo = storage.io;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedIo: ProjectTemplateApplyStorageIo = {
      ...baseIo,
      lstat: async (path) => {
        if (
          path.includes('/approval-claims/')
          && path.endsWith(`${evidence.approvalId}.json`)
        ) await gate;
        return await baseIo.lstat(path);
      },
    };
    const now = new Date('2026-08-01T00:01:00.000Z');
    const pending = consumeProjectTemplateApplyPreviewApproval({
      storage: { ...storage, io: gatedIo },
      preview: value,
      baselineStrategy: 'conflict',
      evidence,
      now,
    });
    now.setTime(Date.parse('2026-08-01T00:06:00.000Z'));
    release();
    await expect(pending).resolves.toBe(true);
  });

  it('fails closed without invoking mutable Promise.resolve', async () => {
    const originalResolve = Promise.resolve;
    let poisonHooks = 0;
    Object.defineProperty(Promise, 'resolve', {
      configurable: true,
      writable: true,
      value: () => {
        poisonHooks += 1;
        return originalResolve.call(Promise, true);
      },
    });
    let invalidConsume: boolean;
    let forgedConsume: boolean;
    let invalidRevoke: boolean;
    let forgedRevoke: boolean;
    try {
      invalidConsume = await consumeProjectTemplateApplyPreviewApproval({});
      forgedConsume = await consumeProjectTemplateApplyPreviewApproval({
        storage: {},
        preview: {},
        baselineStrategy: 'conflict',
        evidence: {},
      });
      invalidRevoke = await revokeProjectTemplateApplyPreviewApproval({});
      forgedRevoke = await revokeProjectTemplateApplyPreviewApproval({
        storage: {},
        evidence: {},
      });
    } finally {
      Object.defineProperty(Promise, 'resolve', {
        configurable: true,
        writable: true,
        value: originalResolve,
      });
    }
    expect({ invalidConsume, forgedConsume, invalidRevoke, forgedRevoke })
      .toEqual({
        invalidConsume: false,
        forgedConsume: false,
        invalidRevoke: false,
        forgedRevoke: false,
      });
    expect(poisonHooks).toBe(0);
  });

  it('decodes and parses durable records without mutable Buffer or JSON hooks', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const tamperedEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const regularEvidence = await issueTrustedProjectTemplateApplyPreviewApproval({
      projectRoot,
      preview: value,
      baselineStrategy: 'conflict',
    });
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const approvalPath = (approvalId: string) => join(
      storage.controlRoot,
      'approvals',
      `${approvalId}.json`,
    );
    const tamperedOriginal = JSON.parse(readFileSync(
      approvalPath(tamperedEvidence.approvalId),
      'utf8',
    )) as unknown;
    const regularOriginal = JSON.parse(readFileSync(
      approvalPath(regularEvidence.approvalId),
      'utf8',
    )) as unknown;
    writeFileSync(
      approvalPath(tamperedEvidence.approvalId),
      '{"tampered":true}\n',
      { mode: 0o600 },
    );
    const originalParse = JSON.parse;
    const originalToString = Buffer.prototype.toString;
    let parseHooks = 0;
    let bufferHooks = 0;
    Object.defineProperty(JSON, 'parse', {
      configurable: true,
      writable: true,
      value: (text: string) => {
        parseHooks += 1;
        return text.includes('tampered') ? tamperedOriginal : regularOriginal;
      },
    });
    Object.defineProperty(Buffer.prototype, 'toString', {
      configurable: true,
      writable: true,
      value(this: Buffer, encoding?: BufferEncoding) {
        bufferHooks += 1;
        const actual = originalToString.call(this, encoding);
        return actual.includes('tampered')
          ? JSON.stringify(tamperedOriginal)
          : JSON.stringify(regularOriginal);
      },
    });
    let tampered: boolean;
    let regular: boolean;
    try {
      tampered = await consumeProjectTemplateApplyPreviewApproval({
        storage,
        preview: value,
        baselineStrategy: 'conflict',
        evidence: tamperedEvidence,
      });
      regular = await consumeProjectTemplateApplyPreviewApproval({
        storage,
        preview: value,
        baselineStrategy: 'conflict',
        evidence: regularEvidence,
      });
    } finally {
      Object.defineProperty(JSON, 'parse', {
        configurable: true,
        writable: true,
        value: originalParse,
      });
      Object.defineProperty(Buffer.prototype, 'toString', {
        configurable: true,
        writable: true,
        value: originalToString,
      });
    }

    expect({ tampered, regular }).toEqual({ tampered: false, regular: true });
    expect({ parseHooks, bufferHooks }).toEqual({ parseHooks: 0, bufferHooks: 0 });
  });

  it('validates every durable record field before object coercion', async () => {
    const projectRoot = makeRepo();
    const value = preview();
    const storage = await initializeProjectTemplateApplyStorage({ repoPath: projectRoot });
    const fields = [
      'schemaVersion', 'approvalId', 'nonce', 'decision', 'context',
      'projectIdentity', 'previewId', 'contentPlanId',
      'contentPreconditionToken', 'repertoireDependencyPlanId',
      'repertoireDependencyPreconditionToken', 'baselineStrategy',
      'reviewSurfaceSha256', 'issuedAt', 'expiresAt',
    ] as const;
    const fixtures = [];
    for (const field of fields) {
      const evidence = await issueTrustedProjectTemplateApplyPreviewApproval({
        projectRoot,
        preview: value,
        baselineStrategy: 'conflict',
      });
      const path = join(
        storage.controlRoot,
        'approvals',
        `${evidence.approvalId}.json`,
      );
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      record[field] = {};
      writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      fixtures.push(evidence);
    }
    let coercionHooks = 0;
    Object.defineProperty(Object.prototype, Symbol.toPrimitive, {
      configurable: true,
      value: () => {
        coercionHooks += 1;
        return '2026-08-01T00:00:00.000Z';
      },
    });
    let results: boolean[];
    try {
      results = [];
      for (const evidence of fixtures) {
        results.push(await consumeProjectTemplateApplyPreviewApproval({
          storage,
          preview: value,
          baselineStrategy: 'conflict',
          evidence,
        }));
      }
    } finally {
      delete Object.prototype[Symbol.toPrimitive];
    }
    expect(results).toEqual(fields.map(() => false));
    expect(coercionHooks).toBe(0);
  });
});
