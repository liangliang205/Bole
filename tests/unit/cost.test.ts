import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, isPeakUtc } from '../../src/llm/cost.ts';

const table = {
  'deepseek-flash': { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheHitPerMTok: 0.006, offPeakMultiplier: 0.5 },
  'deepseek-v4-pro': { inputPerMTok: 1.32, outputPerMTok: 3.96, cacheHitPerMTok: 0.044, offPeakMultiplier: 0.5 },
};
const tokens = { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedPromptTokens: 0 };

test('峰谷时段判断：工作日 UTC 01-04 / 06-10 为 peak，周末 off-peak', () => {
  assert.equal(isPeakUtc(new Date('2026-10-26T02:00:00Z')), true); // Monday
  assert.equal(isPeakUtc(new Date('2026-10-26T07:00:00Z')), true);
  assert.equal(isPeakUtc(new Date('2026-10-26T05:00:00Z')), false);
  assert.equal(isPeakUtc(new Date('2026-10-31T02:00:00Z')), false); // Saturday
});

test('成本按官方 peak 价与 off-peak 五折计算', () => {
  const peak = computeCost('deepseek-flash', table, tokens, new Date('2026-10-26T02:00:00Z'));
  const offPeak = computeCost('deepseek-flash', table, tokens, new Date('2026-10-31T02:00:00Z'));
  assert.equal(peak, Number((0.3 + 1.2).toFixed(8)));
  assert.equal(offPeak, Number(((0.3 + 1.2) * 0.5).toFixed(8)));
  const pro = computeCost('deepseek-v4-pro', table, tokens, new Date('2026-10-26T02:00:00Z'));
  assert.equal(pro, Number((1.32 + 3.96).toFixed(8)));
});

test('缓存命中按 cacheHit 单价计费', () => {
  const cost = computeCost('deepseek-flash', table, {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedPromptTokens: 1_000_000,
  }, new Date('2026-10-26T02:00:00Z'));
  assert.equal(cost, 0.006);
});
