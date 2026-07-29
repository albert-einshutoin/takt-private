import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  calculateProjectTemplateManifestSha256,
  createProjectTemplateApplyPlan,
  type ProjectTemplateApplyPlanInput,
  type ProjectTemplateLocalSnapshotEntry,
  type TemplateEntryPolicy,
} from '../../features/project-template/index.js';

const source = {
  kind: 'local' as const,
  uri: '.',
  ref: 'workspace' as const,
  commit: 'a'.repeat(40),
};

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifestEntry(
  path: string,
  content: string,
  policy: TemplateEntryPolicy = 'managed',
) {
  return {
    path,
    policy,
    mode: '0644',
    sha256: hash(content),
  };
}

function input(
  {
    base,
    local,
    incoming,
    policy = 'managed',
  }: {
    base?: string;
    local?: string;
    incoming?: string;
    policy?: TemplateEntryPolicy;
  },
): ProjectTemplateApplyPlanInput {
  const path = 'config.yaml';
  const incomingEntries = incoming === undefined
    ? []
    : [manifestEntry(path, incoming, policy)];
  const baseEntries = base === undefined
    ? []
    : [{
        ...manifestEntry(path, base, policy),
        capabilities: [],
      }];
  const localEntries: ProjectTemplateLocalSnapshotEntry[] = local === undefined
    ? []
    : [{
        path,
        mode: '0644',
        sha256: hash(local),
        bytes: Buffer.byteLength(local),
        content: Buffer.from(local),
        gitTrackingStatus: 'tracked-clean',
      }];
  const planInput: ProjectTemplateApplyPlanInput = {
    baseLock: {
      schemaVersion: '1.0',
      manifestSha256: 'b'.repeat(64),
      packVersion: '1.0.0',
      source,
      capabilities: [],
      entries: baseEntries,
    },
    incomingManifest: {
      schemaVersion: '1.0',
      packVersion: '2.0.0',
      takt: { minVersion: '0.48.0' },
      source,
      entries: incomingEntries,
    },
    localEntries,
    targetRootState: 'directory',
    missingPathTracking: local === undefined && (base !== undefined || incoming !== undefined)
      ? { [path]: 'not-repository' }
      : {},
    incomingContents: incoming === undefined
      ? []
      : [{ path, content: Buffer.from(incoming) }],
  };
  planInput.incomingInspection = {
    archiveSha256: 'd'.repeat(64),
    manifestSha256: calculateProjectTemplateManifestSha256(planInput.incomingManifest),
    currentTaktVersion: '0.48.0',
    compatibilityStatus: 'compatible',
  };
  return planInput;
}

describe('project template three-way apply plan', () => {
  it.each([
    ['unchanged / changed', 'base', 'base', 'next', 'update', 'UPSTREAM_CHANGED'],
    ['changed / unchanged', 'base', 'local', 'base', 'keep', 'LOCAL_CHANGED'],
    ['both changed', 'base', 'local', 'next', 'conflict', 'BOTH_CHANGED'],
    ['both changed identically', 'base', 'next', 'next', 'keep', 'ALREADY_CURRENT'],
    ['all unchanged', 'base', 'base', 'base', 'keep', 'UNCHANGED'],
    ['new missing destination', undefined, undefined, 'next', 'add', 'NEW_ENTRY'],
    ['new occupied destination', undefined, 'local', 'next', 'conflict', 'DESTINATION_EXISTS'],
  ] as const)(
    'plans managed %s deterministically',
    (_label, base, local, incoming, action, reasonCode) => {
      const plan = createProjectTemplateApplyPlan(input({ base, local, incoming }));

      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0]).toMatchObject({
        path: 'config.yaml',
        policy: 'managed',
        action,
        reasonCode,
      });
      expect(plan.defaultApplyPossible).toBe(action !== 'conflict');
      expect(plan.planId).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.preconditionToken).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it.each([
    ['unchanged local', 'base', 'delete', 'LOCAL_UNCHANGED_TEMPLATE_DELETED'],
    ['changed local', 'local', 'conflict', 'LOCAL_CHANGED_TEMPLATE_DELETED'],
    ['already absent', undefined, 'keep', 'ALREADY_ABSENT'],
  ] as const)(
    'handles a managed upstream deletion with %s',
    (_label, local, action, reasonCode) => {
      const plan = createProjectTemplateApplyPlan(input({
        base: 'base',
        local,
        incoming: undefined,
      }));

      expect(plan.entries[0]).toMatchObject({ action, reasonCode });
    },
  );

  it('routes divergent merge-policy changes to semantic merge without mutating the target', () => {
    const planInput = input({
      base: 'base',
      local: 'local',
      incoming: 'next',
      policy: 'merge',
    });
    const before = planInput.localEntries.map((entry) => ({
      ...entry,
      ...(entry.content === undefined ? {} : { content: Buffer.from(entry.content) }),
    }));

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries[0]).toMatchObject({
      policy: 'merge',
      action: 'conflict',
      reasonCode: 'SEMANTIC_MERGE_REQUIRED',
    });
    expect(planInput.localEntries).toEqual(before);
  });

  it.each([
    [undefined, 'add', 'SCAFFOLD_MISSING'],
    ['local', 'keep', 'SCAFFOLD_PRESERVED'],
  ] as const)('limits scaffold to create-when-missing for local=%s', (local, action, reasonCode) => {
    const plan = createProjectTemplateApplyPlan(input({
      base: 'base',
      local,
      incoming: 'next',
      policy: 'scaffold',
    }));

    expect(plan.entries[0]).toMatchObject({
      policy: 'scaffold',
      action,
      reasonCode,
    });
    expect(plan.entries[0]?.action).not.toBe('update');
    expect(plan.entries[0]?.action).not.toBe('delete');
  });

  it('never copies an excluded manifest entry', () => {
    const plan = createProjectTemplateApplyPlan(input({
      incoming: 'private',
      policy: 'excluded',
    }));

    expect(plan.entries[0]).toMatchObject({
      policy: 'excluded',
      action: 'excluded',
      reasonCode: 'POLICY_EXCLUDED',
    });
  });

  it('fails closed for a legacy occupied target unless an identical baseline is explicitly adopted', () => {
    const legacy = input({ local: 'local', incoming: 'next' });
    delete (legacy as { baseLock?: unknown }).baseLock;

    const conflict = createProjectTemplateApplyPlan(legacy);
    const adopted = createProjectTemplateApplyPlan({
      ...legacy,
      localEntries: [{
        ...legacy.localEntries[0]!,
        sha256: hash('next'),
        bytes: 4,
        content: Buffer.from('next'),
      }],
      baselineStrategy: 'adopt-identical',
    });

    expect(conflict.entries[0]).toMatchObject({
      action: 'conflict',
      reasonCode: 'LEGACY_BASELINE_REQUIRED',
    });
    expect(adopted.entries[0]).toMatchObject({
      action: 'keep',
      reasonCode: 'BASELINE_ADOPTED',
    });
  });

  it.each([
    ['content rename', 'old.yaml', 'new.yaml'],
    ['case-only rename', 'Config.yaml', 'config.yaml'],
  ])('marks a %s as conflict', (_label, oldPath, newPath) => {
    const baseContent = 'same';
    const plan = createProjectTemplateApplyPlan({
      ...input({}),
      baseLock: {
        schemaVersion: '1.0',
        manifestSha256: 'b'.repeat(64),
        packVersion: '1.0.0',
        source,
        capabilities: [],
        entries: [{
          ...manifestEntry(oldPath, baseContent),
          capabilities: [],
        }],
      },
      incomingManifest: {
        schemaVersion: '1.0',
        packVersion: '2.0.0',
        takt: { minVersion: '0.48.0' },
        source,
        entries: [manifestEntry(newPath, baseContent)],
      },
      localEntries: [{
        path: oldPath,
        mode: '0644',
        sha256: hash(baseContent),
        bytes: 4,
        content: Buffer.from(baseContent),
        gitTrackingStatus: 'tracked-clean',
      }],
      incomingContents: [{ path: newPath, content: Buffer.from(baseContent) }],
    });

    expect(plan.defaultApplyPossible).toBe(false);
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: oldPath, action: 'conflict' }),
      expect.objectContaining({ path: newPath, action: 'conflict' }),
    ]));
    for (const entry of plan.entries) {
      expect(entry).not.toHaveProperty('afterSha256');
      expect(entry).not.toHaveProperty('afterMode');
    }
  });

  it('produces stable JSON/human summaries and a bounded text diff', () => {
    const planInput = input({ base: 'old\n', local: 'old\n', incoming: 'new\n' });

    const first = createProjectTemplateApplyPlan(planInput);
    const second = createProjectTemplateApplyPlan(structuredClone(planInput));

    expect(second).toEqual(first);
    expect(first.summary.counts.update).toBe(1);
    expect(first.summary.human).toContain('更新 1');
    expect(first.entries[0]?.diff).toMatchObject({
      kind: 'text',
      truncated: false,
    });
    expect(first.entries[0]?.diff?.text).toContain('-old');
    expect(first.entries[0]?.diff?.text).toContain('+new');
  });

  it.each([
    ['binary', Buffer.from([0, 1, 2]), 'binary'],
    ['large', Buffer.alloc(70 * 1024, 0x61), 'too-large'],
  ] as const)('does not emit a %s file body diff', (_label, content, kind) => {
    const planInput = input({ base: 'old', local: 'old', incoming: 'next' });
    planInput.incomingContents = [{ path: 'config.yaml', content }];
    planInput.incomingManifest.entries[0]!.sha256 =
      createHash('sha256').update(content).digest('hex');

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries[0]?.diff).toMatchObject({ kind });
    expect(plan.entries[0]?.diff).not.toHaveProperty('text');
  });

  it('changes the precondition token when the local hash, mode, or Git status changes', () => {
    const original = input({ base: 'base', local: 'base', incoming: 'next' });
    const first = createProjectTemplateApplyPlan(original);
    const variants = [
      {
        ...original.localEntries[0]!,
        sha256: hash('changed'),
        bytes: 7,
        content: Buffer.from('changed'),
      },
      { ...original.localEntries[0]!, mode: '0755' },
      { ...original.localEntries[0]!, gitTrackingStatus: 'tracked-modified' as const },
    ];

    for (const localEntry of variants) {
      const changed = createProjectTemplateApplyPlan({
        ...original,
        localEntries: [localEntry],
      });
      expect(changed.preconditionToken).not.toBe(first.preconditionToken);
    }
  });

  it('binds root and tracked-deletion evidence into the precondition', () => {
    const planInput = input({ base: 'base', incoming: 'next' });
    const directory = createProjectTemplateApplyPlan({
      ...planInput,
      targetRootState: 'directory',
      missingPathTracking: { 'config.yaml': 'untracked' },
    });
    const stagedDeletion = createProjectTemplateApplyPlan({
      ...planInput,
      targetRootState: 'directory',
      missingPathTracking: { 'config.yaml': 'staged' },
    });
    const missingRoot = createProjectTemplateApplyPlan({
      ...planInput,
      targetRootState: 'missing',
      missingPathTracking: { 'config.yaml': 'not-repository' },
    });

    expect(stagedDeletion.preconditionToken).not.toBe(directory.preconditionToken);
    expect(stagedDeletion.reviewRequired).toBe(true);
    expect(stagedDeletion.defaultApplyPossible).toBe(false);
    expect(stagedDeletion.entries[0]?.gitTrackingStatus).toBe('staged');
    expect(missingRoot.preconditionToken).not.toBe(directory.preconditionToken);
  });

  it('rejects an impossible missing-root snapshot with present entries', () => {
    const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
    planInput.targetRootState = 'missing';

    expect(() => createProjectTemplateApplyPlan(planInput)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ENTRY',
        field: 'localEntries',
      }),
    );
  });

  it('preserves prototype-shaped missing paths in review and precondition evidence', () => {
    const planInput = input({});
    planInput.incomingManifest.entries = [manifestEntry('__proto__', 'next')];
    planInput.incomingContents = [{
      path: '__proto__',
      content: Buffer.from('next'),
    }];
    const untracked = createProjectTemplateApplyPlan({
      ...planInput,
      missingPathTracking: JSON.parse('{"__proto__":"untracked"}') as Record<string, 'untracked'>,
    });
    const staged = createProjectTemplateApplyPlan({
      ...planInput,
      missingPathTracking: JSON.parse('{"__proto__":"staged"}') as Record<string, 'staged'>,
    });

    expect(staged.preconditionToken).not.toBe(untracked.preconditionToken);
    expect(staged.reviewRequired).toBe(true);
    expect(staged.defaultApplyPossible).toBe(false);
  });

  it('fails closed for file/directory prefix collisions', () => {
    const planInput = input({ incoming: 'file' });
    planInput.incomingManifest.entries = [
      manifestEntry('a', 'file'),
      manifestEntry('a-b', 'sibling'),
      manifestEntry('a/child.yaml', 'child'),
    ];
    planInput.incomingContents = [
      { path: 'a', content: Buffer.from('file') },
      { path: 'a-b', content: Buffer.from('sibling') },
      { path: 'a/child.yaml', content: Buffer.from('child') },
    ];
    planInput.missingPathTracking = {
      a: 'not-repository',
      'a-b': 'not-repository',
      'a/child.yaml': 'not-repository',
    };

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.defaultApplyPossible).toBe(false);
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'a',
        action: 'conflict',
        reasonCode: 'DESTINATION_PATH_COLLISION',
      }),
      expect.objectContaining({
        path: 'a/child.yaml',
        action: 'conflict',
        reasonCode: 'DESTINATION_PATH_COLLISION',
      }),
      expect.objectContaining({ path: 'a-b', action: 'add' }),
    ]));
  });

  it('marks N:1 content rename candidates as ambiguous', () => {
    const planInput = input({});
    planInput.baseLock!.entries = [
      { ...manifestEntry('old-a.yaml', 'same'), capabilities: [] },
      { ...manifestEntry('old-b.yaml', 'same'), capabilities: [] },
    ];
    planInput.incomingManifest.entries = [manifestEntry('new.yaml', 'same')];
    planInput.localEntries = planInput.baseLock!.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      sha256: entry.sha256,
      bytes: 4,
      content: Buffer.from('same'),
      gitTrackingStatus: 'tracked-clean',
    }));
    planInput.incomingContents = [{ path: 'new.yaml', content: Buffer.from('same') }];

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.every(
      (entry) => entry.action === 'conflict' && entry.reasonCode === 'AMBIGUOUS_RENAME',
    )).toBe(true);
  });

  it('requires review and disables default apply when capabilities are added', () => {
    const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
    planInput.incomingManifest.capabilities = ['external-command'];
    planInput.incomingManifest.entries[0]!.capabilities = ['external-command'];

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.reviewRequired).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
    expect(plan.entries[0]).toMatchObject({
      action: 'update',
      reviewRequired: true,
      capabilitiesBefore: [],
      capabilitiesAfter: ['external-command'],
    });
  });

  it('requires review for a top-level-only capability escalation', () => {
    const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
    planInput.incomingManifest.capabilities = ['external-command'];

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.capabilitiesBefore).toEqual([]);
    expect(plan.capabilitiesAfter).toEqual(['external-command']);
    expect(plan.reviewRequired).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it.each([
    ['scaffold', 'SCAFFOLD_PRESERVED'],
    ['excluded', 'POLICY_EXCLUDED'],
  ] as const)(
    'treats managed to %s policy changes as conflicts before policy behavior',
    (policy, _oldReason) => {
      const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
      planInput.incomingManifest.entries[0]!.policy = policy;

      const plan = createProjectTemplateApplyPlan(planInput);

      expect(plan.entries[0]).toMatchObject({
        action: 'conflict',
        reasonCode: 'POLICY_CHANGED',
      });
      expect(plan.defaultApplyPossible).toBe(false);
    },
  );

  it.each([
    ['present', 'base'],
    ['changed', 'local'],
    ['absent', undefined],
  ] as const)(
    'preserves a %s local destination when an upstream scaffold is removed',
    (_label, local) => {
      const plan = createProjectTemplateApplyPlan(input({
        base: 'base',
        local,
        incoming: undefined,
        policy: 'scaffold',
      }));

      expect(plan.entries[0]).toMatchObject({
        policy: 'scaffold',
        action: 'keep',
        reasonCode: local === undefined ? 'ALREADY_ABSENT' : 'SCAFFOLD_PRESERVED',
      });
    },
  );

  it.each(['unavailable', 'unmerged'] as const)(
    'disables default apply when Git tracking is %s',
    (gitTrackingStatus) => {
      const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
      planInput.localEntries[0]!.gitTrackingStatus = gitTrackingStatus;

      const plan = createProjectTemplateApplyPlan(planInput);

      expect(plan.defaultApplyPossible).toBe(false);
      expect(plan.reviewRequired).toBe(true);
    },
  );

  it('requires review for staged existing content', () => {
    const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
    planInput.localEntries[0]!.gitTrackingStatus = 'staged';

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries[0]?.gitTrackingStatus).toBe('staged');
    expect(plan.reviewRequired).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it('binds plan identity to canonical incoming and base artifacts', () => {
    const firstInput = input({ base: 'base', local: 'base', incoming: 'next' });
    const secondInput = structuredClone(firstInput);
    secondInput.incomingManifest.source.commit = 'c'.repeat(40);

    const first = createProjectTemplateApplyPlan(firstInput);
    const second = createProjectTemplateApplyPlan(secondInput);

    expect(first.incomingManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.baseLockSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.incomingManifestSha256).not.toBe(first.incomingManifestSha256);
    expect(second.planId).not.toBe(first.planId);
  });

  it('redacts secret-bearing content from every serialized diff', () => {
    const secret = 'ghp_syntheticcredential123456';
    const planInput = input({ base: 'base', local: secret, incoming: 'next' });

    const plan = createProjectTemplateApplyPlan(planInput);
    const serialized = JSON.stringify(plan);

    expect(plan.entries[0]?.diff).toEqual({ kind: 'redacted' });
    expect(serialized).not.toContain(secret);
  });

  it('rejects incoming content associated with a sensitive filename', () => {
    const secret = 'local-password=synthetic';
    const planInput = input({ base: 'base', local: 'base', incoming: 'next' });
    planInput.baseLock!.entries[0]!.path = 'secrets.yaml';
    planInput.incomingManifest.entries[0]!.path = 'secrets.yaml';
    planInput.localEntries[0] = {
      ...planInput.localEntries[0]!,
      path: 'secrets.yaml',
      sha256: hash(secret),
      bytes: Buffer.byteLength(secret),
      content: Buffer.from(secret),
    };
    planInput.incomingContents = [{
      path: 'secrets.yaml',
      content: Buffer.from('next'),
    }];

    expect(() => createProjectTemplateApplyPlan(planInput)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ENTRY',
        field: 'incomingContents[0].content',
      }),
    );
  });

  it('rejects blocked content even when a new destination has no diff', () => {
    const secret = 'Authorization: Bearer ghp_syntheticcredential123456';
    const planInput = input({ incoming: secret });

    expect(() => createProjectTemplateApplyPlan(planInput)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ENTRY',
        field: 'incomingContents[0].content',
      }),
    );
  });

  it('cannot default-apply when incoming content validation evidence is omitted', () => {
    const planInput = input({ incoming: 'next' });
    planInput.incomingContents = [];

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries[0]?.action).toBe('add');
    expect(plan.reviewRequired).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it('recomputes archive compatibility instead of trusting a compatible claim', () => {
    const planInput = input({ incoming: 'next' });
    planInput.incomingManifest.takt.minVersion = '999.0.0';
    planInput.incomingInspection = {
      archiveSha256: 'e'.repeat(64),
      manifestSha256: calculateProjectTemplateManifestSha256(
        planInput.incomingManifest,
      ),
      currentTaktVersion: '0.48.0',
      compatibilityStatus: 'compatible',
    };

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.incomingArchiveSha256).toBe('e'.repeat(64));
    expect(plan.incomingCompatibility).toBe('incompatible');
    expect(plan.reviewRequired).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it('rejects content with a capability omitted from the manifest', () => {
    const planInput = input({ incoming: 'run: npm test\n' });

    expect(() => createProjectTemplateApplyPlan(planInput)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ENTRY',
        field: 'incomingContents[0].content',
      }),
    );
  });

  it('requires review when a missing tracked path is reported clean', () => {
    const planInput = input({ incoming: 'next' });
    planInput.missingPathTracking = { 'config.yaml': 'tracked-clean' };

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries[0]?.gitTrackingStatus).toBe('tracked-clean');
    expect(plan.reviewRequired).toBe(true);
    expect(plan.defaultApplyPossible).toBe(false);
  });

  it('describes the effective after state instead of an unapplied incoming state', () => {
    const scaffold = createProjectTemplateApplyPlan(input({
      base: 'base',
      local: 'local',
      incoming: 'next',
      policy: 'scaffold',
    }));
    const deleted = createProjectTemplateApplyPlan(input({
      base: 'base',
      local: 'base',
      incoming: undefined,
    }));
    const conflict = createProjectTemplateApplyPlan(input({
      base: 'base',
      local: 'local',
      incoming: 'next',
    }));

    expect(scaffold.entries[0]).toMatchObject({
      action: 'keep',
      beforeSha256: hash('local'),
      afterSha256: hash('local'),
      incomingSha256: hash('next'),
    });
    expect(deleted.entries[0]).toMatchObject({
      action: 'delete',
      beforeSha256: hash('base'),
    });
    expect(deleted.entries[0]).not.toHaveProperty('afterSha256');
    expect(conflict.entries[0]).toMatchObject({
      action: 'conflict',
      incomingSha256: hash('next'),
    });
    expect(conflict.entries[0]).not.toHaveProperty('afterSha256');
  });

  it('returns a deeply frozen plan and stable ASCII path ordering', () => {
    const planInput = input({});
    planInput.incomingManifest.entries = [
      manifestEntry('z.yaml', 'z'),
      manifestEntry('A.yaml', 'a'),
    ];
    planInput.incomingContents = [
      { path: 'z.yaml', content: Buffer.from('z') },
      { path: 'A.yaml', content: Buffer.from('a') },
    ];

    const plan = createProjectTemplateApplyPlan(planInput);

    expect(plan.entries.map((entry) => entry.path)).toEqual(['A.yaml', 'z.yaml']);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entries)).toBe(true);
    expect(Object.isFrozen(plan.entries[0])).toBe(true);
  });
});
