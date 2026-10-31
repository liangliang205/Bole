import type { LlmUsage } from '../types.ts';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheHitPerMTok: number;
}

export type PricingTable = Record<string, ModelPricing>;

const FALLBACK: ModelPricing = { inputPerMTok: 0.27, outputPerMTok: 1.1, cacheHitPerMTok: 0.07 };

export function pricingFor(model: string, table: PricingTable): ModelPricing {
  return table[model] ?? FALLBACK;
}

export function computeCost(model: string, table: PricingTable, tokens: {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}): number {
  const pricing = pricingFor(model, table);
  const uncached = Math.max(0, tokens.promptTokens - tokens.cachedPromptTokens);
  const cost =
    (uncached / 1_000_000) * pricing.inputPerMTok +
    (tokens.cachedPromptTokens / 1_000_000) * pricing.cacheHitPerMTok +
    (tokens.completionTokens / 1_000_000) * pricing.outputPerMTok;
  return Number(cost.toFixed(8));
}

export function emptyUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, costUsd: 0 };
}
