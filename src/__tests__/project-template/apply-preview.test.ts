import { createHash, type Hash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTemplateApplyPlan,
} from '../../features/project-template/apply-plan.js';
import type {
  ProjectTemplateApplyPlanInput,
} from '../../features/project-template/apply-plan-types.js';
import {
  canonicalizeTaktpackJson,
} from '../../features/project-template/canonical-json.js';
import {
  calculateProjectTemplateManifestSha256,
} from '../../features/project-template/binding.js';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  inspectProjectTemplateRepertoireDependencies,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';
import {
  createProjectTemplateRepertoireDependencyPlan,
} from '../../features/project-template/repertoire-dependency-plan.js';
import {
  serializeProjectTemplateRepertoireDependencyLock,
} from '../../features/project-template/repertoire-dependency-lock.js';
import {
  assertProjectTemplateApplyPreview,
  createProjectTemplateApplyPreview,
  renderProjectTemplateApplyPreviewHuman,
  renderProjectTemplateApplyPreviewJson,
} from '../../features/project-template/apply-preview.js';

const SOURCE_SHA = 'a'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const source = {
  kind: 'local' as const,
  uri: '.',
  ref: 'workspace' as const,
  commit: 'a'.repeat(40),
};

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function contentInput(
  options: {
    base?: string;
    local?: string;
    incoming?: string;
    compatibility?: 'compatible' | 'unknown' | 'incompatible';
    inspection?: boolean;
    localContent?: boolean;
  } = { base: 'same', local: 'same', incoming: 'same' },
): ProjectTemplateApplyPlanInput {
  const path = 'workflows/test.yaml';
  const baseEntries = options.base === undefined ? [] : [{
    path,
    policy: 'managed' as const,
    mode: '0644',
    sha256: hash(options.base),
    capabilities: [],
  }];
  const incomingEntries = options.incoming === undefined ? [] : [{
    path,
    policy: 'managed' as const,
    mode: '0644',
    sha256: hash(options.incoming),
  }];
  const localEntries = options.local === undefined ? [] : [{
    path,
    mode: '0644',
    sha256: hash(options.local),
    bytes: Buffer.byteLength(options.local),
    ...(options.localContent === false
      ? {}
      : { content: Buffer.from(options.local) }),
    gitTrackingStatus: 'tracked-clean' as const,
  }];
  const input: ProjectTemplateApplyPlanInput = {
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
    missingPathTracking: options.local === undefined
      ? { [path]: 'not-repository' }
      : {},
    incomingContents: options.incoming === undefined
      ? []
      : [{ path, content: Buffer.from(options.incoming) }],
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

function dependency(overrides: Record<string, unknown> = {}) {
  return {
    scope: '@acme/repertoire',
    version: '1.2.3',
    source: 'github:acme/repertoire@v1.2.3',
    commit: COMMIT,
    capabilities: ['edit'],
    ...overrides,
  };
}

function dependencyPlan(
  manifestSha256: string,
  options: {
    dependencies?: readonly unknown[];
    observations?: readonly unknown[];
    witness?: string;
    previousLock?: Record<string, unknown>;
  } = {},
) {
  const dependencies = options.dependencies ?? [];
  const observations = options.observations ?? [];
  const incomingLock = {
    schemaVersion: '1.0' as const,
    sourceDescriptorSha256: SOURCE_SHA,
    manifestSha256,
    dependencies,
  };
  const inspection = inspectProjectTemplateRepertoireDependencies({
    request: {
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256,
      dependencies,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    },
    port: {
      inspect: () => ({
        witnessSha256: options.witness ?? 'd'.repeat(64),
        observations,
      }),
    },
  });
  return createProjectTemplateRepertoireDependencyPlan({
    inspectionClaim:
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(inspection),
    incomingLock: incomingLock as never,
    previousLock: (options.previousLock ?? { state: 'absent' }) as never,
  });
}

function cleanPair() {
  const contentPlan = createProjectTemplateApplyPlan(contentInput());
  const repertoireDependencyPlan = dependencyPlan(
    contentPlan.incomingManifestSha256,
  );
  return { contentPlan, repertoireDependencyPlan };
}

describe('project template sealed outer apply preview G5', () => {
  it('composes and deeply freezes a clean default-applicable preview', () => {
    const pair = cleanPair();
    const preview = createProjectTemplateApplyPreview(pair);
    expect(preview).toMatchObject({
      schemaVersion: '1.0',
      previewId: expect.stringMatching(/^[a-f0-9]{64}$/),
      bindings: {
        contentPlanId: pair.contentPlan.planId,
        contentPreconditionToken: pair.contentPlan.preconditionToken,
        repertoireDependencyPlanId: pair.repertoireDependencyPlan.planId,
        repertoireDependencyPreconditionToken:
          pair.repertoireDependencyPlan.preconditionToken,
        incomingManifestSha256: pair.contentPlan.incomingManifestSha256,
        incomingArchiveSha256: pair.contentPlan.incomingArchiveSha256,
        baseLockSha256: pair.contentPlan.baseLockSha256,
        sourceDescriptorSha256: SOURCE_SHA,
        repertoireDeclarationSha256:
          pair.repertoireDependencyPlan.declarationSha256,
      },
      compositionConflicts: [],
      contentHardConflicts: [],
      dependencyHardConflict: false,
      reviewRequired: false,
      hardConflict: false,
      defaultApplyPossible: true,
    });
    expect(assertProjectTemplateApplyPreview(preview)).toBe(preview);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.bindings)).toBe(true);
  });

  it('exposes a canonical previous dependency digest when available', () => {
    const contentPlan = createProjectTemplateApplyPlan(contentInput());
    const previous = {
      schemaVersion: '1.0' as const,
      sourceDescriptorSha256: SOURCE_SHA,
      manifestSha256: contentPlan.incomingManifestSha256,
      dependencies: [],
    };
    const repertoireDependencyPlan = dependencyPlan(
      contentPlan.incomingManifestSha256,
      {
        previousLock: {
          state: 'present',
          content: serializeProjectTemplateRepertoireDependencyLock(previous),
        },
      },
    );
    const preview = createProjectTemplateApplyPreview({
      contentPlan,
      repertoireDependencyPlan,
    });
    expect(preview.bindings.previousRepertoireLockSha256)
      .toBe(repertoireDependencyPlan.previousLockSha256);
    expect(renderProjectTemplateApplyPreviewJson(preview))
      .toContain(repertoireDependencyPlan.previousLockSha256!);
  });

  it('composes content-only and dependency-only review states', () => {
    const contentReview = createProjectTemplateApplyPlan(contentInput({
      base: 'same', local: 'same', incoming: 'same', inspection: false,
    }));
    const contentOuter = createProjectTemplateApplyPreview({
      contentPlan: contentReview,
      repertoireDependencyPlan: dependencyPlan(contentReview.incomingManifestSha256),
    });
    expect(contentOuter).toMatchObject({
      reviewRequired: true, hardConflict: false, defaultApplyPossible: false,
    });

    const cleanContent = createProjectTemplateApplyPlan(contentInput());
    const dep = dependency();
    const dependencyReview = dependencyPlan(cleanContent.incomingManifestSha256, {
      dependencies: [dep],
      observations: [{
        scope: '@acme/repertoire',
        state: 'installed',
        installed: {
          source: 'github:acme/repertoire',
          ref: 'v1.2.3',
          version: '1.2.3',
          commit: COMMIT,
          capabilities: ['edit'],
        },
      }],
    });
    const dependencyOuter = createProjectTemplateApplyPreview({
      contentPlan: cleanContent,
      repertoireDependencyPlan: dependencyReview,
    });
    expect(dependencyOuter).toMatchObject({
      reviewRequired: true, hardConflict: false, defaultApplyPossible: false,
    });
  });

  it('seals incompatible and entry content hard conflicts in fixed order', () => {
    const incompatible = createProjectTemplateApplyPlan(contentInput({
      base: 'base', local: 'local', incoming: 'next', compatibility: 'incompatible',
    }));
    const preview = createProjectTemplateApplyPreview({
      contentPlan: incompatible,
      repertoireDependencyPlan: dependencyPlan(incompatible.incomingManifestSha256),
    });
    expect(preview.contentHardConflicts).toEqual([
      { code: 'INCOMING_COMPATIBILITY_INCOMPATIBLE' },
      {
        code: 'CONTENT_ENTRY_CONFLICT',
        path: 'workflows/test.yaml',
        reasonCode: 'BOTH_CHANGED',
      },
    ]);
    expect(preview).toMatchObject({
      reviewRequired: true, hardConflict: true, defaultApplyPossible: false,
    });
  });

  it('propagates the live dependency hard-conflict field', () => {
    const contentPlan = createProjectTemplateApplyPlan(contentInput());
    const dep = dependency();
    const repertoireDependencyPlan = dependencyPlan(
      contentPlan.incomingManifestSha256,
      {
        dependencies: [dep],
        observations: [{ scope: '@acme/repertoire', state: 'missing' }],
      },
    );
    const preview = createProjectTemplateApplyPreview({
      contentPlan,
      repertoireDependencyPlan,
    });
    expect(preview.dependencyHardConflict).toBe(true);
    expect(preview.hardConflict).toBe(true);
    expect(preview.defaultApplyPossible).toBe(false);
  });

  it('seals a manifest composition mismatch instead of throwing', () => {
    const contentPlan = createProjectTemplateApplyPlan(contentInput());
    const repertoireDependencyPlan = dependencyPlan('f'.repeat(64));
    const preview = createProjectTemplateApplyPreview({
      contentPlan,
      repertoireDependencyPlan,
    });
    expect(preview.compositionConflicts).toEqual(['MANIFEST_BINDING_MISMATCH']);
    expect(preview).toMatchObject({
      reviewRequired: true, hardConflict: true, defaultApplyPossible: false,
    });
  });

  it('binds both plan identities and opaque tokens into previewId', () => {
    const firstPair = cleanPair();
    const secondContent = createProjectTemplateApplyPlan(contentInput({
      base: 'same', local: 'same', incoming: 'same', inspection: false,
    }));
    const secondPair = {
      contentPlan: secondContent,
      repertoireDependencyPlan: dependencyPlan(
        secondContent.incomingManifestSha256,
        { witness: 'e'.repeat(64) },
      ),
    };
    const first = createProjectTemplateApplyPreview(firstPair);
    const second = createProjectTemplateApplyPreview(secondPair);
    expect(first.bindings.contentPreconditionToken)
      .toBe(firstPair.contentPlan.preconditionToken);
    expect(second.bindings.repertoireDependencyPreconditionToken)
      .toBe(secondPair.repertoireDependencyPlan.preconditionToken);
    expect(first.previewId).not.toBe(second.previewId);

    const sameContent = createProjectTemplateApplyPlan(contentInput());
    const witnessD = createProjectTemplateApplyPreview({
      contentPlan: sameContent,
      repertoireDependencyPlan: dependencyPlan(
        sameContent.incomingManifestSha256,
        { witness: 'd'.repeat(64) },
      ),
    });
    const witnessE = createProjectTemplateApplyPreview({
      contentPlan: sameContent,
      repertoireDependencyPlan: dependencyPlan(
        sameContent.incomingManifestSha256,
        { witness: 'e'.repeat(64) },
      ),
    });
    expect(witnessD.bindings.contentPreconditionToken)
      .toBe(witnessE.bindings.contentPreconditionToken);
    expect(witnessD.bindings.repertoireDependencyPreconditionToken)
      .not.toBe(witnessE.bindings.repertoireDependencyPreconditionToken);
    expect(witnessD.previewId).not.toBe(witnessE.previewId);
  });

  it('rejects unsealed input plans and exact-option hostile shapes hook-free', () => {
    const pair = cleanPair();
    const get = vi.fn();
    const accessor = { repertoireDependencyPlan: pair.repertoireDependencyPlan };
    Object.defineProperty(accessor, 'contentPlan', { enumerable: true, get });
    for (const options of [
      { ...pair, contentPlan: { ...pair.contentPlan } },
      { ...pair, repertoireDependencyPlan: { ...pair.repertoireDependencyPlan } },
      new Proxy({}, { get }),
      accessor,
      runInNewContext('({ contentPlan: {}, repertoireDependencyPlan: {} })'),
    ]) {
      expect(() => createProjectTemplateApplyPreview(options as never)).toThrow();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects cloned, tampered, proxied, accessor, and cross-realm outer previews', () => {
    const preview = createProjectTemplateApplyPreview(cleanPair());
    const get = vi.fn();
    const accessor = {};
    Object.defineProperty(accessor, 'previewId', { get });
    const injected = {
      ...preview,
      bindings: {
        ...preview.bindings,
        sourceDescriptorSha256:
          'credential\n/Users/private/token=synthetic',
      },
    };
    for (const forged of [
      { ...preview },
      { ...preview, previewId: 'f'.repeat(64) },
      injected,
      new Proxy({}, { get }),
      accessor,
      runInNewContext('({ previewId: "a".repeat(64) })'),
    ]) {
      expect(() => assertProjectTemplateApplyPreview(forged)).toThrow();
      expect(() => renderProjectTemplateApplyPreviewHuman(forged as never)).toThrow();
      expect(() => renderProjectTemplateApplyPreviewJson(forged as never)).toThrow();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('does not invoke post-init serialization, iteration, coercion, or hash hooks', () => {
    const pair = cleanPair();
    const stringify = JSON.stringify;
    const iterator = Array.prototype[Symbol.iterator];
    const string = globalThis.String;
    const hashPrototype = Object.getPrototypeOf(createHash('sha256')) as Hash;
    const update = hashPrototype.update;
    const digest = hashPrototype.digest;
    let calls = 0;
    try {
      JSON.stringify = (() => { calls += 1; throw new Error('stringify'); }) as typeof JSON.stringify;
      Array.prototype[Symbol.iterator] = (() => {
        calls += 1;
        throw new Error('iterator');
      }) as typeof Array.prototype[typeof Symbol.iterator];
      globalThis.String = (() => {
        calls += 1;
        throw new Error('coercion');
      }) as StringConstructor;
      hashPrototype.update = (() => {
        calls += 1;
        throw new Error('update');
      }) as typeof hashPrototype.update;
      hashPrototype.digest = (() => {
        calls += 1;
        throw new Error('digest');
      }) as typeof hashPrototype.digest;
      const preview = createProjectTemplateApplyPreview(pair);
      const human = renderProjectTemplateApplyPreviewHuman(preview);
      const json = renderProjectTemplateApplyPreviewJson(preview);
      expect(human.length).toBeGreaterThan(0);
      expect(json.length).toBeGreaterThan(0);
    } finally {
      JSON.stringify = stringify;
      Array.prototype[Symbol.iterator] = iterator;
      globalThis.String = string;
      hashPrototype.update = update;
      hashPrototype.digest = digest;
    }
    expect(calls).toBe(0);
  });

  it('renders canonical parity without either token or non-review evidence', () => {
    const preview = createProjectTemplateApplyPreview(cleanPair());
    const human = renderProjectTemplateApplyPreviewHuman(preview);
    const json = renderProjectTemplateApplyPreviewJson(preview);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toBe(json);
    expect(human).toContain(`previewId=${JSON.stringify(preview.previewId)}`);
    expect(human).toContain('reviewRequired=false');
    expect(parsed).toMatchObject({
      schemaVersion: '1.0',
      previewId: preview.previewId,
      compositionConflicts: [],
      contentHardConflicts: [],
      dependencyHardConflict: false,
      flags: {
        reviewRequired: false,
        hardConflict: false,
        defaultApplyPossible: true,
      },
    });
    const output = human + json;
    expect(output).not.toContain(preview.bindings.contentPreconditionToken);
    expect(output).not.toContain(
      preview.bindings.repertoireDependencyPreconditionToken,
    );
    for (const excluded of [
      'preconditionToken', 'resolvedContents', 'targetRoot', 'witness',
      'accessLog', 'credential', '/Users/',
    ]) expect(output).not.toContain(excluded);
  });

  it('renders complete safe content and dependency review surfaces repeatedly', () => {
    const contentPlan = createProjectTemplateApplyPlan(contentInput({
      base: 'base', local: 'base', incoming: 'next',
    }));
    expect(contentPlan.planId).toBe(
      '64498df1fe60a52f522761795533c13ea68bbf2b3d03a72da400a637f35f66ec',
    );
    const dep = dependency();
    const repertoireDependencyPlan = dependencyPlan(
      contentPlan.incomingManifestSha256,
      {
        dependencies: [dep],
        observations: [{ scope: '@acme/repertoire', state: 'missing' }],
      },
    );
    const preview = createProjectTemplateApplyPreview({
      contentPlan,
      repertoireDependencyPlan,
    });
    const first = renderProjectTemplateApplyPreviewJson(preview);
    expect(first).toBe(renderProjectTemplateApplyPreviewJson(preview));
    expect(renderProjectTemplateApplyPreviewHuman(preview))
      .toContain('path="workflows/test.yaml"');
    expect(first).toContain('UPSTREAM_CHANGED');
    expect(first).toContain('@acme/repertoire');
    expect(first).toContain('NOT_INSTALLED');
  });

  it('renders every safe content DTO field in human form with full digests', () => {
    const contentPlan = createProjectTemplateApplyPlan(contentInput({
      base: 'base', local: 'base', incoming: 'next',
    }));
    const preview = createProjectTemplateApplyPreview({
      contentPlan,
      repertoireDependencyPlan: dependencyPlan(
        contentPlan.incomingManifestSha256,
      ),
    });
    const human = renderProjectTemplateApplyPreviewHuman(preview);
    const parsed = JSON.parse(
      renderProjectTemplateApplyPreviewJson(preview),
    ) as {
      bindings: Record<string, string>;
      content: {
        summary: { counts: Record<string, number>; human: string; json: string };
        entries: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
    };
    for (const digest of Object.values(parsed.bindings)) {
      expect(human).toContain(digest);
    }
    const entry = parsed.content.entries[0]!;
    for (const field of [
      'path', 'policy', 'action', 'reasonCode', 'beforeSha256', 'baseSha256',
      'incomingSha256', 'afterSha256', 'beforeMode', 'incomingMode',
      'afterMode', 'gitTrackingStatus', 'rollbackImpact', 'reviewRequired',
    ]) {
      expect(human).toContain(JSON.stringify(entry[field]));
    }
    expect(human).toContain(JSON.stringify(entry['capabilitiesBefore']));
    expect(human).toContain(JSON.stringify(entry['capabilitiesAfter']));
    expect(human).toContain(JSON.stringify(entry['diff']));
    expect(human).toContain(JSON.stringify(parsed.content.summary.counts));
    expect(human).toContain(JSON.stringify(parsed.content.summary.human));
    expect(human).toContain(JSON.stringify(parsed.content.summary.json));
  });

  it('renders only safe sentinels for opaque content and resists path injection', () => {
    const secret = 'ghp_syntheticcredential123456';
    const cases = [
      { expected: 'redacted', base: 'base', local: secret, incoming: 'next' },
      { expected: 'binary', base: 'a\u0000', local: 'a\u0000', incoming: 'b\u0000' },
      {
        expected: 'too-large',
        base: 'a'.repeat(65 * 1024),
        local: 'a'.repeat(65 * 1024),
        incoming: 'b'.repeat(65 * 1024),
      },
      {
        expected: 'unavailable',
        base: 'base',
        local: 'base',
        incoming: 'next',
        localContent: false,
      },
    ] as const;
    for (const scenario of cases) {
      const contentPlan = createProjectTemplateApplyPlan(contentInput(scenario));
      const preview = createProjectTemplateApplyPreview({
        contentPlan,
        repertoireDependencyPlan: dependencyPlan(
          contentPlan.incomingManifestSha256,
        ),
      });
      const output = renderProjectTemplateApplyPreviewHuman(preview)
        + renderProjectTemplateApplyPreviewJson(preview);
      expect(output).toContain(`"kind":"${scenario.expected}"`);
      expect(output).not.toContain(secret);
      expect(output.length).toBeLessThan(64 * 1024);
    }

    const pair = cleanPair();
    const injected = 'credential\n/Users/private/token=synthetic';
    expect(Reflect.set(pair.contentPlan.entries[0]!, 'path', injected)).toBe(false);
    const preview = createProjectTemplateApplyPreview(pair);
    expect(renderProjectTemplateApplyPreviewHuman(preview)).not.toContain(injected);
    expect(renderProjectTemplateApplyPreviewJson(preview)).not.toContain(injected);
  });

  it('does not change the established content planId formula', () => {
    const contentPlan = createProjectTemplateApplyPlan(contentInput());
    const body = structuredClone(contentPlan) as Record<string, unknown>;
    delete body['planId'];
    expect(hash(canonicalizeTaktpackJson(body))).toBe(contentPlan.planId);
  });
});
