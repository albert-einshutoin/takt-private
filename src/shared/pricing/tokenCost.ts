export interface TokenUsageForCost {
  usageMissing?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface EstimateTokenCostInput {
  provider: string | undefined;
  model: string | undefined;
  usage: TokenUsageForCost | undefined;
}

export interface TokenCostEstimate {
  costUsd: number;
  model: string;
  pricingKey: string;
}

interface TokenPricePerMillion {
  inputUsd: number;
  outputUsd: number;
  cachedInputUsd?: number;
  cacheCreationInputUsd?: number;
  cacheReadInputUsd?: number;
}

const TOKENS_PER_MILLION = 1_000_000;

// Public API price snapshot reviewed on 2026-06-25. Unknown models deliberately
// stay unpriced so cost dashboards do not mix estimates with guessed billing.
const OPENAI_PRICES: Readonly<Record<string, TokenPricePerMillion>> = {
  'gpt-5.5': { inputUsd: 5, cachedInputUsd: 0.5, outputUsd: 30 },
  'gpt-5.5-pro': { inputUsd: 30, outputUsd: 180 },
  'gpt-5.4': { inputUsd: 2.5, cachedInputUsd: 0.25, outputUsd: 15 },
  'gpt-5.4-mini': { inputUsd: 0.75, cachedInputUsd: 0.075, outputUsd: 4.5 },
  'gpt-5.4-nano': { inputUsd: 0.2, cachedInputUsd: 0.02, outputUsd: 1.25 },
  'gpt-5.4-pro': { inputUsd: 30, outputUsd: 180 },
  'gpt-5.3-codex': { inputUsd: 1.75, cachedInputUsd: 0.175, outputUsd: 14 },
  'chat-latest': { inputUsd: 5, cachedInputUsd: 0.5, outputUsd: 30 },
};

const ANTHROPIC_PRICES: Readonly<Record<string, TokenPricePerMillion>> = {
  'claude-fable-5': { inputUsd: 10, cacheCreationInputUsd: 12.5, cacheReadInputUsd: 1, outputUsd: 50 },
  'claude-mythos-5': { inputUsd: 10, cacheCreationInputUsd: 12.5, cacheReadInputUsd: 1, outputUsd: 50 },
  'claude-opus-4.8': { inputUsd: 5, cacheCreationInputUsd: 6.25, cacheReadInputUsd: 0.5, outputUsd: 25 },
  'claude-opus-4.7': { inputUsd: 5, cacheCreationInputUsd: 6.25, cacheReadInputUsd: 0.5, outputUsd: 25 },
  'claude-opus-4.6': { inputUsd: 5, cacheCreationInputUsd: 6.25, cacheReadInputUsd: 0.5, outputUsd: 25 },
  'claude-opus-4.5': { inputUsd: 5, cacheCreationInputUsd: 6.25, cacheReadInputUsd: 0.5, outputUsd: 25 },
  'claude-opus-4.1': { inputUsd: 15, cacheCreationInputUsd: 18.75, cacheReadInputUsd: 1.5, outputUsd: 75 },
  'claude-opus-4': { inputUsd: 15, cacheCreationInputUsd: 18.75, cacheReadInputUsd: 1.5, outputUsd: 75 },
  'claude-sonnet-4.6': { inputUsd: 3, cacheCreationInputUsd: 3.75, cacheReadInputUsd: 0.3, outputUsd: 15 },
  'claude-sonnet-4.5': { inputUsd: 3, cacheCreationInputUsd: 3.75, cacheReadInputUsd: 0.3, outputUsd: 15 },
  'claude-sonnet-4': { inputUsd: 3, cacheCreationInputUsd: 3.75, cacheReadInputUsd: 0.3, outputUsd: 15 },
  'claude-haiku-4.5': { inputUsd: 1, cacheCreationInputUsd: 1.25, cacheReadInputUsd: 0.1, outputUsd: 5 },
  'claude-haiku-3.5': { inputUsd: 0.8, cacheCreationInputUsd: 1, cacheReadInputUsd: 0.08, outputUsd: 4 },
};

const CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4.8',
  opusplan: 'claude-opus-4.8',
  sonnet: 'claude-sonnet-4.6',
  haiku: 'claude-haiku-4.5',
};

const CLAUDE_VERSION_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['claude-fable-5', 'claude-fable-5'],
  ['claude-mythos-5', 'claude-mythos-5'],
  ['claude-opus-4-8', 'claude-opus-4.8'],
  ['claude-opus-4-7', 'claude-opus-4.7'],
  ['claude-opus-4-6', 'claude-opus-4.6'],
  ['claude-opus-4-5', 'claude-opus-4.5'],
  ['claude-opus-4-1', 'claude-opus-4.1'],
  ['claude-sonnet-4-6', 'claude-sonnet-4.6'],
  ['claude-sonnet-4-5', 'claude-sonnet-4.5'],
  ['claude-sonnet-4', 'claude-sonnet-4'],
  ['claude-haiku-4-5', 'claude-haiku-4.5'],
  ['claude-haiku-3-5', 'claude-haiku-3.5'],
];

export function estimateTokenCostUsd(input: EstimateTokenCostInput): TokenCostEstimate | undefined {
  if (!input.usage || input.usage.usageMissing || !input.provider || !input.model) {
    return undefined;
  }

  const resolved = resolvePricing(input.provider, input.model);
  if (!resolved) {
    return undefined;
  }

  const costUsd = calculateCostUsd(input.usage, resolved.price);
  if (costUsd === undefined || costUsd <= 0) {
    return undefined;
  }

  return {
    costUsd,
    model: input.model,
    pricingKey: resolved.pricingKey,
  };
}

function resolvePricing(
  provider: string,
  model: string,
): { pricingKey: string; price: TokenPricePerMillion } | undefined {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = normalizeModelName(model);

  if (normalizedProvider === 'codex' || normalizedProvider === 'codex-cli') {
    const openAiModel = resolveOpenAiModel(normalizedModel);
    const price = openAiModel ? OPENAI_PRICES[openAiModel] : undefined;
    return openAiModel && price ? { pricingKey: `openai:${openAiModel}`, price } : undefined;
  }

  if (
    normalizedProvider === 'claude'
    || normalizedProvider === 'claude-sdk'
    || normalizedProvider === 'claude-terminal'
  ) {
    const anthropicModel = resolveClaudeModel(normalizedModel);
    const price = ANTHROPIC_PRICES[anthropicModel];
    return price ? { pricingKey: `anthropic:${anthropicModel}`, price } : undefined;
  }

  return undefined;
}

function normalizeModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function resolveOpenAiModel(model: string): string | undefined {
  if (OPENAI_PRICES[model]) {
    return model;
  }
  return Object.keys(OPENAI_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((knownModel) => model.startsWith(`${knownModel}-`));
}

function resolveClaudeModel(model: string): string {
  if (CLAUDE_MODEL_ALIASES[model]) {
    return CLAUDE_MODEL_ALIASES[model];
  }
  if (ANTHROPIC_PRICES[model]) {
    return model;
  }
  return CLAUDE_VERSION_PREFIXES.find(([prefix]) => model === prefix || model.startsWith(`${prefix}-`))?.[1] ?? model;
}

function calculateCostUsd(
  usage: TokenUsageForCost,
  price: TokenPricePerMillion,
): number | undefined {
  const inputTokens = positiveTokenCount(usage.inputTokens);
  const outputTokens = positiveTokenCount(usage.outputTokens);
  const cacheCreationTokens = positiveTokenCount(usage.cacheCreationInputTokens);
  const cacheReadTokens = explicitCacheReadTokens(usage);
  const cachedTokens = cacheCreationTokens + cacheReadTokens;
  const uncachedInputTokens = Math.max(inputTokens - cachedTokens, 0);

  const inputCost = uncachedInputTokens * price.inputUsd;
  // Provider usage exposes cache creation without duration, so TAKT estimates
  // Claude cache writes at the 5-minute cache-write rate from the public table.
  const cacheCreationCost = cacheCreationTokens * (price.cacheCreationInputUsd ?? price.cachedInputUsd ?? price.inputUsd);
  const cacheReadCost = cacheReadTokens * (price.cacheReadInputUsd ?? price.cachedInputUsd ?? price.inputUsd);
  const outputCost = outputTokens * price.outputUsd;
  const costUsd = (inputCost + cacheCreationCost + cacheReadCost + outputCost) / TOKENS_PER_MILLION;
  return Number.isFinite(costUsd) && costUsd > 0 ? costUsd : undefined;
}

function explicitCacheReadTokens(usage: TokenUsageForCost): number {
  if (usage.cacheReadInputTokens !== undefined) {
    return positiveTokenCount(usage.cacheReadInputTokens);
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    return 0;
  }
  return positiveTokenCount(usage.cachedInputTokens);
}

function positiveTokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}
