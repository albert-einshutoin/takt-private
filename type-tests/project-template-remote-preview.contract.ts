import {
  createGithubProjectTemplateRemotePreview,
  type CreateGithubProjectTemplateRemotePreviewOptions,
  type ProjectTemplateRemoteApplyPreview,
  type ProjectTemplateSourceProvenanceV1,
} from '../src/features/project-template/index.js';

declare const verifier: CreateGithubProjectTemplateRemotePreviewOptions['verifier'];
declare const repertoireInspectionPort:
  CreateGithubProjectTemplateRemotePreviewOptions['repertoireInspectionPort'];

const options: CreateGithubProjectTemplateRemotePreviewOptions = {
  cacheRoot: '/cache',
  receiptKey: 'a'.repeat(64),
  verifier,
  projectRoot: '/project',
  currentTaktVersion: '0.48.0',
  repertoireInspectionPort,
  baselineStrategy: 'adopt-identical',
};
const preview: Promise<ProjectTemplateRemoteApplyPreview> =
  createGithubProjectTemplateRemotePreview(options);
void preview;

declare const provenance: ProjectTemplateSourceProvenanceV1;
const commit: string = provenance.source.commit;
void commit;

const invalid: CreateGithubProjectTemplateRemotePreviewOptions = {
  ...options,
  // @ts-expect-error Remote preview baseline is an explicit closed union.
  baselineStrategy: 'replace',
};
void invalid;
