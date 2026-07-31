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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  issueTrustedProjectTemplateApplyPreviewApproval,
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
