import {
  claimResolvedGithubTemplateSourceForDownload,
  consumeResolvedGithubTemplateSourceReceiptClaim,
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
const forgedReceiptClaim = {
  resolved: receiptClaim.resolved,
  descriptor: receiptClaim.descriptor,
};
// @ts-expect-error Receipt ownership also has an unforgeable nominal brand.
const nominalReceiptClaim: ClaimedResolvedGithubTemplateSource =
  forgedReceiptClaim;
void nominalReceiptClaim;
// @ts-expect-error Public provenance fields cannot forge receipt ownership.
consumeResolvedGithubTemplateSourceReceiptClaim(forgedReceiptClaim);

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
