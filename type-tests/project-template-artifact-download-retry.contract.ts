import type {
  ProjectTemplateArtifactRetryDependencies,
} from '../src/infra/github/project-template-artifact-download-retry.js';
import type {
  ProjectTemplateArtifactDownloadBridge,
} from '../src/infra/github/project-template-artifact-download.js';

const returningNow: ProjectTemplateArtifactRetryDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  acquireCredential: async () => Object.freeze({
    dispose: () => undefined,
  }),
  createAttempt: () => Object.freeze({
    pull: () => undefined,
    dispose: () => undefined,
  }) as never,
};
void returningNow;

const badAcquire: ProjectTemplateArtifactRetryDependencies = {
  now: () => 1,
  setTimer: () => ({}),
  clearTimer: () => undefined,
  // @ts-expect-error Credential acquisition must return a native Promise shape.
  acquireCredential: () => Object.freeze({
    then: () => undefined,
  }),
  createAttempt: () => {
    throw new Error('unreachable');
  },
};
void badAcquire;

const badNow: ProjectTemplateArtifactRetryDependencies = {
  // @ts-expect-error The monotonic clock must return a number.
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
void badNow;

// @ts-expect-error The D1 bridge returned by D4 remains nominal.
const forgedBridge: ProjectTemplateArtifactDownloadBridge = {};
void forgedBridge;
