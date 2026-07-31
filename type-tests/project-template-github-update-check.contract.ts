import {
  claimResolvedGithubTemplateSourceForDownload,
  discardResolvedGithubTemplateSourceDownloadClaim,
  handoffResolvedGithubTemplateSourceDownloadClaimForReceipt,
  type ClaimedResolvedGithubTemplateSource,
  type ClaimedResolvedGithubTemplateSourceForDownload,
  type ResolvedGithubTemplateSource,
} from '../src/features/project-template/github-update-check.js';

declare const resolved: ResolvedGithubTemplateSource;

const downloadClaim: ClaimedResolvedGithubTemplateSourceForDownload =
  claimResolvedGithubTemplateSourceForDownload(resolved);
const receiptClaim: ClaimedResolvedGithubTemplateSource =
  handoffResolvedGithubTemplateSourceDownloadClaimForReceipt(downloadClaim);
void receiptClaim;

const discardedClaim =
  claimResolvedGithubTemplateSourceForDownload(resolved);
discardResolvedGithubTemplateSourceDownloadClaim(discardedClaim);

const forgedClaim = { resolved };
// @ts-expect-error Download ownership includes an unforgeable nominal brand.
const nominalClaim: ClaimedResolvedGithubTemplateSourceForDownload =
  forgedClaim;
void nominalClaim;
// @ts-expect-error Plain structures cannot be discarded as download claims.
discardResolvedGithubTemplateSourceDownloadClaim(forgedClaim);
