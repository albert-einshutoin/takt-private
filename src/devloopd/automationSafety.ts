export type AutomationSafetyStopRule =
  | 'budget exceeded'
  | 'completion signal'
  | 'circuit breaker';

export interface AutomationSafetyBudgets {
  maxRuns?: number;
  maxPullRequests?: number;
  maxRetries?: number;
  maxCostProxy?: number;
  maxDurationSeconds?: number;
  maxChangedFiles?: number;
  maxChangedLines?: number;
  maxConsecutiveNoopSignals?: number;
  maxClassifierDisagreements?: number;
  maxCiFlakes?: number;
  maxReviewFixFailures?: number;
  maxProductPolicyEscalations?: number;
}

export interface AutomationSafetyState {
  startedAt: string;
  now: string;
  runs?: number;
  pullRequests?: number;
  retries?: number;
  costProxy?: number;
  changedFiles?: number;
  changedLines?: number;
  consecutiveNoopSignals?: number;
  classifierDisagreements?: number;
  ciFlakes?: number;
  reviewFixFailures?: number;
  productPolicyEscalations?: number;
}

export interface AutomationSafetyReport {
  allowed: boolean;
  stopRule?: AutomationSafetyStopRule;
  reasons: readonly string[];
  nextActions: readonly string[];
}

function exceeded(label: string, actual: number | undefined, max: number | undefined): string | undefined {
  if (actual === undefined || max === undefined || actual <= max) {
    return undefined;
  }
  return `${label} exceeded: ${actual} > ${max}`;
}

function reached(label: string, actual: number | undefined, threshold: number | undefined): string | undefined {
  if (actual === undefined || threshold === undefined || actual < threshold) {
    return undefined;
  }
  return `${label} reached: ${actual} >= ${threshold}`;
}

function elapsedSeconds(state: AutomationSafetyState): number | undefined {
  const started = Date.parse(state.startedAt);
  const now = Date.parse(state.now);
  if (!Number.isFinite(started) || !Number.isFinite(now)) {
    return undefined;
  }
  return Math.max(0, Math.floor((now - started) / 1000));
}

export function evaluateAutomationSafety(input: {
  budgets: AutomationSafetyBudgets;
  state: AutomationSafetyState;
}): AutomationSafetyReport {
  const budgetReasons = [
    exceeded('runs', input.state.runs, input.budgets.maxRuns),
    exceeded('pull requests', input.state.pullRequests, input.budgets.maxPullRequests),
    exceeded('retries', input.state.retries, input.budgets.maxRetries),
    exceeded('cost proxy', input.state.costProxy, input.budgets.maxCostProxy),
    exceeded('duration seconds', elapsedSeconds(input.state), input.budgets.maxDurationSeconds),
    exceeded('changed files', input.state.changedFiles, input.budgets.maxChangedFiles),
    exceeded('changed lines', input.state.changedLines, input.budgets.maxChangedLines),
  ].filter((reason): reason is string => reason !== undefined);
  if (budgetReasons.length > 0) {
    return {
      allowed: false,
      stopRule: 'budget exceeded',
      reasons: budgetReasons,
      nextActions: ['stop automation and inspect the latest ledger event'],
    };
  }

  const noopReason = reached('consecutive no-op signals', input.state.consecutiveNoopSignals, input.budgets.maxConsecutiveNoopSignals);
  if (noopReason !== undefined) {
    return {
      allowed: false,
      stopRule: 'completion signal',
      reasons: [noopReason],
      nextActions: ['stop because the loop is not finding new eligible work'],
    };
  }

  const circuitReasons = [
    exceeded('classifier disagreements', input.state.classifierDisagreements, input.budgets.maxClassifierDisagreements),
    exceeded('CI flakes', input.state.ciFlakes, input.budgets.maxCiFlakes),
    exceeded('review-fix failures', input.state.reviewFixFailures, input.budgets.maxReviewFixFailures),
    exceeded('product-policy escalations', input.state.productPolicyEscalations, input.budgets.maxProductPolicyEscalations),
  ].filter((reason): reason is string => reason !== undefined);
  if (circuitReasons.length > 0) {
    return {
      allowed: false,
      stopRule: 'circuit breaker',
      reasons: circuitReasons,
      nextActions: ['pause recursive automation and ask for human review of the repeated failure mode'],
    };
  }

  return {
    allowed: true,
    reasons: ['within automation safety budgets'],
    nextActions: ['continue staged automation loop'],
  };
}
