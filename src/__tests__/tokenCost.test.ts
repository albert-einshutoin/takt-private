import { describe, expect, it } from 'vitest';
import { estimateTokenCostUsd } from '../shared/pricing/tokenCost.js';

describe('token cost estimation', () => {
  it('estimates OpenAI token cost with cached input pricing', () => {
    const estimate = estimateTokenCostUsd({
      provider: 'codex',
      model: 'gpt-5.4',
      usage: {
        usageMissing: false,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 200,
      },
    });

    expect(estimate).toEqual({
      costUsd: 0.0049375,
      model: 'gpt-5.4',
      pricingKey: 'openai:gpt-5.4',
    });
  });

  it('estimates Claude token cost with cache creation and cache read pricing', () => {
    const estimate = estimateTokenCostUsd({
      provider: 'claude-sdk',
      model: 'sonnet',
      usage: {
        usageMissing: false,
        inputTokens: 10_000,
        cacheCreationInputTokens: 1_000,
        cacheReadInputTokens: 3_000,
        cachedInputTokens: 4_000,
        outputTokens: 2_000,
      },
    });

    expect(estimate).toEqual({
      costUsd: 0.05265,
      model: 'sonnet',
      pricingKey: 'anthropic:claude-sonnet-4.6',
    });
  });

  it('normalizes provider-prefixed and versioned model names', () => {
    expect(estimateTokenCostUsd({
      provider: 'codex',
      model: 'openai/gpt-5.4-mini-20260601',
      usage: {
        usageMissing: false,
        inputTokens: 1_000,
      },
    })?.pricingKey).toBe('openai:gpt-5.4-mini');

    expect(estimateTokenCostUsd({
      provider: 'claude-sdk',
      model: 'claude-sonnet-4-5-20250929',
      usage: {
        usageMissing: false,
        outputTokens: 1_000,
      },
    })?.pricingKey).toBe('anthropic:claude-sonnet-4.5');
  });

  it('does not estimate cost when usage or model pricing is unavailable', () => {
    expect(estimateTokenCostUsd({
      provider: 'mock',
      model: 'mock-model',
      usage: {
        usageMissing: false,
        inputTokens: 100,
        outputTokens: 50,
      },
    })).toBeUndefined();

    expect(estimateTokenCostUsd({
      provider: 'codex',
      model: 'gpt-5.4',
      usage: { usageMissing: true, reason: 'not_available' },
    })).toBeUndefined();
  });
});
