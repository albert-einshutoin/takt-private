import {
  createProjectTemplateRemoteProductionComposition,
  type ProjectTemplateRemoteProductionComposition,
} from '../src/index.js';

type FactoryOptions = Parameters<
  typeof createProjectTemplateRemoteProductionComposition
>[0];

declare const dependencies: FactoryOptions;
declare const composition: ProjectTemplateRemoteProductionComposition;

void createProjectTemplateRemoteProductionComposition(dependencies);

composition.download({
  projectRoot: '/project',
  cacheRoot: '/cache',
  source: 'github:acme/template@main',
  advisory: dependencies as never,
});

composition.preview({
  projectRoot: '/project',
  cacheRoot: '/cache',
  receiptKey: 'a'.repeat(64),
  currentTaktVersion: '0.48.0',
  baselineStrategy: 'conflict',
});

composition.apply({
  projectRoot: '/project',
  cacheRoot: '/cache',
  receiptKey: 'a'.repeat(64),
  previewId: 'b'.repeat(64),
  transactionPlanId: 'c'.repeat(64),
  approvalId: 'approval-00000000-0000-0000-0000-000000000000',
  currentTaktVersion: '0.48.0',
  baselineStrategy: 'conflict',
});

composition.preview({
  projectRoot: '/project',
  cacheRoot: '/cache',
  receiptKey: 'a'.repeat(64),
  currentTaktVersion: '0.48.0',
  baselineStrategy: 'conflict',
  // @ts-expect-error Receipt verifier authority is never public input.
  verifier: { verify: async () => 'valid' },
});

composition.apply({
  projectRoot: '/project',
  cacheRoot: '/cache',
  receiptKey: 'a'.repeat(64),
  previewId: 'b'.repeat(64),
  transactionPlanId: 'c'.repeat(64),
  approvalId: 'approval-00000000-0000-0000-0000-000000000000',
  currentTaktVersion: '0.48.0',
  baselineStrategy: 'conflict',
  // @ts-expect-error Mutation lease claims are internal owned-core authority.
  leaseClaim: {},
});
