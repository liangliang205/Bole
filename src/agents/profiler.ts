import { roleKnowledge } from './knowledge.ts';
import { MemoryService } from '../memory/service.ts';
import type { PolicyProfile } from '../memory/types.ts';
import { jdAnalysisSchema } from '../schemas.ts';
import { reviewRequirements } from '../tools/fairness.ts';
import type { Ambiguity, JdAnalysis } from '../types.ts';
import type { AgentDeps } from './deps.ts';
import type { HitlResponder } from './hitl.ts';
import { callAgentJson } from './structured-call.ts';
import { sharedPrefix, systemPrompt, taskBook } from './prompts.ts';
import { writeJson } from '../util/fsx.ts';
import path from 'node:path';

/** 画像检索词：用已确认的 JD + 评分卡去知识库检索，而不是把知识库内容整段注入。 */
export function buildProfileSearchQuery(analysis: Pick<JdAnalysis, 'jd' | 'scorecard'>): string {
  const dimensions = analysis.scorecard.dimensions.map((dimension) => {
    const anchors = Object.values(dimension.anchors ?? {}).filter(Boolean).join(' ');
    return `${dimension.name} ${anchors}`.trim();
  });
  return [
    `岗位：${analysis.jd.title}`,
    analysis.jd.teamContext,
    ...analysis.jd.responsibilities,
    ...analysis.jd.hardRequirements,
    ...analysis.jd.niceToHave,
    ...dimensions,
  ].filter((value) => String(value ?? '').trim()).join('\n');
}

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
  const user = taskBook({
    task: '把 HR 的自然语言招聘需求结构化为 JD、岗位画像与评分卡，并生成疑点反问清单',
    inputs: { job_id: input.jobId },
    schemaName: 'jd_analysis',
    completion: '3-6 个评分维度权重合计 100；疑点必须可被 HR 用选项回答；受保护属性条件不得进入评分卡',
  });
  const result = await callAgentJson(deps, {
    agent: 'profiler',
    tier: deps.registry.get('profiler').tier,
    schemaName: 'jd_analysis',
    schema: jdAnalysisSchema,
    system: systemPrompt(deps, 'profiler'),
    user: `${user}\n\n【HR 原始需求】\n${input.requirements}${await roleKnowledge(deps, 'profiler', input.requirements)}`,
    sharedPrefix: sharedPrefix(deps, 'profiler'),
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

  const memory = new MemoryService(deps.ledger);
  const selected = memory.selectedPolicy(deps.jobId);
  let boundVersion: string | null = null;
  let thresholds = deps.config.conclusionScale;
  if (selected) {
    if (!memory.recallPolicies(selected.family_id).some((v) => v.id === selected.id)) throw new Error('所选评分标准已退役或失效，请重新选择');
    const profile = JSON.parse(selected.profile_json) as PolicyProfile;
    const decision = await input.hitl.ask({ id: 'reuse_policy', node: 'policy_selection', blocking: true,
      question: `当前岗位：${analysis.jd.title}；参考岗位：${profile.jd.title}。是否采用评分标准 v${selected.version}？\n当前：${JSON.stringify(analysis.scorecard.dimensions)}\n参考：${JSON.stringify(profile.scorecard.dimensions)}\n岗位要求以本次确认的 JD 为准。`,
      options: ['采用所选评分标准', '使用本次生成的评分标准'], recommendedOption: '使用本次生成的评分标准' });
    if (decision.answer === '采用所选评分标准' && !/auto/i.test(decision.actor)) {
      analysis.scorecard = profile.scorecard;
      boundVersion = selected.id;
      thresholds = { ...(profile.thresholds ?? deps.config.conclusionScale) };
    }
    deps.ledger.addDecision({ jobId: deps.jobId, node: 'policy_selection', question: `评分标准 ${selected.id}`, ...decision });
  }
  deps.ledger.saveJobAnalysis(deps.jobId, analysis.jd, analysis.scorecard, analysis.jd.title, analysis.fairness);
  memory.bindJob(deps.jobId, { jd: analysis.jd, scorecard: analysis.scorecard, thresholds: thresholds as unknown as import('../tools/scorecard.ts').RatingThresholds }, boundVersion);
  deps.ledger.setJobStatus(deps.jobId, 'pipeline');
  const artifact = path.join(deps.runDir, 'artifacts', 'profile', 'jd_analysis.json');
  await writeJson(artifact, {
    jobId: deps.jobId,
    analysis,
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
