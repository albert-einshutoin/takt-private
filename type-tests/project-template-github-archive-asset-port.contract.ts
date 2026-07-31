import type {
  GithubTemplateArchiveAssetPort,
} from '../src/index.js';
import {
  createProjectTemplateGithubArchiveAssetPort,
  type ProjectTemplateGithubArchiveAssetPortDependencies,
} from '../src/index.js';

const port: GithubTemplateArchiveAssetPort =
  createProjectTemplateGithubArchiveAssetPort({ deadlineMs: 1 });
void port;

const badClock: ProjectTemplateGithubArchiveAssetPortDependencies = {
  // @ts-expect-error The shared monotonic clock must return a number.
  now: () => '1',
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  createAttempt: () => {
    throw new Error('unreachable');
  },
};
void badClock;

// @ts-expect-error The absolute deadline must be numeric.
createProjectTemplateGithubArchiveAssetPort({ deadlineMs: '1' });

const missingDependency: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  // @ts-expect-error A single-attempt factory is required.
  createAttempt: undefined,
};
void missingDependency;

const badTimer: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  // @ts-expect-error Timer callbacks must be parameterless functions.
  setTimer: (_callback: string) => ({}),
  // @ts-expect-error Timer handles are opaque and must accept unknown.
  clearTimer: (_handle: number) => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  createAttempt: () => {
    throw new Error('unreachable');
  },
};
void badTimer;

const extraDependency: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  createAttempt: () => {
    throw new Error('unreachable');
  },
  // @ts-expect-error The runtime dependency record is exact.
  unexpected: true,
};
void extraDependency;
