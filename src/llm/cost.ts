import type { LlmUsage } from '../types.ts';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheHitPerMTok: number;
  /** 官方 off-peak 价格相对 peak 的倍率；省略视为 1（不分峰谷）。 */
  offPeakMultiplier?: number;
}

export type PricingTable = Record<string, ModelPricing>;

const FALLBACK: ModelPricing = { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheHitPerMTok: 0.006 };

/** DeepSeek 官方峰谷时段：UTC 周一至周五 01:00–04:00、06:00–10:00；不含中国法定节假日。 */
export function isPeakUtc(at = new Date()): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function pricingFor(model: string, table: PricingTable): ModelPricing {
  return table[model] ?? FALLBACK;
}

export function computeCost(model: string, table: PricingTable, tokens: {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}, at = new Date()): number {
  const pricing = pricingFor(model, table);
  const uncached = Math.max(0, tokens.promptTokens - tokens.cachedPromptTokens);
  const multiplier = pricing.offPeakMultiplier !== undefined && !isPeakUtc(at) ? pricing.offPeakMultiplier : 1;
  const cost =
    ((uncached / 1_000_000) * pricing.inputPerMTok +
      (tokens.cachedPromptTokens / 1_000_000) * pricing.cacheHitPerMTok +
      (tokens.completionTokens / 1_000_000) * pricing.outputPerMTok) * multiplier;
  return Number(cost.toFixed(8));
}

export function emptyUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, costUsd: 0 };
}
