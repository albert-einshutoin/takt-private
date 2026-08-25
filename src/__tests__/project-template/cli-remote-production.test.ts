import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GithubTemplateSourceResolverPort } from '../../features/project-template/github-source-resolver-port.js';
import {
  demoteResolvedGithubTemplateSourceToAdvisory,
  resolveGithubTemplateSource,
  resolveGithubTemplateSourceForAuthenticatedDownload,
  type GithubTemplateSourceAdvisory,
  type GithubTemplateSourceMetadataPort,
} from '../../features/project-template/github-update-check.js';
import {
  createProjectTemplateExportPlan,
  parseProjectTemplateGithubSourceSpec,
  writeTaktpack,
} from '../../features/project-template/index.js';
import { serializeProjectTemplateSourceDescriptor } from '../../features/project-template/source-descriptor.js';
import type {
  ProjectTemplateReceiptKeyRegistry,
  ProjectTemplateReceiptKeyStore,
} from '../../infra/security/project-template-receipt-key-store.js';
import {
  createProjectTemplateCliRemoteProductionRuntimeForTest as createCoreRemoteRuntime,
} from '../../infra/github/project-template-cli-remote-production.js';
import type {
  ProjectTemplateCliRemoteMutationOptions,
} from '../../features/project-template/cli-remote-apply-service.js';
import { startProjectTemplateCliLifecycle } from '../../features/project-template/cli-lifecycle.js';
import type {
  ProjectTemplateRemoteProductionComposition,
} from '../../infra/github/project-template-remote-production-composition.js';
import {
  createProjectTemplateRemoteProductionComposition,
  ProjectTemplateRemoteProductionCompositionError,
} from '../../infra/github/project-template-remote-production-composition.js';

const roots: string[] = [];
const PLAN_ID = 'a'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function memoryReceiptKeyStore(): ProjectTemplateReceiptKeyStore {
  let registry: ProjectTemplateReceiptKeyRegistry | undefined;
  let generation: number | undefined;
  let tail = Promise.resolve();
  return {
    async read() { return registry === undefined ? undefined : structuredClone(registry); },
    async write(value) {
      registry = structuredClone(value);
      generation = (generation ?? -1) + 1;
    },
    async withExclusiveLease(operation) {
      const run = tail.then(async () => operation({
        snapshot: registry === undefined ? undefined : {
          generation: generation!, registry: structuredClone(registry),
        },
        compareAndSwap: async (expected, next) => {
          if (expected !== generation) return undefined;
          generation = (generation ?? -1) + 1;
          registry = structuredClone(next);
          return { generation, registry: structuredClone(registry) };
        },
      }));
      tail = run.then(() => undefined, () => undefined);
      return await run;
    },
    async dispose() {},
  };
}

type RemoteMutationTestOptions =
  | Extract<ProjectTemplateCliRemoteMutationOptions, { mode: 'dry-run' }>
  | Omit<Extract<ProjectTemplateCliRemoteMutationOptions, { mode: 'apply' }>, 'admitMutation'>;

function createProjectTemplateCliRemoteProductionRuntimeForTest(
  value: Parameters<typeof createCoreRemoteRuntime>[0],
) {
  const runtime = createCoreRemoteRuntime(value);
  const mutate = (
    command: 'apply' | 'update',
    options: RemoteMutationTestOptions,
  ) => {
    if (options.mode === 'dry-run') return runtime.service[command](options);
    return startProjectTemplateCliLifecycle({
      command: `project-template ${command}`,
      mode: 'apply',
      dispose: () => undefined,
      handle: ({ admitMutation, signal }) => runtime.service[command]({
        ...options,
        signal: options.signal ?? signal,
        admitMutation,
      }),
    }).result;
  };
  return {
    ...runtime,
    service: {
      ...runtime.service,
      apply: (options: RemoteMutationTestOptions) => mutate('apply', options),
      update: (options: RemoteMutationTestOptions) => mutate('update', options),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project template remote CLI production runtime', () => {
  it('carries the authenticated GitHub review through the production WeakMap into schema 1.1', async () => {
    const sourceRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'takt-cli-remote-v1-1-source-')),
    );
    const projectRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'takt-cli-remote-v1-1-target-')),
    );
    const cacheRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'takt-cli-remote-v1-1-cache-')),
    );
    roots.push(sourceRoot, projectRoot, cacheRoot);
    chmodSync(cacheRoot, 0o700);
    const workflowPath = join(sourceRoot, '.takt', 'workflows', 'review.yaml');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, `name: review
initial_step: review
max_steps: 1
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    const exportPlan = await createProjectTemplateExportPlan(sourceRoot, {
      packVersion: '1.2.3',
      takt: { minVersion: '0.48.0' },
      source: {
        kind: 'github',
        uri: 'https://github.com/acme/template',
        ref: 'v1.2.3',
        commit: COMMIT,
      },
    });
    const packPath = join(sourceRoot, 'template.taktpack');
    await writeTaktpack(packPath, exportPlan);
    const archive = readFileSync(packPath);
    const archiveId = createHash('sha256').update(archive).digest('hex');
    const descriptor = serializeProjectTemplateSourceDescriptor({
      schemaVersion: '1.0',
      pack: {
        version: '1.2.3',
        releaseTag: 'v1.2.3',
        assetName: 'template.taktpack',
        checksumAssetName: 'template.taktpack.sha256',
        sha256: archiveId,
      },
      repertoireDependencies: [],
    });
    const checksum = `${archiveId}  template.taktpack\n`;
    const metadata: GithubTemplateSourceMetadataPort = {
      async resolveRefToCommit() { return { commit: COMMIT }; },
      async readFileAtCommit() { return new TextEncoder().encode(descriptor); },
      async getReleaseByTag() {
        return {
          id: 1,
          tagName: 'v1.2.3',
          assets: [
            { id: 2, name: 'template.taktpack', size: archive.byteLength },
            { id: 3, name: 'template.taktpack.sha256', size: checksum.length },
          ],
        };
      },
      async readReleaseAsset() { return new TextEncoder().encode(checksum); },
    };
    const source = 'https://github.com/acme/template/releases/download/v1.2.3/template.taktpack';
    const sourceSpec = parseProjectTemplateGithubSourceSpec(source);
    const advisory = demoteResolvedGithubTemplateSourceToAdvisory(
      await resolveGithubTemplateSource({ source: sourceSpec, metadata }),
    );
    const resolver: GithubTemplateSourceResolverPort = {
      async resolveAdvisory() { return advisory; },
      async resolveForDownload(input) {
        return await resolveGithubTemplateSourceForAuthenticatedDownload({
          source: parseProjectTemplateGithubSourceSpec(input.source),
          metadata,
        });
      },
    };
    const composition = await createProjectTemplateRemoteProductionComposition({
      keyStore: memoryReceiptKeyStore(),
      resolver,
      asset: {
        openReleaseAsset() {
          return (async function* () { yield archive; })();
        },
      },
      repertoireInspectionPort: {
        inspect() { return { witnessSha256: 'e'.repeat(64), observations: [] }; },
      },
    });
    const runtime = createCoreRemoteRuntime({ cacheRoot, resolver, composition });

    const outcome = await runtime.service.diffV1_1({
      cwd: projectRoot,
      source,
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict',
      force: false,
    });

    expect(outcome.exitCode, JSON.stringify(outcome)).toBe(0);
    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        schemaVersion: '1.1',
        status: 'success',
        command: 'project-template diff',
        result: {
          detail: {
            source: {
              kind: 'github',
              owner: 'acme',
              repo: 'template',
              requestedRef: 'v1.2.3',
              resolvedCommit: COMMIT,
              releaseTag: 'v1.2.3',
              assetName: 'template.taktpack',
              archiveId,
            },
            actionCounts: { add: 1, update: 0, keep: 0, delete: 0, conflict: 0, excluded: 0 },
            targets: {
              totalCount: 1,
              truncated: false,
              items: [{ path: 'workflows/review.yaml', action: 'add' }],
            },
          },
        },
      },
    });
    const json = JSON.stringify(outcome);
    expect(json).not.toContain(cacheRoot);
    expect(json).not.toContain(projectRoot);
    expect(json).not.toMatch(
      /receiptKey|previewId|approval|authority|repositoryUrl|canonicalSource|token|credential/iu,
    );
    await runtime.dispose();
  });

  it('keeps receipt/preview authority private and never calls public approve', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-production-'));
    roots.push(cwd);
    const advisory = {
      updateState: 'update-available',
      hardBlocked: false,
    } as GithubTemplateSourceAdvisory;
    const resolveAdvisory = vi.fn(async () => advisory);
    const resolver = {
      resolveAdvisory,
      async resolveForDownload() { throw new Error('not called by adapter'); },
    } satisfies GithubTemplateSourceResolverPort;
    let sequence = 0;
    const download = vi.fn(async () => ({ receiptKey: `${++sequence}`.padStart(64, 'a') }));
    const preview = vi.fn(async () => ({
      previewId: `preview-${sequence}`,
      transactionPlanId: PLAN_ID,
      summary: {
        changeCount: 2,
        conflictCount: 0,
        dependencyCount: 1,
        reviewRequired: false,
        hardConflict: false,
        defaultApplyPossible: true,
      },
    }));
    const approve = vi.fn(async () => ({ approvalId: 'must-not-be-used' }));
    const applyWithInternalApproval = vi.fn(async () => ({
      status: 'committed' as const,
      transactionPlanId: PLAN_ID,
      backupId: 'backup-safe',
    }));
    const dispose = vi.fn(async () => undefined);
    const composition = {
      download,
      preview,
      approve,
      async apply() { throw new Error('legacy apply must not be used'); },
      applyWithInternalApproval,
      async recover() { return { status: 'none' as const }; },
      dispose,
    } satisfies ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
    });
    const base = {
      cwd,
      source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0',
      baselineStrategy: 'conflict' as const,
      force: false,
    };

    const dry = await runtime.service.diff(base);
    const applied = await runtime.service.apply({
      ...base, mode: 'apply', expectedPlanId: PLAN_ID,
    });

    expect(dry).toMatchObject({ envelope: { result: {
      planId: PLAN_ID, changeCount: 2, dependencyCount: 1,
    } } });
    expect(applied).toMatchObject({ envelope: { result: {
      planId: PLAN_ID, applied: true, backupId: 'backup-safe',
    } } });
    expect(JSON.stringify([dry, applied])).not.toMatch(
      /receipt|previewId|approval|evidence|verifier|cache|authority/iu,
    );
    expect(resolveAdvisory).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(approve).not.toHaveBeenCalled();
    expect(applyWithInternalApproval).toHaveBeenCalledOnce();
    expect(applyWithInternalApproval.mock.calls[0]![0]).not.toHaveProperty('approvalId');
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('maps opaque derivation failures to SOURCE_UNAVAILABLE without leaking cause', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-derive-failure-'));
    roots.push(cwd);
    const sensitive = '/private/cache/receipt-secret.json';
    const resolver = {
      async resolveAdvisory() {
        return { updateState: 'update-available', hardBlocked: false } as
          GithubTemplateSourceAdvisory;
      },
      async resolveForDownload() { throw new Error('not called'); },
    } satisfies GithubTemplateSourceResolverPort;
    const operationFailure = () => new ProjectTemplateRemoteProductionCompositionError(
      'OPERATION_FAILED', new AggregateError([new Error(sensitive)]),
    );
    const composition = {
      async download() { throw operationFailure(); },
      async preview() { throw operationFailure(); },
      async approve() { throw operationFailure(); },
      async apply() { throw operationFailure(); },
      async applyWithInternalApproval() { throw operationFailure(); },
      async recover() { throw operationFailure(); },
      async dispose() {},
    } satisfies ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
    });

    const outcome = await runtime.service.diff({
      cwd, source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict', force: false,
    });

    expect(outcome).toMatchObject({
      envelope: { status: 'error', error: { code: 'SOURCE_UNAVAILABLE' } },
    });
    expect(JSON.stringify(outcome)).not.toContain(sensitive);
    expect(JSON.stringify(outcome)).not.toMatch(/cause|receipt-secret/iu);
  });

  it('maps an admitted opaque execute failure to RESULT_INDETERMINATE', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-execute-failure-'));
    roots.push(cwd);
    const sensitive = '/private/project/.takt/apply-journal.json';
    const resolver = {
      async resolveAdvisory() {
        return { updateState: 'update-available', hardBlocked: false } as
          GithubTemplateSourceAdvisory;
      },
      async resolveForDownload() { throw new Error('not called'); },
    } satisfies GithubTemplateSourceResolverPort;
    const composition = {
      async download() { return { receiptKey: 'b'.repeat(64) }; },
      async preview() {
        return {
          previewId: 'preview-safe', transactionPlanId: PLAN_ID,
          summary: {
            changeCount: 1, conflictCount: 0, dependencyCount: 0,
            reviewRequired: false, hardConflict: false,
            defaultApplyPossible: true,
          },
        };
      },
      async approve() { throw new Error('must not be called'); },
      async apply() { throw new Error('must not be called'); },
      async applyWithInternalApproval() {
        throw new ProjectTemplateRemoteProductionCompositionError(
          'OPERATION_FAILED', new AggregateError([new Error(sensitive)]),
        );
      },
      async recover() { return { status: 'none' as const }; },
      async dispose() {},
    } satisfies ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
    });

    const outcome = await runtime.service.apply({
      cwd, source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict', force: false,
      mode: 'apply', expectedPlanId: PLAN_ID,
    });

    expect(outcome).toMatchObject({
      envelope: { status: 'error', error: { code: 'RESULT_INDETERMINATE' } },
    });
    expect(JSON.stringify(outcome)).not.toContain(sensitive);
    expect(JSON.stringify(outcome)).not.toMatch(/cause|apply-journal/iu);
  });

  it('rejects post-dispose admission before network and shares one dispose promise', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-disposed-'));
    roots.push(cwd);
    const resolveAdvisory = vi.fn(async () => ({
      updateState: 'up-to-date', hardBlocked: false,
    } as GithubTemplateSourceAdvisory));
    const resolver = {
      resolveAdvisory,
      async resolveForDownload() { throw new Error('not called'); },
    } satisfies GithubTemplateSourceResolverPort;
    const dispose = vi.fn(async () => undefined);
    const unavailable = async (): Promise<never> => { throw new Error('not called'); };
    const composition = {
      download: unavailable, preview: unavailable, approve: unavailable,
      apply: unavailable, applyWithInternalApproval: unavailable,
      async recover() { return { status: 'none' as const }; }, dispose,
    } as unknown as ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
    });

    const first = runtime.dispose();
    const second = runtime.dispose();
    expect(second).toBe(first);
    await first;
    const outcome = await runtime.service.diff({
      cwd, source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict', force: false,
    });

    expect(outcome).toMatchObject({
      envelope: { status: 'error', error: { code: 'SOURCE_UNAVAILABLE' } },
    });
    expect(resolveAdvisory).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('aborts in-flight advisory and closes its completion-to-download race', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-advisory-race-'));
    roots.push(cwd);
    let releaseAdvisory!: () => void;
    const advisoryGate = new Promise<void>((resolve) => { releaseAdvisory = resolve; });
    let observedSignal: AbortSignal | undefined;
    const resolver = {
      async resolveAdvisory(input: { signal?: AbortSignal }) {
        observedSignal = input.signal;
        await advisoryGate;
        return { updateState: 'update-available', hardBlocked: false } as
          GithubTemplateSourceAdvisory;
      },
      async resolveForDownload() { throw new Error('not called'); },
    } as GithubTemplateSourceResolverPort;
    const download = vi.fn(async () => ({ receiptKey: 'b'.repeat(64) }));
    const dispose = vi.fn(async () => undefined);
    const composition = {
      download,
      async preview() { throw new Error('not called'); },
      async approve() { throw new Error('not called'); },
      async apply() { throw new Error('not called'); },
      async applyWithInternalApproval() { throw new Error('not called'); },
      async recover() { return { status: 'none' as const }; }, dispose,
    } satisfies ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
    });
    const outcomePromise = runtime.service.diff({
      cwd, source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict', force: false,
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const disposing = runtime.dispose();
    expect(observedSignal!.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    releaseAdvisory();
    await expect(outcomePromise).resolves.toMatchObject({
      envelope: { status: 'error', error: { code: 'SOURCE_UNAVAILABLE' } },
    });
    await disposing;
    expect(download).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('drains admitted execution before one concurrent composition disposal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-mutation-drain-'));
    roots.push(cwd);
    const resolver = {
      async resolveAdvisory() {
        return { updateState: 'update-available', hardBlocked: false } as
          GithubTemplateSourceAdvisory;
      },
      async resolveForDownload() { throw new Error('not called'); },
    } satisfies GithubTemplateSourceResolverPort;
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const applyWithInternalApproval = vi.fn(async () => {
      await mutationGate;
      return {
        status: 'committed' as const, transactionPlanId: PLAN_ID,
        backupId: 'backup-safe',
      };
    });
    const dispose = vi.fn(async () => undefined);
    const composition = {
      async download() { return { receiptKey: 'b'.repeat(64) }; },
      async preview() {
        return {
          previewId: 'preview-safe', transactionPlanId: PLAN_ID,
          summary: {
            changeCount: 1, conflictCount: 0, dependencyCount: 0,
            reviewRequired: false, hardConflict: false,
            defaultApplyPossible: true,
          },
        };
      },
      async approve() { throw new Error('not called'); },
      async apply() { throw new Error('not called'); },
      applyWithInternalApproval,
      async recover() { return { status: 'none' as const }; }, dispose,
    } satisfies ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
    });
    const outcome = runtime.service.apply({
      cwd, source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict', force: false,
      mode: 'apply', expectedPlanId: PLAN_ID,
    });
    await vi.waitFor(() => expect(applyWithInternalApproval).toHaveBeenCalledOnce());

    const first = runtime.dispose();
    const second = runtime.dispose();
    expect(second).toBe(first);
    expect(dispose).not.toHaveBeenCalled();
    releaseMutation();
    await expect(outcome).resolves.toMatchObject({ envelope: { status: 'success' } });
    await first;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('bounds pre-admission drain when resolver ignores abort without abandoning execute drain', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-cli-remote-bounded-dispose-'));
    roots.push(cwd);
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
    const resolveAdvisory = vi.fn(async () => {
        await resolverGate;
        return { updateState: 'update-available', hardBlocked: false } as
          GithubTemplateSourceAdvisory;
      });
    const resolver = {
      resolveAdvisory,
      async resolveForDownload() { throw new Error('not called'); },
    } satisfies GithubTemplateSourceResolverPort;
    const dispose = vi.fn(async () => undefined);
    const composition = {
      async download() { throw new Error('must not be called'); },
      async preview() { throw new Error('must not be called'); },
      async approve() { throw new Error('must not be called'); },
      async apply() { throw new Error('must not be called'); },
      async applyWithInternalApproval() { throw new Error('must not be called'); },
      async recover() { return { status: 'none' as const }; }, dispose,
    } satisfies ProjectTemplateRemoteProductionComposition;
    const runtime = createProjectTemplateCliRemoteProductionRuntimeForTest({
      cacheRoot: join(cwd, 'cache'), resolver, composition,
      disposeDrainTimeoutMs: 10,
    });
    const outcome = runtime.service.diff({
      cwd, source: 'github:owner/template@v1.0.0',
      currentTaktVersion: '0.48.0', baselineStrategy: 'conflict', force: false,
    });
    await vi.waitFor(() => expect(resolveAdvisory).toHaveBeenCalledOnce());

    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    releaseResolver();
    await expect(outcome).resolves.toMatchObject({
      envelope: { error: { code: 'SOURCE_UNAVAILABLE' } },
    });
  });
});
