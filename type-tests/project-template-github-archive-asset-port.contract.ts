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

const badAcquireReturn: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  // @ts-expect-error Credential acquisition is always asynchronous.
  acquireCredential: () => Object.freeze({
    dispose: () => undefined,
  }),
  createAttempt: () => {
    throw new Error('unreachable');
  },
};
void badAcquireReturn;

const badAcquireOptions: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  // @ts-expect-error Authentication options cannot be narrowed to a string.
  acquireCredential: (_options: string) => Promise.resolve(Object.freeze({
    dispose: () => undefined,
  })),
  createAttempt: () => {
    throw new Error('unreachable');
  },
};
void badAcquireOptions;

const badCreateCredential:
ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  // @ts-expect-error Attempt factories must accept the disposable credential.
  createAttempt: (_credential: string) => {
    throw new Error('unreachable');
  },
};
void badCreateCredential;

const badCreateInput: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  // @ts-expect-error Attempt factories must accept the exact archive input.
  createAttempt: (_credential, _input: string) => {
    throw new Error('unreachable');
  },
};
void badCreateInput;

const badCreateReturn: ProjectTemplateGithubArchiveAssetPortDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  // @ts-expect-error Inner attempts are nominal capabilities, not structures.
  createAttempt: () => Object.freeze({
    pull: () => undefined,
    dispose: () => undefined,
  }),
};
void badCreateReturn;
