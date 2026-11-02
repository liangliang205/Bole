import { jdAnalysisSchema } from '../schemas.ts';
import { reviewRequirements } from '../tools/fairness.ts';
import type { Ambiguity, JdAnalysis } from '../types.ts';
import type { AgentDeps } from './deps.ts';
import type { HitlResponder } from './hitl.ts';
import { callAgentJson } from './structured-call.ts';
import { sharedPrefix, systemPrompt, taskBook } from './prompts.ts';
import { formatKnowledgeReferences } from '../knowledge/service.ts';
import { writeJson } from '../util/fsx.ts';
import path from 'node:path';

export interface ProfilerInput {
  jobId: string;
  requirements: string;
  hitl: HitlResponder;
}

function normalizeScorecard(analysis: JdAnalysis, deps: AgentDeps): void {
  const dims = analysis.scorecard.dimensions;
  const seen = new Set<string>();
  const unique = dims.filter((dim) => {
    if (seen.has(dim.key)) return false;
    seen.add(dim.key);
    return true;
  });
  if (unique.length !== dims.length) {
    deps.events.emit(deps.jobId, 'profiler', 'scorecard.deduped', {
      removed: dims.length - unique.length,
    });
  }
  analysis.scorecard.dimensions = unique;
  const sum = unique.reduce((total, dim) => total + dim.weight, 0);
  if (Math.abs(sum - 100) > 0.01) {
    for (const dim of unique) dim.weight = Number(((dim.weight / sum) * 100).toFixed(1));
    deps.events.emit(deps.jobId, 'profiler', 'scorecard.normalized', {
      originalSum: sum,
      weights: unique.map((d) => `${d.key}:${d.weight}`),
    });
  }
}

function applyAnswer(analysis: JdAnalysis, ambiguity: Ambiguity, answer: string): void {
  if (ambiguity.id === 'salary') {
    analysis.jd.compensation = /不限/.test(answer) ? '不限（仅作参考）' : answer;
  } else if (ambiguity.id === 'team_scope') {
    analysis.jd.teamContext = answer;
  } else if (ambiguity.id === 'protected_attr') {
    // 无论 HR 选哪个选项，受保护属性都不进入评分维度；此记录仅用于审计
    analysis.fairness.findings.push(`HR 确认：${answer}`);
  }
}

export async function runProfiler(deps: AgentDeps, input: ProfilerInput): Promise<JdAnalysis> {
  deps.events.emit(deps.jobId, 'profiler', 'profiler.started', {
    requirementsChars: input.requirements.length,
  });
  const hits = await deps.knowledge.recall(input.requirements, 3);
  const references = formatKnowledgeReferences(hits, deps.knowledge.publicSettings().maxContextChars).split('\n\n').filter(Boolean);
  if (hits.length > 0) {
    deps.events.emit(deps.jobId, 'profiler', 'knowledge.recalled', {
      agent: 'profiler',
      bases: [...new Set(hits.map((hit) => hit.baseName))],
      hits: hits.map((hit) => `${hit.title}${hit.heading ? ` / ${hit.heading}` : ''}`),
    });
  }
  const user = taskBook({
    task: '把 HR 的自然语言招聘需求结构化为 JD、岗位画像与评分卡，并生成疑点反问清单',
    inputs: { job_id: input.jobId },
    references,
    schemaName: 'jd_analysis',
    completion: '3-6 个评分维度权重合计 100；疑点必须可被 HR 用选项回答；受保护属性条件不得进入评分卡',
  });
  const result = await callAgentJson(deps, {
    agent: 'profiler',
    tier: deps.registry.get('profiler').tier,
    schemaName: 'jd_analysis',
    schema: jdAnalysisSchema,
    system: systemPrompt(deps, 'profiler'),
    user: `${user}\n\n【HR 原始需求】\n${input.requirements}`,
    sharedPrefix: sharedPrefix(deps, 'profiler', [`【检索到的历史 JD/评分卡参考】\n${references.join('\n')}`]),
    stream: deps.stream,
    phase: 'jd_analysis',
    meta: { requirements: input.requirements },
    postValidate: (value) => {
      const issues: string[] = [];
      if (!value.jd.title.trim()) issues.push('jd.title 不能为空');
      if (value.scorecard.dimensions.length < 3) issues.push('评分维度至少 3 个');
      const total = value.scorecard.dimensions.reduce((sum, dim) => sum + dim.weight, 0);
      if (total <= 0) issues.push('评分维度权重必须为正');
      if (value.ambiguities.some((a) => a.options.length === 0)) issues.push('疑点选项不能为空');
      return issues;
    },
  });
  if (!result.ok) {
    deps.events.emit(deps.jobId, 'profiler', 'profiler.failed', { errors: result.errors });
    throw new Error(`画像师输出校验失败：${result.errors.join('；')}`);
  }
  const analysis = result.value as JdAnalysis;

  normalizeScorecard(analysis, deps);

  // 机制兜底：即使模型漏判，确定性规则也会剥离受保护属性条件并追加 HITL 反问
  const deterministic = reviewRequirements(input.requirements);
  for (const removal of deterministic.removed) {
    if (!analysis.fairness.removed.some((r) => r.text === removal.text)) {
      analysis.fairness.removed.push(removal);
    }
  }
  analysis.fairness.findings.push(...deterministic.findings);
  if (deterministic.removed.length > 0 && !analysis.ambiguities.some((a) => a.id === 'protected_attr')) {
    analysis.ambiguities.push({
      id: 'protected_attr',
      question: `需求中包含受保护属性条件（${deterministic.removed.map((r) => r.text).join('；')}），平台已从评分条件中移除。请确认最终不将性别/年龄等纳入筛选。`,
      options: ['确认移除，不纳入筛选（推荐）', '保留原文但仅作人工参考（平台不用于评分）'],
      recommendedOption: '确认移除，不纳入筛选（推荐）',
      blocking: true,
    });
  }

  const blocking = analysis.ambiguities.filter((a) => a.blocking);
  for (const ambiguity of blocking) {
    deps.events.emit(deps.jobId, 'profiler', 'hitl.question', {
      ambiguityId: ambiguity.id,
      question: ambiguity.question,
      options: ambiguity.options,
    });
    const decision = await input.hitl.ask({
      id: ambiguity.id,
      node: 'jd_clarification',
      question: ambiguity.question,
      options: ambiguity.options,
      recommendedOption: ambiguity.recommendedOption,
      blocking: ambiguity.blocking,
    });
    deps.ledger.addDecision({
      jobId: deps.jobId,
      node: 'jd_clarification',
      question: ambiguity.question,
      answer: decision.answer,
      actor: decision.actor,
    });
    deps.events.emit(deps.jobId, 'profiler', 'hitl.answered', {
      ambiguityId: ambiguity.id,
      answer: decision.answer,
      actor: decision.actor,
    });
    applyAnswer(analysis, ambiguity, decision.answer);
  }

  deps.ledger.saveJobAnalysis(deps.jobId, analysis.jd, analysis.scorecard, analysis.jd.title, analysis.fairness);
  deps.ledger.setJobStatus(deps.jobId, 'pipeline');
  const artifact = path.join(deps.runDir, 'artifacts', 'profile', 'jd_analysis.json');
  await writeJson(artifact, {
    jobId: deps.jobId,
    analysis,
    references,
    attempts: result.attempts,
    model: result.chat.model,
    usage: result.chat.usage,
  });
  deps.events.emit(deps.jobId, 'profiler', 'jd.analyzed', {
    title: analysis.jd.title,
    dimensions: analysis.scorecard.dimensions.length,
    ambiguities: analysis.ambiguities.length,
    removedProtected: analysis.fairness.removed.length,
    artifact,
  });
  return analysis;
}
