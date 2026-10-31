import path from 'node:path';
import { writeJson } from '../util/fsx.ts';
import { interviewPlanSchema } from '../schemas.ts';
import type { EvalResult, InterviewPlan, Jd, ParseResult, ResumeRow } from '../types.ts';
import type { AgentDeps } from './deps.ts';
import { callAgentJson } from './structured-call.ts';
import { sharedPrefix, systemPrompt, taskBook } from './prompts.ts';

export interface AdvisorInput {
  resume: ResumeRow;
  parsed: ParseResult;
  evaluation: EvalResult;
  jd: Jd;
}

function fallbackPlan(resume: ResumeRow, evaluation: EvalResult): InterviewPlan {
  const weakest = [...evaluation.dimensions].sort((a, b) => a.score - b.score)[0];
  const quote = weakest?.spans[0]?.quote ?? '';
  return {
    resumeId: resume.id,
    questions: [
      {
        question: quote
          ? `简历提到「${quote.slice(0, 50)}」，请说明你在这个项目中的具体职责与个人产出。`
          : '请介绍一个最能体现你技术判断力的项目，并说明你如何验证效果。',
        target: weakest?.name ?? '综合',
        evidenceHint: quote.slice(0, 80),
      },
    ],
    risks: weakest ? [`${weakest.name}维度证据偏弱（${weakest.score} 分）`] : [],
    recommendation: '建议进入技术面，重点验证薄弱维度',
  };
}

/** 谋士：为核查通过的候选人生成面试问题、风险与用人建议。失败时降级为确定性模板，不阻塞报告。 */
export async function runAdvisor(deps: AgentDeps, input: AdvisorInput): Promise<InterviewPlan> {
  const { resume, parsed, evaluation, jd } = input;
  const ragQuery = `${jd.title} 面试 追问 验证 ${evaluation.dimensions.map((d) => d.name).join(' ')}`;
  const hits = deps.rag.search(ragQuery, 3);
  const references = hits.map((hit) => `${hit.title} / ${hit.heading}：${hit.text.slice(0, 160)}`);
  const user = `${taskBook({
    task: '为核查通过的候选人生成针对性面试问题、风险提示与用人建议',
    inputs: { resume_id: resume.id, label: resume.label, total_score: String(evaluation.totalScore) },
    references,
    schemaName: 'interview_plan',
    completion: '4-6 个针对真实证据的追问；风险提示不得做人身评价；不得使用受保护属性',
  })}

【评估结论】${JSON.stringify({
    totalScore: evaluation.totalScore,
    conclusion: evaluation.conclusion,
    dimensions: evaluation.dimensions.map((dim) => ({
      key: dim.key,
      name: dim.name,
      score: dim.score,
      rationale: dim.rationale,
      evidence: dim.spans.map((span) => span.quote),
    })),
    uncertainties: evaluation.uncertainties,
  })}
【候选人摘要】${parsed.summary}`;

  const result = await callAgentJson(deps, {
    agent: 'advisor',
    tier: deps.registry.get('advisor').tier,
    schemaName: 'interview_plan',
    schema: interviewPlanSchema,
    system: systemPrompt(deps, 'advisor'),
    user,
    sharedPrefix: sharedPrefix(deps, 'advisor', [`【岗位】${JSON.stringify(jd)}`]),
    stream: deps.stream,
    phase: 'interview_plan',
    label: resume.label,
    resumeId: resume.id,
    meta: { resumeId: resume.id, label: resume.label, evaluation, jd },
  });

  if (!result.ok) {
    deps.events.emit(deps.jobId, 'advisor', 'advisor.failed', {
      resumeId: resume.id,
      errors: result.errors,
      fallback: true,
    });
    return fallbackPlan(resume, evaluation);
  }

  const plan = result.value as InterviewPlan;
  await writeJson(path.join(deps.runDir, 'artifacts', 'advisor', `${resume.id}.json`), {
    resumeId: resume.id,
    plan,
    attempts: result.attempts,
    model: result.chat.model,
  });
  deps.events.emit(deps.jobId, 'advisor', 'interview.generated', {
    resumeId: resume.id,
    label: resume.label,
    questions: plan.questions.length,
  });
  return plan;
}
