import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import type {
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import type {
  GithubTemplateSourceResolutionInput,
  GithubTemplateSourceResolverPort,
} from '../../features/project-template/github-source-resolver-port.js';
import {
  demoteResolvedGithubTemplateSourceToAdvisory,
  discardResolvedGithubTemplateSource,
  type GithubTemplateCurrentSourceEvidence,
  type GithubTemplateSourceAdvisory,
  type ResolvedGithubTemplateSource,
} from '../../features/project-template/github-update-check.js';
import {
  createProjectTemplateArtifactSingleAttempt,
} from './project-template-artifact-download-attempt.js';
import {
  requestProjectTemplateGithubApiMetadata,
} from './project-template-api-transport.js';
import {
  acquireProjectTemplateGhCredential,
} from './project-template-gh-auth.js';
import {
  createProjectTemplateGithubArchiveAssetPort,
  type ProjectTemplateGithubArchiveAssetPortDependencies,
} from './project-template-github-archive-asset-port.js';
import {
  resolveAuthenticatedGithubTemplateSource,
  type ProjectTemplateSourceResolverDependencies,
} from './project-template-source-resolver.js';

const CAPTURED_REFLECT_APPLY = Reflect.apply;

export interface ProjectTemplateGithubSourceCompositionContext {
  readonly deadlineMs: number;
}

export interface ProjectTemplateGithubSourceCompositionDependencies
  extends ProjectTemplateGithubArchiveAssetPortDependencies {
  readonly requestMetadata:
    ProjectTemplateSourceResolverDependencies['requestMetadata'];
}

export interface ProjectTemplateGithubSourceComposition {
  readonly resolver: GithubTemplateSourceResolverPort;
  readonly archive: GithubTemplateArchiveAssetPort;
}

interface DependencySnapshot {
  readonly receiver: ProjectTemplateGithubSourceCompositionDependencies;
  readonly now: ProjectTemplateGithubSourceCompositionDependencies['now'];
  readonly setTimer:
    ProjectTemplateGithubSourceCompositionDependencies['setTimer'];
  readonly clearTimer:
    ProjectTemplateGithubSourceCompositionDependencies['clearTimer'];
  readonly acquireCredential:
    ProjectTemplateGithubSourceCompositionDependencies['acquireCredential'];
  readonly createAttempt:
    ProjectTemplateGithubSourceCompositionDependencies['createAttempt'];
  readonly requestMetadata:
    ProjectTemplateGithubSourceCompositionDependencies['requestMetadata'];
}

const DEFAULT_DEPENDENCIES =
  Object.freeze<ProjectTemplateGithubSourceCompositionDependencies>({
    now: () => performance.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      return undefined;
    },
    acquireCredential: acquireProjectTemplateGhCredential,
    createAttempt: createProjectTemplateArtifactSingleAttempt,
    requestMetadata: requestProjectTemplateGithubApiMetadata,
  });

function invalidArgument(): TypeError {
  return new TypeError('GitHub source composition input is invalid');
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw invalidArgument();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some(
      (key) => typeof key !== 'string' || !keys.includes(key),
    )
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalidArgument();
    }
    record[key] = descriptor.value;
  }
  return record;
}

function snapshotContext(
  value: ProjectTemplateGithubSourceCompositionContext,
): Readonly<ProjectTemplateGithubSourceCompositionContext> {
  const record = exactDataRecord(value, ['deadlineMs']);
  const deadlineMs = record['deadlineMs'];
  if (
    typeof deadlineMs !== 'number'
    || !Number.isFinite(deadlineMs)
    || deadlineMs < 0
  ) throw invalidArgument();
  return Object.freeze({ deadlineMs });
}

function snapshotDependencies(
  value: ProjectTemplateGithubSourceCompositionDependencies | undefined,
): DependencySnapshot {
  const receiver = value ?? DEFAULT_DEPENDENCIES;
  const record = exactDataRecord(receiver, [
    'now',
    'setTimer',
    'clearTimer',
    'acquireCredential',
    'createAttempt',
    'requestMetadata',
  ]);
  for (const dependency of Object.values(record)) {
    if (typeof dependency !== 'function' || types.isProxy(dependency)) {
      throw invalidArgument();
    }
  }
  return Object.freeze({
    receiver,
    now: record['now'] as DependencySnapshot['now'],
    setTimer: record['setTimer'] as DependencySnapshot['setTimer'],
    clearTimer: record['clearTimer'] as DependencySnapshot['clearTimer'],
    acquireCredential: record['acquireCredential'] as
      DependencySnapshot['acquireCredential'],
    createAttempt: record['createAttempt'] as
      DependencySnapshot['createAttempt'],
    requestMetadata: record['requestMetadata'] as
      DependencySnapshot['requestMetadata'],
  });
}

function snapshotCurrent(
  value: unknown,
): GithubTemplateCurrentSourceEvidence | undefined {
  if (value === undefined) return undefined;
  const record = exactDataRecord(value, [
    'owner',
    'repo',
    'repositoryUrl',
    'canonicalSource',
    'version',
    'sha256',
    'commit',
    'descriptorSha256',
  ]);
  return Object.freeze({ ...record }) as
    unknown as GithubTemplateCurrentSourceEvidence;
}

function snapshotResolutionInput(
  value: GithubTemplateSourceResolutionInput,
): Readonly<GithubTemplateSourceResolutionInput> {
  const keys = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  ) ? Reflect.ownKeys(value) : [];
  const hasCurrent = keys.includes('current');
  const hasSignal = keys.includes('signal');
  const record = exactDataRecord(value, [
    'source',
    ...(hasCurrent ? ['current'] : []),
    ...(hasSignal ? ['signal'] : []),
  ]);
  if (typeof record['source'] !== 'string') throw invalidArgument();
  const current = snapshotCurrent(record['current']);
  const signal = record['signal'];
  return Object.freeze({
    source: record['source'],
    ...(current === undefined ? {} : { current }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

export function createProjectTemplateGithubSourceComposition(
  contextValue: ProjectTemplateGithubSourceCompositionContext,
  dependenciesValue?: ProjectTemplateGithubSourceCompositionDependencies,
): ProjectTemplateGithubSourceComposition {
  const context = snapshotContext(contextValue);
  const source = snapshotDependencies(dependenciesValue);

  // D5 and F3 receive exact projections over one captured receiver. This keeps
  // one absolute deadline and one archive identity without sharing credential
  // instances or allowing later method replacement to alter either boundary.
  const archiveDependencies =
    Object.freeze<ProjectTemplateGithubArchiveAssetPortDependencies>({
      now: Object.freeze(() => CAPTURED_REFLECT_APPLY(
        source.now,
        source.receiver,
        [],
      )),
      setTimer: Object.freeze((callback, delayMs) => CAPTURED_REFLECT_APPLY(
        source.setTimer,
        source.receiver,
        [callback, delayMs],
      )),
      clearTimer: Object.freeze((handle) => CAPTURED_REFLECT_APPLY(
        source.clearTimer,
        source.receiver,
        [handle],
      )),
      acquireCredential: Object.freeze((options) => CAPTURED_REFLECT_APPLY(
        source.acquireCredential,
        source.receiver,
        [options],
      )),
      createAttempt: Object.freeze((credential, input) =>
        CAPTURED_REFLECT_APPLY(
          source.createAttempt,
          source.receiver,
          [credential, input],
        )),
    });
  const resolverDependencies =
    Object.freeze<ProjectTemplateSourceResolverDependencies>({
      acquireCredential: Object.freeze((options) => CAPTURED_REFLECT_APPLY(
        source.acquireCredential,
        source.receiver,
        [options],
      )),
      requestMetadata: Object.freeze((options) => CAPTURED_REFLECT_APPLY(
        source.requestMetadata,
        source.receiver,
        [options],
      )),
    });
  const archive = createProjectTemplateGithubArchiveAssetPort(
    context,
    archiveDependencies,
  );

  const resolve = (
    inputValue: GithubTemplateSourceResolutionInput,
  ): Promise<ResolvedGithubTemplateSource> => {
    const input = snapshotResolutionInput(inputValue);
    return resolveAuthenticatedGithubTemplateSource({
      source: input.source,
      checksumAssets: archive,
      deadlineMs: context.deadlineMs,
      ...(input.current === undefined ? {} : { current: input.current }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, resolverDependencies);
  };
  const resolver = Object.freeze<GithubTemplateSourceResolverPort>({
    resolveAdvisory: Object.freeze(async (
      input: GithubTemplateSourceResolutionInput,
    ): Promise<GithubTemplateSourceAdvisory> => {
      const resolved = await resolve(input);
      try {
        return demoteResolvedGithubTemplateSourceToAdvisory(resolved);
      } catch (error) {
        // Demotion normally consumes the result. If evidence construction
        // fails before that transition, retire the fresh authority here.
        try {
          discardResolvedGithubTemplateSource(resolved);
        } catch {
          // The original bounded failure remains authoritative.
        }
        throw error;
      }
    }),
    resolveForDownload: Object.freeze(async (
      input: GithubTemplateSourceResolutionInput,
    ) => resolve(input)),
  });
  return Object.freeze({ resolver, archive });
}
