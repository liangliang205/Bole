import type { Conclusion } from '../types.ts';

export interface RawDimension {
  key: string;
  name?: string;
  weight?: number;
  score: number;
  rationale: string;
  evidence: { field: string; quote: string }[];
}

export interface RatingThresholds {
  strong_yes: number;
  yes: number;
  maybe: number;
  no: number;
}

export const DEFAULT_THRESHOLDS: RatingThresholds = {
  strong_yes: 85,
  yes: 72,
  maybe: 60,
  no: 45,
};

export function conclusionFor(score: number, thresholds: RatingThresholds = DEFAULT_THRESHOLDS): Conclusion {
  if (score >= thresholds.strong_yes) return 'strong_yes';
  if (score >= thresholds.yes) return 'yes';
  if (score >= thresholds.maybe) return 'maybe';
  if (score >= thresholds.no) return 'no';
  return 'strong_no';
}

export function roundHalf(value: number): number {
  return Math.round(Math.min(5, Math.max(0, value)) * 2) / 2;
}

/**
 * 确定性评分卡计算：权重归一化 + 总分重算 + 结论映射全部由代码完成。
 * LLM 只做语义打分，不做算术——避免"总分幻觉"。
 */
export function applyScorecard(
  dimensions: { key: string; name: string; weight: number; score: number; rationale: string; spans: unknown }[],
  thresholds: RatingThresholds = DEFAULT_THRESHOLDS,
): { totalScore: number; conclusion: Conclusion; weightsNormalized: boolean } {
  const weightSum = dimensions.reduce((sum, d) => sum + Math.max(0, d.weight), 0);
  const weightsNormalized = weightSum > 0 && Math.abs(weightSum - 100) > 0.01;
  const total = dimensions.reduce((sum, d) => {
    const weight = weightSum > 0 ? (Math.max(0, d.weight) / weightSum) * 100 : 100 / dimensions.length;
    return sum + weight * (Math.min(5, Math.max(0, d.score)) / 5);
  }, 0);
  const totalScore = Number(total.toFixed(1));
  return { totalScore, conclusion: conclusionFor(totalScore, thresholds), weightsNormalized };
}

export function scoreOf(evaluation: { dimensions: { key: string; score: number }[] }, key: string): number {
  return evaluation.dimensions.find((d) => d.key === key)?.score ?? 0;
}

export interface RankableEvaluation {
  resumeId: string;
  totalScore: number;
  dimensions: { key: string; score: number }[];
}

/** 排序：总分 → 技术栈 → 年限 → 项目复杂度（与 coordinator 提示词一致）。 */
export function rankEvaluations<T extends RankableEvaluation>(evaluations: T[]): T[] {
  return [...evaluations].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const tech = scoreOf(b, 'tech_stack') - scoreOf(a, 'tech_stack');
    if (tech !== 0) return tech;
    const years = scoreOf(b, 'years_experience') - scoreOf(a, 'years_experience');
    if (years !== 0) return years;
    return scoreOf(b, 'project_complexity') - scoreOf(a, 'project_complexity');
  });
}
