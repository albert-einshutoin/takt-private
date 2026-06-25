import { FINDING_SEVERITIES, type FindingLedger, type FindingSeverity, type FindingsRuleContext } from './types.js';

export function renderFindingLedgerInstructionSummary(ledger: FindingLedger): string {
  return JSON.stringify({
    version: ledger.version,
    workflowName: ledger.workflowName,
    requirements: (ledger.requirements ?? []).map((requirement) => ({
      id: requirement.id,
      source: requirement.source,
      statement: requirement.statement,
      expectedResult: requirement.expectedResult,
      targetEntry: requirement.targetEntry,
      exceptionConditions: requirement.exceptionConditions,
      acceptanceCriteria: requirement.acceptanceCriteria,
    })),
    open: ledger.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => ({
        id: finding.id,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        description: finding.description,
        suggestion: finding.suggestion,
        requirementRefs: finding.requirementRefs ?? [],
        acceptanceCriteria: finding.acceptanceCriteria ?? [],
        reviewers: finding.reviewers,
      })),
    resolved: ledger.findings
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => ({
        id: finding.id,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        requirementRefs: finding.requirementRefs ?? [],
        acceptanceCriteria: finding.acceptanceCriteria ?? [],
      })),
    conflicts: ledger.conflicts.map((conflict) => ({
      id: conflict.id,
      status: conflict.status,
      findingIds: conflict.findingIds,
      rawFindingIds: conflict.rawFindingIds,
      description: conflict.description,
    })),
  }, null, 2);
}

export function renderFindingLedgerReportSummary(ledger: FindingLedger): string {
  return JSON.stringify({
    requirements: (ledger.requirements ?? []).map((requirement) => ({
      id: requirement.id,
      statement: requirement.statement,
      acceptanceCriteria: requirement.acceptanceCriteria,
    })),
    open: ledger.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => ({
        id: finding.id,
        requirementRefs: finding.requirementRefs ?? [],
        acceptanceCriteria: finding.acceptanceCriteria ?? [],
      })),
    resolved: ledger.findings
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => ({
        id: finding.id,
        requirementRefs: finding.requirementRefs ?? [],
        acceptanceCriteria: finding.acceptanceCriteria ?? [],
      })),
    conflicts: ledger.conflicts.map((conflict) => ({ id: conflict.id, status: conflict.status })),
  }, null, 2);
}

export function buildFindingsRuleContext(ledger: FindingLedger): FindingsRuleContext {
  const openItems = ledger.findings.filter((finding) => finding.status === 'open');
  const activeConflicts = ledger.conflicts.filter((conflict) => conflict.status === 'active');
  const bySeverity = Object.fromEntries(
    FINDING_SEVERITIES.map((severity) => [severity, 0]),
  ) as Record<FindingSeverity, number>;
  for (const finding of openItems) {
    bySeverity[finding.severity] += 1;
  }

  return {
    open: {
      count: openItems.length,
      bySeverity,
      items: openItems.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        ...(finding.location !== undefined ? { location: finding.location } : {}),
        ...(finding.description !== undefined ? { description: finding.description } : {}),
        ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
        requirementRefs: finding.requirementRefs ?? [],
        acceptanceCriteria: finding.acceptanceCriteria ?? [],
        reviewers: finding.reviewers,
      })),
    },
    resolved: {
      count: ledger.findings.filter((finding) => finding.status === 'resolved').length,
    },
    conflicts: {
      count: activeConflicts.length,
      items: activeConflicts.map((conflict) => ({
        id: conflict.id,
        status: conflict.status,
        findingIds: conflict.findingIds,
        rawFindingIds: conflict.rawFindingIds,
        description: conflict.description,
      })),
    },
  };
}
