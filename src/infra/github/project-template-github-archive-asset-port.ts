import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import type {
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  createProjectTemplateArtifactDownloadPort,
  type ProjectTemplateArtifactDownloadContext,
  type ProjectTemplateArtifactDownloadDependencies,
} from './project-template-artifact-download.js';
import {
  createProjectTemplateArtifactSingleAttempt,
} from './project-template-artifact-download-attempt.js';
import {
  createProjectTemplateArtifactRetryBridge,
  type ProjectTemplateArtifactRetryDependencies,
} from './project-template-artifact-download-retry.js';
import {
  acquireProjectTemplateGhCredential,
} from './project-template-gh-auth.js';

export type ProjectTemplateGithubArchiveAssetPortDependencies =
  ProjectTemplateArtifactRetryDependencies;

interface DependenciesSnapshot {
  readonly receiver: ProjectTemplateGithubArchiveAssetPortDependencies;
  readonly now: ProjectTemplateGithubArchiveAssetPortDependencies['now'];
  readonly setTimer:
    ProjectTemplateGithubArchiveAssetPortDependencies['setTimer'];
  readonly clearTimer:
    ProjectTemplateGithubArchiveAssetPortDependencies['clearTimer'];
  readonly acquireCredential:
    ProjectTemplateGithubArchiveAssetPortDependencies['acquireCredential'];
  readonly createAttempt:
    ProjectTemplateGithubArchiveAssetPortDependencies['createAttempt'];
}

const DEFAULT_DEPENDENCIES =
  Object.freeze<ProjectTemplateGithubArchiveAssetPortDependencies>({
    now: () => performance.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      return undefined;
    },
    acquireCredential: acquireProjectTemplateGhCredential,
    createAttempt: createProjectTemplateArtifactSingleAttempt,
  });

function invalidArgument(): TypeError {
  return new TypeError('GitHub archive asset port input is invalid');
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalidArgument();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotContext(
  value: ProjectTemplateArtifactDownloadContext,
): Readonly<ProjectTemplateArtifactDownloadContext> {
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
  value: ProjectTemplateGithubArchiveAssetPortDependencies | undefined,
): DependenciesSnapshot {
  const receiver = value ?? DEFAULT_DEPENDENCIES;
  const record = exactDataRecord(receiver, [
    'now',
    'setTimer',
    'clearTimer',
    'acquireCredential',
    'createAttempt',
  ]);
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'function' || types.isProxy(entry)) {
      throw invalidArgument();
    }
  }
  return Object.freeze({
    receiver,
    now: record['now'] as DependenciesSnapshot['now'],
    setTimer: record['setTimer'] as DependenciesSnapshot['setTimer'],
    clearTimer: record['clearTimer'] as DependenciesSnapshot['clearTimer'],
    acquireCredential: record['acquireCredential'] as
      DependenciesSnapshot['acquireCredential'],
    createAttempt: record['createAttempt'] as
      DependenciesSnapshot['createAttempt'],
  });
}

export function createProjectTemplateGithubArchiveAssetPort(
  contextValue: ProjectTemplateArtifactDownloadContext,
  dependenciesValue?: ProjectTemplateGithubArchiveAssetPortDependencies,
): GithubTemplateArchiveAssetPort {
  const context = snapshotContext(contextValue);
  const source = snapshotDependencies(dependenciesValue);

  // Both D1 and D4 must observe one clock/timer authority. These wrappers also
  // preserve the original dependency receiver instead of leaking projection
  // objects as `this` across the composition boundary.
  const now = Object.freeze((): number => Reflect.apply(
    source.now,
    source.receiver,
    [],
  ));
  const setTimer = Object.freeze((
    callback: () => void,
    delayMs: number,
  ): unknown => Reflect.apply(
    source.setTimer,
    source.receiver,
    [callback, delayMs],
  ));
  const clearTimer = Object.freeze((handle: unknown): unknown => Reflect.apply(
    source.clearTimer,
    source.receiver,
    [handle],
  ));
  const retryDependencies =
    Object.freeze<ProjectTemplateArtifactRetryDependencies>({
      now,
      setTimer,
      clearTimer,
      acquireCredential: Object.freeze((options) => Reflect.apply(
        source.acquireCredential,
        source.receiver,
        [options],
      )),
      createAttempt: Object.freeze((credential, input) => Reflect.apply(
        source.createAttempt,
        source.receiver,
        [credential, input],
      )),
    });
  const downloadDependencies =
    Object.freeze<ProjectTemplateArtifactDownloadDependencies>({
      now,
      setTimer,
      clearTimer,
      start: Object.freeze((
        input: Readonly<GithubTemplateArchiveAssetInput>,
      ) => createProjectTemplateArtifactRetryBridge(
        input,
        context,
        retryDependencies,
      )),
    });
  return createProjectTemplateArtifactDownloadPort(
    context,
    downloadDependencies,
  );
}
