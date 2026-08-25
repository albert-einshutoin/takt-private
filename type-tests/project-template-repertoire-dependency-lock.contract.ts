import {
  calculateProjectTemplateRepertoireDependencyLockSha256,
  parseProjectTemplateRepertoireDependencyLock,
  parseProjectTemplateRepertoireDependencyLockJson,
  serializeProjectTemplateRepertoireDependencyLock,
  type ProjectTemplateRepertoireDependencyLockV1,
} from '../src/features/project-template/repertoire-dependency-lock.js';

const lock: ProjectTemplateRepertoireDependencyLockV1 = {
  schemaVersion: '1.0',
  sourceDescriptorSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  dependencies: [{
    scope: '@acme/repertoire',
    version: '1.2.3',
    source: 'github:acme/repertoire@v1.2.3',
    commit: 'c'.repeat(40),
    capabilities: ['edit'],
  }],
};

const parsed: ProjectTemplateRepertoireDependencyLockV1 =
  parseProjectTemplateRepertoireDependencyLock(lock);
const parsedJson: ProjectTemplateRepertoireDependencyLockV1 =
  parseProjectTemplateRepertoireDependencyLockJson(
    serializeProjectTemplateRepertoireDependencyLock(parsed),
  );
const digest: string =
  calculateProjectTemplateRepertoireDependencyLockSha256(parsedJson);
void digest;

const invalidCapability: ProjectTemplateRepertoireDependencyLockV1 = {
  ...lock,
  dependencies: [{
    ...lock.dependencies[0]!,
    // @ts-expect-error Only the reviewed edit capability is supported in v1.
    capabilities: ['execute'],
  }],
};
void invalidCapability;

const invalidSchema: ProjectTemplateRepertoireDependencyLockV1 = {
  ...lock,
  // @ts-expect-error Future lock schemas require a distinct contract.
  schemaVersion: '1.1',
};
void invalidSchema;
