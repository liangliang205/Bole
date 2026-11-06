import { readFile } from 'node:fs/promises';
import { deploymentEvidenceIssues } from './evidence-policy.ts';
import { specialistReference } from '../agent-platform/specialist.ts';
import { AgentStore } from '../agent-platform/store.ts';
import { evaluateResumeSchema } from '../schemas.ts';
import { runStructuredTask } from '../core/structured.ts';
import { resolveRawSpans } from '../util/text.ts';
import { applyScorecard, type RatingThresholds } from '../tools/scorecard.ts';
import type {
  DimensionScore,
  EvalPhase,
  EvalResult,
  Jd,
  ModelTier,
  ParseResult,
  ResumeRow,
  ReviewResult,
  Scorecard,
} from '../types.ts';
import type { AgentDeps } from './deps.ts';
import { sharedPrefix, systemPrompt, taskBook } from './prompts.ts';
import { formatKnowledgeReferences } from '../knowledge/service.ts';

export interface AssessorContext {
  jd: Jd;
  scorecard: Scorecard;
  thresholds?: RatingThresholds;
  /** 由画像生成的检索词；有值时只用画像检索，不拼接候选人字段。 */
  knowledgeQuery?: string;
}

export interface AssessInput {
  resume: ResumeRow;
  parsed: ParseResult;
  batchId: number;
  loopIndex: number;
  feedback?: ReviewResult | null;
  revisionOf?: string | null;
  /** 覆盖 preset 档位：flash 初筛 / pro 深评；自环返工沿用被核查那次的档位。 */
  tier?: ModelTier;
  phase?: EvalPhase;
}

export interface AssessResult {
  ok: boolean;
  taskId: string;
  evaluation?: EvalResult;
  errors: string[];
}

/** 相马官：同一实例在 Self-Loop 中被续用（Continue 而非 Spawn），保留上一轮上下文与驳回意见。 */
export class AssessorWorker {
  readonly workerId: string;
  private deps: AgentDeps;
  private ctx: AssessorContext;

  constructor(deps: AgentDeps, index: number, ctx: AssessorContext, role = 'assessor') {
    this.deps = deps;
    this.ctx = ctx;
    this.workerId = `${deps.registry.get('assessor').id}@${deps.registry.get('assessor').version}:${role}#${index}`;
  }

  async evaluate(input: AssessInput): Promise<AssessResult> {
    const deps = this.deps;
    const { resume, parsed, batchId, loopIndex, feedback, revisionOf } = input;
    const tier = input.tier ?? deps.registry.get('assessor').tier;
    const phase: EvalPhase = input.phase ?? (loopIndex > 0 ? 'revise' : 'screen');
    const task = deps.ledger.createTask('eval', {
      jobId: deps.jobId,
      resumeId: resume.id,
      batchId,
      workerId: this.workerId,
      revisionOf: revisionOf ?? undefined,
      feedback: feedback ?? undefined,
      tier,
      phase,
    });
    const text = await readFile(resume.norm_path ?? '', 'utf8');
    const current = deps.ledger.getResume(resume.id);
    if (current && (current.status === 'parsed' || current.status === 'evaluated')) {
      deps.ledger.setResumeStatus(resume.id, 'evaluating');
    }

    const ragQuery = this.ctx.knowledgeQuery?.trim() || [
      this.ctx.jd.title,
      ...this.ctx.jd.hardRequirements,
      ...this.ctx.jd.niceToHave,
    ].join(' ');
    const definition = new AgentStore(deps.ledger).manifest(deps.jobId)?.bindings.assessor.definition;
    const accessRoles = definition?.knowledge.accessRoles ?? ['assessor'];
    const hits = (await Promise.all(accessRoles.map((role) => deps.knowledge.recall(ragQuery, 4, role)))).flat();
    const references = formatKnowledgeReferences(hits, Math.min(deps.knowledge.publicSettings().maxContextChars, definition?.knowledge.maxContextChars ?? 4000)).split('\n\n').filter(Boolean);
    if (hits.length > 0) {
      deps.events.emit(deps.jobId, 'assessor', 'knowledge.recalled', {
        agent: 'assessor',
        resumeId: resume.id,
        label: resume.label,
        query: ragQuery,
        bases: [...new Set(hits.map((hit) => hit.baseName))],
        hits: hits.map((hit) => `${hit.title}${hit.heading ? ` / ${hit.heading}` : ''}`),
      });
    }
    const feedbackText =
      feedback && feedback.verdict !== 'pass'
        ? `\n\n【上一轮核查驳回】\n${feedback.requiredFixes.map((fix) => `- ${fix}`).join('\n')}\n驳回明细：${JSON.stringify(feedback.checks.filter((c) => c.verdict !== 'supported'))}`
        : '';

    const parsedDigest = Object.entries(parsed.fields).map(([key, field]) => ({
      field: key,
      value: field.value,
      evidence: field.spans.map((span) => span.quote),
    }));

    const user = `${taskBook({
      task:
        phase === 'deep'
          ? '对初筛短名单做深度评估（pro 档）：逐维度复核证据强度与评分锚点'
          : loopIndex > 0
            ? '按监军驳回意见逐条修正评估结论（保留未被驳回部分）'
            : '按评分卡与岗位知识做初筛评估（flash 档）',
      inputs: {
        resume_id: resume.id,
        label: resume.label,
        batch_id: String(batchId),
        loop_index: String(loopIndex),
        eval_task: task.id,
        phase,
        tier,
      },
      references,
      schemaName: 'evaluate_resume',
      completion: '覆盖评分卡全部维度；每个维度 1-5 分并至少 1 条可定位原文引用；无证据结论必须降级到 uncertainties',
    })}${feedbackText}

【评分卡】${JSON.stringify(this.ctx.scorecard)}
【岗位 JD】${JSON.stringify(this.ctx.jd)}
【解析结果（含原文引用）】${JSON.stringify(parsedDigest)}`;

    deps.events.emit(deps.jobId, 'assessor', 'eval.started', {
      resumeId: resume.id,
      label: resume.label,
      taskId: task.id,
      batchId,
      loopIndex,
      workerId: this.workerId,
      tier,
      phase,
      revisionOf: revisionOf ?? null,
    });

    let persisted: EvalResult | null = null;
    const finalEval = (): EvalResult | null => persisted;

    const outcome = await runStructuredTask({
      kind: 'eval',
      taskId: task.id,
      jobId: deps.jobId,
      resumeId: resume.id,
      batchId,
      workerId: this.workerId,
      agent: 'assessor',
      tier,
      schemaName: 'evaluate_resume',
      schema: evaluateResumeSchema,
      system: systemPrompt(deps, 'assessor'),
      user: user + specialistReference(deps, resume.id),
      sharedPrefix: sharedPrefix(deps, 'assessor', [
        `【评分卡】${JSON.stringify(this.ctx.scorecard)}`,
        `【岗位 JD】${JSON.stringify(this.ctx.jd)}`,
      ]),
      runDir: deps.runDir,
      ledger: deps.ledger,
      llm: deps.llm,
      stream: deps.stream,
      phase,
      label: resume.label,
      meta: {
        resumeId: resume.id,
        label: resume.label,
        text,
        parsed: { fields: parsed.fields, anomalies: parsed.anomalies },
        jd: this.ctx.jd,
        scorecard: this.ctx.scorecard,
        loopIndex,
        feedback: feedback ? { checks: feedback.checks, requiredFixes: feedback.requiredFixes } : null,
      },
      maxAttempts: deps.config.structuredOutput.maxAttempts,
      postValidate: (value) => {
        const issues: string[] = [];
        issues.push(...deploymentEvidenceIssues(text, [...value.rationale, ...value.dimensions.map((d) => d.rationale)]));
        const expected = new Set(this.ctx.scorecard.dimensions.map((d) => d.key));
        const got = new Set(value.dimensions.map((d) => d.key));
        for (const key of expected) if (!got.has(key)) issues.push(`缺少评分卡维度：${key}`);
        for (const key of got) if (!expected.has(key)) issues.push(`出现评分卡之外的新维度：${key}`);
        if (value.dimensions.length < 3) issues.push('评估维度至少 3 个');
        for (const dim of value.dimensions) {
          const resolved = resolveRawSpans(text, dim.evidence, dim.key);
          if (resolved.errors.length > 0) issues.push(`维度 ${dim.key}：${resolved.errors.join('；')}`);
        }
        return issues;
      },
      persist: (value) => {
        const dimensions: DimensionScore[] = value.dimensions.map((dim) => {
          const scorecardDim = this.ctx.scorecard.dimensions.find((d) => d.key === dim.key);
          const resolved = resolveRawSpans(text, dim.evidence, dim.key);
          return {
            key: dim.key,
            name: dim.name || scorecardDim?.name || dim.key,
            weight: scorecardDim?.weight ?? 100 / value.dimensions.length,
            score: dim.score,
            rationale: dim.rationale,
            spans: resolved.spans,
          };
        });
        const { totalScore, conclusion } = applyScorecard(dimensions, this.ctx.thresholds);
        const evaluation: EvalResult = {
          resumeId: resume.id,
          dimensions,
          totalScore,
          conclusion,
          rationale: value.rationale,
          uncertainties: value.uncertainties,
          redFlags: value.redFlags,
          revisionNotes: value.revisionNotes,
        };
        for (const dim of dimensions) {
          for (const span of dim.spans) {
            deps.ledger.addEvidence({
              jobId: deps.jobId,
              resumeId: resume.id,
              parseTaskId: '',
              field: span.field,
              quote: span.quote,
              charStart: span.charStart,
              charEnd: span.charEnd,
            });
          }
        }
        deps.ledger.saveEvalResult(task.id, evaluation);
        deps.ledger.setResumeStatus(resume.id, 'evaluated');
        persisted = evaluation;
      },
    });

    if (!outcome.ok) {
      deps.events.emit(deps.jobId, 'assessor', 'eval.failed', {
        resumeId: resume.id,
        label: resume.label,
        taskId: task.id,
        errors: outcome.errors,
        stopReason: outcome.stopReason,
      });
      deps.ledger.setResumeStatus(resume.id, 'failed', `评估失败：${outcome.errors.join('；')}`);
      return { ok: false, taskId: task.id, errors: outcome.errors };
    }

    deps.events.emit(deps.jobId, 'assessor', 'eval.committed', {
      resumeId: resume.id,
      label: resume.label,
      taskId: task.id,
      totalScore: finalEval()?.totalScore,
      conclusion: finalEval()?.conclusion,
      loopIndex,
      tier,
      phase,
      attempts: outcome.attempts,
    });
    return { ok: true, taskId: task.id, evaluation: finalEval() ?? undefined, errors: [] };
  }

  /** Self-Loop：续用同一个 Worker，携带错误上下文与驳回理由重做，而不是新起一个 Agent。 */
  async revise(input: AssessInput): Promise<AssessResult> {
    this.deps.events.emit(this.deps.jobId, 'assessor', 'worker.reused', {
      workerId: this.workerId,
      resumeId: input.resume.id,
      label: input.resume.label,
      loopIndex: input.loopIndex,
      revisionOf: input.revisionOf,
    });
    return this.evaluate(input);
  }
}
