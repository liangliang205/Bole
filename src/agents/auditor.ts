import { readFile } from 'node:fs/promises';
import { reviewEvalSchema } from '../schemas.ts';
import { runStructuredTask } from '../core/structured.ts';
import { verifySpan } from '../util/text.ts';
import { reviewRationales } from '../tools/fairness.ts';
import type {
  ClaimCheck,
  Compliance,
  EvalResult,
  ParseResult,
  ResumeRow,
  ReviewResult,
  Verdict,
} from '../types.ts';
import type { AgentDeps } from './deps.ts';
import { sharedPrefix, systemPrompt, taskBook } from './prompts.ts';

export interface ReviewInput {
  resume: ResumeRow;
  parsed: ParseResult;
  evaluation: EvalResult;
  evalTaskId: string;
  batchId: number;
  loopCount: number;
  maxLoops: number;
}

export interface ReviewOutcome {
  ok: boolean;
  taskId: string;
  review?: ReviewResult;
  errors: string[];
}

/** 监军：独立于相马官（不同 preset、不同调用），逐条举证 + 公平性哨兵 + 三态裁决。 */
export class AuditorWorker {
  readonly workerId: string;
  private deps: AgentDeps;

  constructor(deps: AgentDeps, index: number) {
    this.deps = deps;
    this.workerId = `auditor#${index}`;
  }

  private deterministicChecks(text: string, evaluation: EvalResult): ClaimCheck[] {
    const checks: ClaimCheck[] = [];
    for (const dim of evaluation.dimensions) {
      const claim = `${dim.name}：${dim.rationale}`;
      if (dim.spans.length === 0) {
        checks.push({
          claim,
          verdict: 'missing_evidence',
          note: '该维度没有挂任何原文引用（无证据结论）',
        });
        continue;
      }
      for (const span of dim.spans) {
        const verdict = verifySpan(text, span);
        if (!verdict.ok) {
          checks.push({
            claim,
            verdict: 'unsupported',
            note: `引用校验失败：${verdict.reason}（「${span.quote.slice(0, 30)}」）`,
            quote: span.quote,
          });
        }
      }
    }
    return checks;
  }

  async review(input: ReviewInput): Promise<ReviewOutcome> {
    const deps = this.deps;
    const { resume, evaluation, evalTaskId, batchId, loopCount, maxLoops } = input;
    const task = deps.ledger.createTask('review', {
      jobId: deps.jobId,
      resumeId: resume.id,
      batchId,
      workerId: this.workerId,
      extra: { evalTaskId, loopCount },
    });
    const text = await readFile(resume.norm_path ?? '', 'utf8');
    const current = deps.ledger.getResume(resume.id);
    if (current?.status === 'evaluated') deps.ledger.setResumeStatus(resume.id, 'verifying');

    const detChecks = this.deterministicChecks(text, evaluation);
    const fair = reviewRationales(evaluation.dimensions.map((d) => d.rationale));
    const evalDigest = {
      dimensions: evaluation.dimensions.map((dim) => ({
        key: dim.key,
        name: dim.name,
        score: dim.score,
        rationale: dim.rationale,
        spans: dim.spans,
      })),
      totalScore: evaluation.totalScore,
      conclusion: evaluation.conclusion,
    };

    const user = `${taskBook({
      task: '逐条核查评估结论的证据真实性，并执行反歧视合规审查',
      inputs: {
        resume_id: resume.id,
        label: resume.label,
        eval_task_id: evalTaskId,
        loop: `${loopCount}/${maxLoops}`,
      },
      references: [
        `平台确定性预检发现：${detChecks.length === 0 ? '未见引用缺失' : `${detChecks.length} 条疑似问题`}`,
      ],
      schemaName: 'review_eval',
      completion: '每条维度结论一个 verdict（supported/unsupported/missing_evidence）；禁止只输出"整体通过"；re_eval 必须给出可执行的 requiredFixes',
    })}

【待核查评估】${JSON.stringify(evalDigest)}
【简历原文（唯一事实来源）】${text}`;

    deps.events.emit(deps.jobId, 'auditor', 'review.started', {
      resumeId: resume.id,
      label: resume.label,
      taskId: task.id,
      evalTaskId,
      batchId,
      loopCount,
      workerId: this.workerId,
      deterministicIssues: detChecks.length,
    });

    let persisted: ReviewResult | null = null;
    const outcome = await runStructuredTask({
      kind: 'review',
      taskId: task.id,
      jobId: deps.jobId,
      resumeId: resume.id,
      batchId,
      workerId: this.workerId,
      agent: 'auditor',
      tier: deps.registry.get('auditor').tier,
      schemaName: 'review_eval',
      schema: reviewEvalSchema,
      system: systemPrompt(deps, 'auditor'),
      user,
      sharedPrefix: sharedPrefix(deps, 'auditor'),
      runDir: deps.runDir,
      ledger: deps.ledger,
      llm: deps.llm,
      stream: deps.stream,
      phase: 'review',
      label: resume.label,
      meta: {
        resumeId: resume.id,
        label: resume.label,
        text,
        evaluation: evalDigest,
        loopCount,
        maxLoops,
      },
      maxAttempts: deps.config.structuredOutput.maxAttempts,
      postValidate: (value) => {
        const issues: string[] = [];
        if (value.checks.length === 0) issues.push('核查结果必须逐条给出 verdict，不能为空');
        if (value.verdict === 'pass' && value.checks.some((c) => c.verdict !== 'supported')) {
          issues.push('存在未通过的逐条裁决，但整体 verdict 为 pass');
        }
        if (value.verdict === 're_eval' && value.requiredFixes.length === 0) {
          issues.push('re_eval 必须给出可执行的 requiredFixes');
        }
        return issues;
      },
      persist: (value) => {
        const merged = [...value.checks];
        for (const det of detChecks) {
          const duplicate = merged.some(
            (c) => c.claim === det.claim && (c.quote ?? '') === (det.quote ?? ''),
          );
          if (!duplicate) merged.push(det);
        }

        const compliance: Compliance = {
          risk: fair.risk === 'high' ? 'high' : value.compliance.risk,
          findings: [...value.compliance.findings, ...fair.findings.filter((f) => !value.compliance.findings.includes(f))],
        };

        const failed = merged.filter((c) => c.verdict !== 'supported');
        let verdict: Verdict = value.verdict;
        let escalationReason = value.escalationReason ?? '';
        const requiredFixes = [...value.requiredFixes];

        if (compliance.risk === 'high') {
          verdict = 'escalate_human';
          escalationReason ||= '公平性哨兵：评估理由使用了受保护属性，需人工复核';
        } else if (failed.length > 0 && verdict === 'pass') {
          verdict = loopCount >= maxLoops ? 'escalate_human' : 're_eval';
          escalationReason ||= 'LLM 判定通过，但机制层发现未通过证据核对的结论';
        }

        if (verdict === 're_eval' && loopCount >= maxLoops) {
          verdict = 'escalate_human';
          escalationReason ||= `验真环已达上限（${loopCount}/${maxLoops}）`;
        }

        if (verdict === 're_eval' && requiredFixes.length === 0) {
          for (const check of failed) {
            requiredFixes.push(`修正无证据/不成立的结论：「${check.claim.slice(0, 40)}」（${check.note}）`);
          }
        }

        const review: ReviewResult = {
          resumeId: resume.id,
          verdict,
          checks: merged,
          compliance,
          requiredFixes: [...new Set(requiredFixes)],
          ...(verdict === 'escalate_human'
            ? { escalationReason: escalationReason || '核查未通过，需人工介入' }
            : {}),
        };
        deps.ledger.saveReviewResult(task.id, review);
        deps.ledger.setEvidenceVerification(
          resume.id,
          verdict === 'pass' ? 'supported' : 'unsupported',
          verdict === 'pass' ? '核查通过' : review.escalationReason ?? '核查发现未通过项',
        );
        if (verdict === 'pass') deps.ledger.setResumeStatus(resume.id, 'verified');
        else if (verdict === 're_eval') deps.ledger.setResumeStatus(resume.id, 'evaluated');
        else deps.ledger.setResumeStatus(resume.id, 'quarantine', review.escalationReason);
        persisted = review;
      },
    });

    if (!outcome.ok) {
      deps.events.emit(deps.jobId, 'auditor', 'review.failed', {
        resumeId: resume.id,
        label: resume.label,
        taskId: task.id,
        errors: outcome.errors,
        stopReason: outcome.stopReason,
      });
      const current = deps.ledger.getResume(resume.id);
      if (current && current.status === 'verifying') {
        deps.ledger.setResumeStatus(resume.id, 'quarantine', `核查失败：${outcome.errors.join('；')}`);
      }
      return { ok: false, taskId: task.id, errors: outcome.errors };
    }

    const review = persisted!;
    deps.events.emit(deps.jobId, 'auditor', 'review.verdict', {
      resumeId: resume.id,
      label: resume.label,
      taskId: task.id,
      verdict: review.verdict,
      loopCount,
      supported: review.checks.filter((c) => c.verdict === 'supported').length,
      failed: review.checks.filter((c) => c.verdict !== 'supported').length,
      risk: review.compliance.risk,
      escalationReason: review.escalationReason ?? null,
    });
    if (review.verdict === 'escalate_human') {
      deps.events.emit(deps.jobId, 'auditor', 'escalate.human', {
        resumeId: resume.id,
        label: resume.label,
        reason: review.escalationReason,
      });
    }
    return { ok: true, taskId: task.id, review, errors: [] };
  }
}
