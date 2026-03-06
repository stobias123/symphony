export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-0-20250514": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-opus-4-6": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-sonnet-4-0-20250514": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-3-7-sonnet-20250219": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-3-5-sonnet-20241022": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-3-5-sonnet-20240620": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-3-5-haiku-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },
};

export function lookupPricing(model: string): ModelPricing | undefined {
  if (PRICING[model]) return PRICING[model];
  // Fuzzy match: find a key that the model string starts with or vice versa
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  return undefined;
}

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export function estimateCost(model: string, tokens: TokenCounts): number {
  const pricing = lookupPricing(model);
  if (!pricing) return 0;

  const input = (tokens.inputTokens ?? 0) * pricing.inputPerMTok;
  const output = (tokens.outputTokens ?? 0) * pricing.outputPerMTok;
  const cacheRead = (tokens.cacheReadTokens ?? 0) * (pricing.cacheReadPerMTok ?? 0);
  const cacheWrite = (tokens.cacheCreateTokens ?? 0) * (pricing.cacheWritePerMTok ?? 0);

  return (input + output + cacheRead + cacheWrite) / 1_000_000;
}
