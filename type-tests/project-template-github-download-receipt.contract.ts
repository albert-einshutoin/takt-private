import {
  prepareGithubTemplateDownloadReceipt,
  type GithubTemplateDownloadReceiptAuthenticator,
} from '../src/features/project-template/github-download-receipt.js';
import type {
  MaterializedGithubTemplateCache,
} from '../src/features/project-template/github-download-storage.js';
import type {
  ClaimedResolvedGithubTemplateSourceForDownload,
  ResolvedGithubTemplateSource,
} from '../src/features/project-template/github-update-check.js';

declare const rawResolved: ResolvedGithubTemplateSource;
declare const downloadClaim:
  ClaimedResolvedGithubTemplateSourceForDownload;
declare const materialized: MaterializedGithubTemplateCache;
declare const authenticator: GithubTemplateDownloadReceiptAuthenticator;

void prepareGithubTemplateDownloadReceipt({
  downloadClaim,
  materialized,
  authenticator,
});

void prepareGithubTemplateDownloadReceipt({
  // @ts-expect-error Raw resolved provenance cannot bypass download ownership.
  downloadClaim: rawResolved,
  materialized,
  authenticator,
});

void prepareGithubTemplateDownloadReceipt({
  // @ts-expect-error Cloned download claims lose their nominal authority.
  downloadClaim: {
    resolved: downloadClaim.resolved,
  },
  materialized,
  authenticator,
});
