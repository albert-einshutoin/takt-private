import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  calculateProjectTemplateManifestSha256,
  canonicalizeTaktpackJson,
  createProjectTemplateApplyPlan,
  prepareProjectTemplateApplyPlan,
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

  it('fails closed before semantic merge when base bytes are unavailable', () => {
    const planInput = input({
      base: 'language: en\n',
      local: 'language: ja\n',
      incoming: 'language: en\ntimezone: UTC\n',
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
      reasonCode: 'BASE_UNAVAILABLE',
    });
    expect(planInput.localEntries).toEqual(before);
  });

  it('seals a successful config semantic merge while keeping incoming provenance', () => {
    const base = 'provider_routing:\n  personas:\n    planner: codex\n';
    const local = 'provider_routing:\n  personas:\n    planner: claude\n';
    const incoming = `${base}timezone: Asia/Tokyo\n`;
    const planInput = input({ base, local, incoming, policy: 'merge' });
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);
    const resolved = prepared.resolvedContents[0]?.content;

    expect(prepared.plan.entries[0]).toMatchObject({
      policy: 'merge',
      action: 'update',
      reasonCode: 'SEMANTIC_MERGED',
      baseSha256: hash(base),
      incomingSha256: hash(incoming),
      afterSha256: hash(Buffer.from(resolved ?? []).toString()),
      mergeDiagnostics: {
        status: 'merged',
      },
    });
    expect(Buffer.from(resolved ?? []).toString()).toContain('planner: claude');
    expect(Buffer.from(resolved ?? []).toString()).toContain('timezone: Asia/Tokyo');
    expect(prepared.plan.entries[0]?.afterSha256).not.toBe(hash(incoming));
    expect(Object.isFrozen(prepared.plan.entries[0]?.mergeDiagnostics)).toBe(true);

    const planBody = structuredClone(prepared.plan) as Record<string, unknown>;
    delete planBody['planId'];
    expect(hash(canonicalizeTaktpackJson(planBody))).toBe(prepared.plan.planId);
    const entries = planBody['entries'] as Array<Record<string, unknown>>;
    const mergeDiagnostics = entries[0]?.['mergeDiagnostics'] as Record<string, unknown>;
    mergeDiagnostics['diagnostics'] = [{
      code: 'RULE_REVIEW_REQUIRED',
      path: ['timezone'],
      message: 'synthetic diagnostic',
    }];
    expect(hash(canonicalizeTaktpackJson(planBody))).not.toBe(prepared.plan.planId);
  });

  it('seals exact semantic conflicts without exposing resolved bytes', () => {
    const base = 'provider_routing:\n  personas:\n    planner: codex\n';
    const local = 'provider_routing:\n  personas:\n    planner: claude\n';
    const incoming = 'provider_routing:\n  personas:\n    planner: cursor\n';
    const planInput = input({ base, local, incoming, policy: 'merge' });
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'conflict',
      reasonCode: 'CONFLICT',
      mergeDiagnostics: {
        status: 'conflict',
        conflicts: [{
          path: ['provider_routing', 'personas', 'planner'],
          reason: 'BOTH_CHANGED',
        }],
      },
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('fails closed when the base content is missing or does not match the formal lock', () => {
    const base = 'provider_routing:\n  personas:\n    planner: codex\n';
    const local = 'provider_routing:\n  personas:\n    planner: claude\n';
    const incoming = `${base}timezone: Asia/Tokyo\n`;
    const planInput = input({ base, local, incoming, policy: 'merge' });

    const missing = prepareProjectTemplateApplyPlan(planInput);
    const mismatched = prepareProjectTemplateApplyPlan({
      ...planInput,
      baseContents: [{
        path: 'config.yaml',
        content: Buffer.from('language: ja\n'),
      }],
    });

    for (const prepared of [missing, mismatched]) {
      expect(prepared.plan.entries[0]).toMatchObject({
        action: 'conflict',
        reasonCode: 'BASE_UNAVAILABLE',
        mergeDiagnostics: { status: 'base-unavailable' },
      });
      expect(prepared.plan.entries[0]).not.toHaveProperty('afterSha256');
    }
  });

  it('recovers a legacy base from incoming bytes that match the formal lock', () => {
    const base = 'language: en\n';
    const local = 'language: ja\n';
    const prepared = prepareProjectTemplateApplyPlan(input({
      base,
      local,
      incoming: base,
      policy: 'merge',
    }));

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'keep',
      reasonCode: 'SEMANTIC_MERGED',
      beforeSha256: hash(local),
      afterSha256: hash(local),
      mergeDiagnostics: { status: 'merged' },
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('reuses a verified baseline when an unchanged large local snapshot omits content', () => {
    const base = `${'# padding\n'.repeat(8_000)}language: en\n`;
    const incoming = `${base}timezone: UTC\n`;
    const planInput = input({
      base,
      local: base,
      incoming,
      policy: 'merge',
    });
    delete planInput.localEntries[0]!.content;
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'update',
      reasonCode: 'SEMANTIC_MERGED',
      beforeSha256: hash(base),
      afterSha256: hash(incoming),
      mergeDiagnostics: { status: 'merged' },
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('reuses verified incoming bytes for a large current config with a local-only mode', () => {
    const base = `${'# padding\n'.repeat(8_000)}language: en\n`;
    const incoming = `${base}timezone: UTC\n`;
    const planInput = input({
      base,
      local: incoming,
      incoming,
      policy: 'merge',
    });
    planInput.localEntries[0]!.mode = '0600';
    delete planInput.localEntries[0]!.content;
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'keep',
      reasonCode: 'SEMANTIC_MERGED',
      beforeSha256: hash(incoming),
      afterSha256: hash(incoming),
      beforeMode: '0600',
      afterMode: '0600',
      mergeDiagnostics: { status: 'merged' },
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('preserves opaque-content review for a large semantic first install', () => {
    const incoming = `${'# token: sensitive-looking-value\n'.repeat(2_500)}language: en\n`;

    const prepared = prepareProjectTemplateApplyPlan(input({
      incoming,
      policy: 'merge',
    }));

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'add',
      reasonCode: 'SEMANTIC_MERGED',
      reviewRequired: true,
      mergeDiagnostics: { status: 'merged' },
    });
    expect(prepared.plan.defaultApplyPossible).toBe(false);
  });

  it('blocks an unsafe devloop policy on a direct add', () => {
    const incoming = 'mode: unsafe\n';
    const planInput = input({});
    planInput.incomingManifest.entries = [
      manifestEntry('devloopd.yaml', incoming, 'merge'),
    ];
    planInput.incomingContents = [{
      path: 'devloopd.yaml',
      content: Buffer.from(incoming),
    }];
    planInput.missingPathTracking = { 'devloopd.yaml': 'not-repository' };

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      path: 'devloopd.yaml',
      action: 'conflict',
      reasonCode: 'CONFLICT',
      mergeDiagnostics: {
        status: 'blocked',
        code: 'MERGED_DEVLOOP_POLICY_INVALID',
      },
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it.each([
    ['Config.yaml', 'subscription_only: true\nprovider: codex\n'],
    ['DEVLOOPD.YAML', 'mode: unsafe\n'],
  ])(
    'applies semantic validation to case-variant direct add %s',
    (path, incoming) => {
      const planInput = input({});
      planInput.incomingManifest.entries = [
        manifestEntry(path, incoming, 'merge'),
      ];
      planInput.incomingContents = [{ path, content: Buffer.from(incoming) }];
      planInput.missingPathTracking = { [path]: 'not-repository' };

      const prepared = prepareProjectTemplateApplyPlan(planInput);

      expect(prepared.plan.entries[0]).toMatchObject({
        path,
        action: 'conflict',
        reasonCode: 'CONFLICT',
        reviewRequired: true,
        mergeDiagnostics: { status: 'blocked' },
      });
      expect(prepared.resolvedContents).toEqual([]);
    },
  );

  it('blocks global-only configuration on a direct add', () => {
    const incoming = 'analytics:\n  events_path: events.ndjson\n';
    const planInput = input({});
    planInput.incomingManifest.entries = [
      manifestEntry('config.yaml', incoming, 'merge'),
    ];
    planInput.incomingContents = [{
      path: 'config.yaml',
      content: Buffer.from(incoming),
    }];
    planInput.missingPathTracking = { 'config.yaml': 'not-repository' };

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      path: 'config.yaml',
      action: 'conflict',
      reasonCode: 'CONFLICT',
      reviewRequired: true,
      mergeDiagnostics: {
        status: 'blocked',
        code: 'GLOBAL_ONLY_PATH',
        document: 'incoming',
      },
    });
    expect(prepared.plan.defaultApplyPossible).toBe(false);
    expect(prepared.resolvedContents).toEqual([]);
  });

  it.each([
    ['git hooks', 'allow_git_hooks: true\n', ['allow_git_hooks'], []],
    [
      'provider network access',
      'provider_options:\n  codex:\n    network_access: true\n',
      ['provider_options', 'codex', 'network_access'],
      [],
    ],
    [
      'OpenCode network access',
      'provider_options:\n  opencode:\n    network_access: true\n',
      ['provider_options', 'opencode', 'network_access'],
      [],
    ],
    [
      'runtime prepare scripts',
      'runtime:\n  prepare:\n    - .takt/automation/prepare.sh\n',
      ['runtime', 'prepare'],
      ['external-command'],
    ],
    [
      'subscription boundary changes',
      'subscription_only: false\n',
      ['subscription_only'],
      [],
    ],
    [
      'submodule fetching',
      'with_submodules: true\n',
      ['with_submodules'],
      [],
    ],
    [
      'automatic pull request creation',
      'auto_pr: true\n',
      ['auto_pr'],
      [],
    ],
  ] as const)(
    'requires review for a direct config add containing %s',
    (_label, incoming, path, capabilities) => {
      const planInput = input({});
      planInput.incomingManifest.entries = [
        {
          ...manifestEntry('config.yaml', incoming, 'merge'),
          capabilities: [...capabilities],
        },
      ];
      planInput.incomingManifest.capabilities = [...capabilities];
      planInput.incomingContents = [{
        path: 'config.yaml',
        content: Buffer.from(incoming),
      }];
      planInput.missingPathTracking = { 'config.yaml': 'not-repository' };

      const prepared = prepareProjectTemplateApplyPlan(planInput);

      expect(prepared.plan).toMatchObject({
        reviewRequired: true,
        defaultApplyPossible: false,
      });
      expect(prepared.plan.entries[0]).toMatchObject({
        path: 'config.yaml',
        action: 'add',
        reviewRequired: true,
        mergeDiagnostics: {
          status: 'merged',
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: 'RULE_REVIEW_REQUIRED',
              path,
            }),
          ]),
        },
      });
    },
  );

  it.each([
    [
      'unsafe provider',
      'subscription_only: true\nprovider: codex\n',
    ],
    [
      'credential',
      'subscription_only: true\nprovider: codex-cli\nopenai_api_key: synthetic\n',
    ],
  ] as const)('blocks a direct config update containing an %s', (_label, incoming) => {
    const base = 'subscription_only: true\nprovider: codex-cli\n';
    const planInput = input({
      base,
      local: base,
      incoming,
      policy: 'merge',
    });
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'conflict',
      reasonCode: 'CONFLICT',
      mergeDiagnostics: { status: 'blocked' },
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('preserves a project-owned value when local still matches the base', () => {
    const base = 'subscription_only: true\nprovider: codex-cli\n';
    const incoming = 'subscription_only: true\nprovider: cursor-cli\n';
    const planInput = input({
      base,
      local: base,
      incoming,
      policy: 'merge',
    });
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'keep',
      reasonCode: 'SEMANTIC_MERGED',
      beforeSha256: hash(base),
      incomingSha256: hash(incoming),
      afterSha256: hash(base),
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('preserves a locally deleted config when incoming still matches the base', () => {
    const base = 'subscription_only: true\nprovider: codex-cli\n';
    const planInput = input({
      base,
      incoming: base,
      policy: 'merge',
    });
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      path: 'config.yaml',
      action: 'keep',
      reasonCode: 'LOCAL_DELETED',
      reviewRequired: false,
    });
    expect(prepared.resolvedContents).toEqual([]);
  });

  it('preserves a local-only hardened mode during a semantic content update', () => {
    const base = 'language: en\n';
    const local = 'language: en\n';
    const incoming = 'language: ja\n';
    const planInput = input({ base, local, incoming, policy: 'merge' });
    planInput.baseLock!.entries[0]!.mode = '0644';
    planInput.localEntries[0]!.mode = '0600';
    planInput.incomingManifest.entries[0]!.mode = '0644';
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'update',
      reasonCode: 'SEMANTIC_MERGED',
      beforeMode: '0600',
      incomingMode: '0644',
      afterMode: '0600',
    });
  });

  it('reports a conflict when local and incoming modes both changed differently', () => {
    const base = 'language: en\n';
    const local = 'language: en\n';
    const incoming = 'language: ja\n';
    const planInput = input({ base, local, incoming, policy: 'merge' });
    planInput.baseLock!.entries[0]!.mode = '0644';
    planInput.localEntries[0]!.mode = '0600';
    planInput.incomingManifest.entries[0]!.mode = '0660';
    planInput.baseContents = [{
      path: 'config.yaml',
      content: Buffer.from(base),
    }];

    const prepared = prepareProjectTemplateApplyPlan(planInput);

    expect(prepared.plan.entries[0]).toMatchObject({
      action: 'conflict',
      reasonCode: 'BOTH_CHANGED',
      reviewRequired: true,
      mergeDiagnostics: {
        status: 'conflict',
        conflicts: [{ path: ['$mode'], reason: 'BOTH_CHANGED' }],
      },
    });
    expect(prepared.plan.defaultApplyPossible).toBe(false);
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
