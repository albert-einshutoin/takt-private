import {
  claimResolvedGithubTemplateSourceForDownload,
  consumeResolvedGithubTemplateSourceReceiptClaim,
  demoteResolvedGithubTemplateSourceToAdvisory,
  discardResolvedGithubTemplateSource,
  discardResolvedGithubTemplateSourceDownloadClaim,
  handoffResolvedGithubTemplateSourceDownloadClaimForReceipt,
  type ClaimedResolvedGithubTemplateSource,
  type ClaimedResolvedGithubTemplateSourceForDownload,
  type GithubTemplateSourceAdvisory,
  type ResolvedGithubTemplateSource,
} from '../src/features/project-template/github-update-check.js';

declare const resolved: ResolvedGithubTemplateSource;

const advisory: GithubTemplateSourceAdvisory =
  demoteResolvedGithubTemplateSourceToAdvisory(resolved);
const structuralAdvisory: GithubTemplateSourceAdvisory = { ...advisory };
void structuralAdvisory.source.owner;
void structuralAdvisory.release.asset.id;
// @ts-expect-error Advisory evidence has a distinct non-authority shape.
const resolvedFromAdvisory: ResolvedGithubTemplateSource = advisory;
void resolvedFromAdvisory;

discardResolvedGithubTemplateSource(resolved);

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
