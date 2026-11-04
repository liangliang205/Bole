import type { Ledger } from '../core/ledger.ts';
import type { AgentDeps } from '../agents/deps.ts';
import { loadLatestEval, loadLatestReview, loadParseResult } from '../agents/data.ts';
import { rankEvaluations } from '../tools/scorecard.ts';
import { computeCost } from '../llm/cost.ts';
import { maskPII } from '../util/text.ts';
import type {
  Compliance,
  DecisionRow,
  EvalResult,
  InterviewPlan,
  Jd,
  PoolStats,
  Scorecard,
  Verdict,
} from '../types.ts';

export interface RankedCandidate {
  resumeId: string;
  label: string;
  totalScore: number;
  conclusion: string;
  /** 面向 HR 的推荐理由/不推荐说明，来自整体 rationale，缺失时由维度理由兜底。 */
  reason: string;
  batchId: number | null;
  dimensions: { key: string; name: string; weight: number; score: number; rationale: string }[];
}

export interface EvidenceView {
  dimension: string;
  field: string;
  quote: string;
  charStart: number;
  charEnd: number;
  verified: boolean;
  verdict: string;
  rationale: string;
}

export interface CandidateView extends RankedCandidate {
  evidenceChain: EvidenceView[];
  uncertainties: string[];
  redFlags: string[];
  anomalies: string[];
  evalTier: string;
  evalPhase: string;
  interview?: InterviewPlan;
  review: {
    verdict: Verdict;
    loopCount: number;
    compliance: Compliance;
    checks: number;
    supported: number;
  } | null;
  sourceFormat: string;
}

export interface ReportData {
  job: { id: string; title: string; requirements: string; jd: Jd; scorecard: Scorecard };
  run: {
    runId: string;
    status: 'final' | 'draft';
    generatedTs: string;
    durationMs: number;
    provider: string;
    seed: string;
  };
  top: CandidateView[];
  escalations: { label: string; resumeId: string; reason: string; loopCount: number; score: number | null }[];
  others: { label: string; resumeId: string; totalScore: number; conclusion: string; reason: string }[];
  compliance: {
    fairnessRemovals: { text: string; category: string; action: string }[];
    fairnessFindings: string[];
    piiRedaction: string;
    duplicates: { label: string; duplicateOf: string; reason: string }[];
    failed: { label: string; reason: string }[];
    reviewStats: { total: number; pass: number; re_eval: number; escalate: number; vetoRate: number };
    rubberStampWarning: string | null;
  };
  hitl: DecisionRow[];
  cost: {
    byAgent: {
      agent: string;
      model: string;
      tier: string;
      calls: number;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      costUsd: number;
    }[];
    totalCalls: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    costUsd: number;
    baselineCostUsd: number;
    cacheSavingsUsd: number;
    cacheHitRate: number;
    byStage: { stage: string; calls: number; promptTokens: number; completionTokens: number; costUsd: number }[];
  };
  pools: PoolStats[];
  convergence: { round: number; reviews: number; passed: number; rate: number }[];
  eventsCount: number;
  limitations: string[];
}

function reasonFromEvaluation(evaluation: EvalResult): string {
  const overall = evaluation.rationale.map((item) => item.trim()).filter(Boolean).join('；');
  if (overall) return overall;
  const dimensions = [...evaluation.dimensions]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((dimension) => `${dimension.name}：${dimension.rationale}`)
    .filter((item) => !/：\s*$/.test(item));
  return dimensions.join('；') || `综合评分 ${evaluation.totalScore.toFixed(1)}，结论 ${evaluation.conclusion}`;
}

export function selectTopCandidates(ledger: Ledger, jobId: string, topN: number): RankedCandidate[] {
  const resumes = ledger.listResumes(jobId).filter((r) => r.status === 'verified' || r.status === 'reported');
  const ranked: RankedCandidate[] = [];
  for (const resume of resumes) {
    const latest = loadLatestEval(ledger, resume.id);
    if (!latest) continue;
    ranked.push({
      resumeId: resume.id,
      label: resume.label,
      totalScore: latest.evaluation.totalScore,
      conclusion: latest.evaluation.conclusion,
      reason: reasonFromEvaluation(latest.evaluation),
      batchId: resume.batch_id,
      dimensions: latest.evaluation.dimensions.map((dim) => ({
        key: dim.key,
        name: dim.name,
        weight: dim.weight,
        score: dim.score,
        rationale: dim.rationale,
      })),
    });
  }
  return rankEvaluations(ranked)
    .slice(0, topN)
    .map((candidate) => ({
      resumeId: candidate.resumeId,
      label: candidate.label,
      totalScore: candidate.totalScore,
      conclusion: candidate.conclusion,
      reason: candidate.reason,
      batchId: candidate.batchId,
      dimensions: candidate.dimensions,
    }));
}

function evidenceMap(ledger: Ledger, resumeId: string): Map<string, { verified: boolean; verdict: string }> {
  const map = new Map<string, { verified: boolean; verdict: string }>();
  for (const row of ledger.listEvidence(resumeId)) {
    map.set(`${row.char_start}:${row.char_end}`, {
      verified: row.verified === 1,
      verdict: row.verdict ?? (row.verified === 1 ? 'supported' : 'pending'),
    });
  }
  return map;
}

function viewForCandidate(
  ledger: Ledger,
  ranked: RankedCandidate,
  plans: Map<string, InterviewPlan>,
  sourceFormat: string,
): CandidateView {
  const parsed = loadParseResult(ledger, ranked.resumeId);
  const latest = loadLatestEval(ledger, ranked.resumeId);
  const review = loadLatestReview(ledger, ranked.resumeId);
  const evMap = evidenceMap(ledger, ranked.resumeId);
  const evaluation: EvalResult | null = latest?.evaluation ?? null;

  const evidenceChain: EvidenceView[] = [];
  for (const dim of evaluation?.dimensions ?? []) {
    for (const span of dim.spans) {
      const meta = evMap.get(`${span.charStart}:${span.charEnd}`);
      evidenceChain.push({
        dimension: dim.name,
        field: span.field,
        quote: maskPII(span.quote),
        charStart: span.charStart,
        charEnd: span.charEnd,
        verified: meta?.verified ?? false,
        verdict: meta?.verdict ?? 'pending',
        rationale: dim.rationale,
      });
    }
  }

  return {
    ...ranked,
    reason: maskPII(ranked.reason),
    dimensions: ranked.dimensions.map((dim) => ({ ...dim, rationale: maskPII(dim.rationale) })),
    evidenceChain,
    uncertainties: (evaluation?.uncertainties ?? []).map(maskPII),
    redFlags: (evaluation?.redFlags ?? []).map(maskPII),
    anomalies: (parsed?.anomalies ?? []).map(maskPII),
    interview: plans.get(ranked.resumeId)
      ? {
          ...plans.get(ranked.resumeId)!,
          questions: plans.get(ranked.resumeId)!.questions.map((question) => ({
            question: maskPII(question.question),
            target: maskPII(question.target),
            evidenceHint: maskPII(question.evidenceHint),
          })),
          risks: plans.get(ranked.resumeId)!.risks.map(maskPII),
          recommendation: maskPII(plans.get(ranked.resumeId)!.recommendation),
        }
      : undefined,
    evalTier: String(latest?.task.tier ?? 'unknown'),
    evalPhase: String(latest?.task.phase ?? 'screen'),
    review: review
      ? {
          verdict: review.review.verdict,
          loopCount: Number(review.task.loop_count ?? 0),
          compliance: review.review.compliance,
          checks: review.review.checks.length,
          supported: review.review.checks.filter((c) => c.verdict === 'supported').length,
        }
      : null,
    sourceFormat: sourceFormat,
  };
}

export interface BuildReportOptions {
  pools: PoolStats[];
  startedMs: number;
  topN: number;
  interviewPlans: Map<string, InterviewPlan>;
  status: 'final' | 'draft';
}

export async function buildReport(
  deps: AgentDeps,
  analysis: { jd: Jd; scorecard: Scorecard; fairness: { removed: { text: string; category: string; action: string }[]; findings: string[] } },
  opts: BuildReportOptions,
): Promise<ReportData> {
  const job = deps.ledger.getJob(deps.jobId)!;
  const resumes = deps.ledger.listResumes(deps.jobId);
  const top = selectTopCandidates(deps.ledger, deps.jobId, opts.topN);
  const topIds = new Set(top.map((c) => c.resumeId));
  const resumeById = new Map(resumes.map((r) => [r.id, r]));

  const topViews = top.map((candidate) =>
    viewForCandidate(
      deps.ledger,
      candidate,
      opts.interviewPlans,
      resumeById.get(candidate.resumeId)?.format ?? 'unknown',
    ),
  );

  const escalations = resumes
    .filter((r) => r.status === 'quarantine')
    .map((r) => {
      const review = loadLatestReview(deps.ledger, r.id);
      const evaluation = loadLatestEval(deps.ledger, r.id);
      const reasons = JSON.parse(r.reasons_json) as string[];
      return {
        label: r.label,
        resumeId: r.id,
        reason:
          review?.review.escalationReason ??
          reasons[reasons.length - 1] ??
          '核查未通过，转人工',
        loopCount: Number(review?.task.loop_count ?? 0),
        score: evaluation?.evaluation.totalScore ?? null,
      };
    });

  const others = resumes
    .filter((r) => !topIds.has(r.id) && r.status !== 'quarantine' && r.status !== 'failed' && r.status !== 'duplicate')
    .map((r) => {
      const evaluation = loadLatestEval(deps.ledger, r.id);
      return {
        label: r.label,
        resumeId: r.id,
        totalScore: evaluation?.evaluation.totalScore ?? 0,
        conclusion: evaluation?.evaluation.conclusion ?? 'pending',
        reason: evaluation ? '未进入 Top N（分数或证据链不足）' : `流程未完成（${r.status}）`,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  const duplicates = resumes
    .filter((r) => r.status === 'duplicate')
    .map((r) => {
      const reasons = JSON.parse(r.reasons_json) as string[];
      const match = /与\s*([A-Za-z0-9_-]+)\s*的/.exec(reasons.join('；'));
      return {
        label: r.label,
        duplicateOf: match?.[1] ?? '未知',
        reason: reasons[reasons.length - 1] ?? '重复投递',
      };
    });

  const failed = resumes
    .filter((r) => r.status === 'failed')
    .map((r) => {
      const reasons = JSON.parse(r.reasons_json) as string[];
      return { label: r.label, reason: reasons[reasons.length - 1] ?? '接入/解析/评估失败' };
    });

  const reviews = deps.ledger.listTasks('review', { jobId: deps.jobId });
  const pass = reviews.filter((r) => r.verdict === 'pass').length;
  const reEval = reviews.filter((r) => r.verdict === 're_eval').length;
  const escalate = reviews.filter((r) => r.verdict === 'escalate_human').length;
  const totalReviews = reviews.filter((r) => r.verdict).length;
  const vetoRate = totalReviews > 0 ? (reEval + escalate) / totalReviews : 0;

  const calls = deps.llm.calls;
  const usageByAgent = (() => {
    const map = new Map<string, {
      agent: string;
      model: string;
      tier: string;
      calls: number;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      costUsd: number;
    }>();
    for (const call of calls) {
      const key = `${call.agent}|${call.model}|${call.tier}`;
      const entry = map.get(key) ?? {
        agent: call.agent,
        model: call.model,
        tier: call.tier,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
      };
      entry.calls += 1;
      entry.promptTokens += call.promptTokens;
      entry.completionTokens += call.completionTokens;
      entry.cachedTokens += call.cachedPromptTokens;
      entry.costUsd = Number((entry.costUsd + call.costUsd).toFixed(6));
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  })();
  const promptTokens = calls.reduce((sum, c) => sum + c.promptTokens, 0);
  const completionTokens = calls.reduce((sum, c) => sum + c.completionTokens, 0);
  const cachedTokens = calls.reduce((sum, c) => sum + c.cachedPromptTokens, 0);
  const costUsd = Number(calls.reduce((sum, c) => sum + c.costUsd, 0).toFixed(6));
  const baselineCostUsd = Number(
    calls
      .reduce(
        (sum, c) =>
          sum +
          computeCost(c.model, deps.config.pricing, {
            promptTokens: c.promptTokens,
            completionTokens: c.completionTokens,
            cachedPromptTokens: 0,
          }),
        0,
      )
      .toFixed(6),
  );

  const stageMap = new Map<string, { calls: number; promptTokens: number; completionTokens: number; costUsd: number }>();
  for (const call of calls) {
    const stage = `${call.schemaName}@${call.tier}`;
    const entry = stageMap.get(stage) ?? { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
    entry.calls += 1;
    entry.promptTokens += call.promptTokens;
    entry.completionTokens += call.completionTokens;
    entry.costUsd = Number((entry.costUsd + call.costUsd).toFixed(6));
    stageMap.set(stage, entry);
  }

  const convergenceMap = new Map<number, { reviews: number; passed: number }>();
  for (const review of reviews) {
    if (!review.verdict) continue;
    const round = Number(review.loop_count ?? 0);
    const entry = convergenceMap.get(round) ?? { reviews: 0, passed: 0 };
    entry.reviews += 1;
    if (review.verdict === 'pass') entry.passed += 1;
    convergenceMap.set(round, entry);
  }
  const convergence = [...convergenceMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, value]) => ({
      round,
      reviews: value.reviews,
      passed: value.passed,
      rate: value.reviews > 0 ? Number((value.passed / value.reviews).toFixed(3)) : 0,
    }));

  return {
    job: {
      id: job.id,
      title: job.title,
      requirements: job.requirements,
      jd: analysis.jd,
      scorecard: analysis.scorecard,
    },
    run: {
      runId: deps.runId,
      status: opts.status,
      generatedTs: new Date().toISOString(),
      durationMs: Date.now() - opts.startedMs,
      provider: deps.llm.provider.name,
      seed: deps.seed,
    },
    top: topViews,
    escalations,
    others,
    compliance: {
      fairnessRemovals: analysis.fairness.removed,
      fairnessFindings: analysis.fairness.findings,
      piiRedaction:
        '报告与日志中的姓名/手机号/邮箱/身份证号均已脱敏；台账仅保存 PII 哈希；原文仅存于受控运行目录。',
      duplicates,
      failed,
      reviewStats: { total: totalReviews, pass, re_eval: reEval, escalate, vetoRate: Number(vetoRate.toFixed(3)) },
      rubberStampWarning:
        totalReviews > 0 && vetoRate < 0.05
          ? '核查否决率过低（<5%），疑似橡皮图章，请人工抽查核查记录'
          : null,
    },
    hitl: deps.ledger.listDecisions(deps.jobId),
    cost: {
      byAgent: usageByAgent,
      totalCalls: calls.length,
      promptTokens,
      completionTokens,
      cachedTokens,
      costUsd,
      baselineCostUsd,
      cacheSavingsUsd: Number((baselineCostUsd - costUsd).toFixed(6)),
      cacheHitRate: promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(3)) : 0,
      byStage: [...stageMap.entries()].map(([stage, value]) => ({ stage, ...value })),
    },
    pools: opts.pools,
    convergence,
    eventsCount: deps.ledger.countEvents(deps.jobId),
    limitations: [
      '简历来源为 HR 上传（Web/CLI），不支持邮箱 IMAP/Exchange 接入。',
      '检查点恢复为批次/任务粒度；不做事务级崩溃一致性保证。',
      '反歧视合规为规则 + LLM 双检，不构成法律意见；终稿必须 HR 签字确认。',
      'PDF 仅做文本层尽力提取，扫描件与 CID 字体中文 PDF 可能失败（会在失败明细中如实列出）。',
      '模型输出非确定性：温度=0 仍可能有 ±1 分波动；核查/深评可能因 max-tokens 截断失败并进入失败或转人工。',
      '平台只给建议、不做自动录用/淘汰；不含质量基准评测，结论需 HR 复核。',
    ],
  };
}
