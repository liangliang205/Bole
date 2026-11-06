import { readFile } from 'node:fs/promises';
import { roleKnowledge } from './knowledge.ts';
import { optionalMissingAnomaly } from './evidence-policy.ts';
import path from 'node:path';
import { parseResumeSchema } from '../schemas.ts';
import { runStructuredTask } from '../core/structured.ts';
import { resolveRawSpans } from '../util/text.ts';
import type { ParseResult, ResumeRow, Span } from '../types.ts';
import type { AgentDeps } from './deps.ts';
import { sharedPrefix, systemPrompt, taskBook } from './prompts.ts';

const FIELD_HINT =
  'name, contact, education, major, years_experience, skills, work_history, projects, expected_salary';

export class ParserWorker {
  readonly workerId: string;
  private deps: AgentDeps;

  constructor(deps: AgentDeps, index: number) {
    this.deps = deps;
    this.workerId = `${deps.registry.get('parser').id}@${deps.registry.get('parser').version}#${index}`;
  }

  async parse(input: { resume: ResumeRow; batchId: number }): Promise<{
    ok: boolean;
    taskId: string;
    result?: ParseResult;
    errors: string[];
  }> {
    const { resume, batchId } = input;
    const deps = this.deps;
    const task = deps.ledger.createTask('parse', {
      jobId: deps.jobId,
      resumeId: resume.id,
      batchId,
      workerId: this.workerId,
    });
    const text = await readFile(resume.norm_path ?? '', 'utf8');

    if (resume.status === 'queued') deps.ledger.setResumeStatus(resume.id, 'parsing');
    deps.events.emit(deps.jobId, 'parser', 'parse.started', {
      resumeId: resume.id,
      label: resume.label,
      batchId,
      taskId: task.id,
      workerId: this.workerId,
    });

    const user = `${taskBook({
      task: '解析单份简历，输出结构化字段 + 证据 span',
      inputs: {
        resume_id: resume.id,
        label: resume.label,
        norm_path: resume.norm_path ?? '',
        batch_id: String(batchId),
      },
      schemaName: 'parse_resume',
      completion: `字段至少覆盖 ${FIELD_HINT} 中的主要项；每个非空字段至少 1 条逐字引用，可在原文定位`,
    })}\n\n【岗位要求：仅用于判断缺失信息是否重要，不得修改简历事实】\n${deps.ledger.getJob(deps.jobId)?.requirements ?? ''}\n\n【简历原文（唯一事实来源）】\n${text}`;

    let persisted: ParseResult | null = null;
    const outcome = await runStructuredTask({
      kind: 'parse',
      taskId: task.id,
      jobId: deps.jobId,
      resumeId: resume.id,
      batchId,
      workerId: this.workerId,
      agent: 'parser',
      tier: deps.registry.get('parser').tier,
      schemaName: 'parse_resume',
      schema: parseResumeSchema,
      system: systemPrompt(deps, 'parser'),
      user: user + await roleKnowledge(deps, 'parser', deps.ledger.getJob(deps.jobId)?.requirements ?? ''),
      sharedPrefix: sharedPrefix(deps, 'parser', [`【字段清单】${FIELD_HINT}`]),
      runDir: deps.runDir,
      ledger: deps.ledger,
      llm: deps.llm,
      stream: deps.stream,
      phase: 'parse',
      label: resume.label,
      meta: { resumeId: resume.id, label: resume.label, text },
      maxAttempts: deps.config.structuredOutput.maxAttempts,
      postValidate: (value) => {
        const issues: string[] = [];
        const keys = Object.keys(value.fields);
        if (keys.length < 3) issues.push(`解析字段过少（${keys.length} 个），至少需要 3 个字段`);
        for (const [key, field] of Object.entries(value.fields)) {
          if (field.value.trim().length === 0) continue;
          if (field.spans.length === 0) {
            issues.push(`字段 ${key} 有值但缺少证据引用`);
            continue;
          }
          const resolved = resolveRawSpans(text, field.spans, key);
          if (resolved.errors.length > 0) {
            issues.push(`字段 ${key}：${resolved.errors.join('；')}`);
          }
        }
        return issues;
      },
      persist: (value) => {
        const fields: ParseResult['fields'] = {};
        for (const [key, field] of Object.entries(value.fields)) {
          const resolved = resolveRawSpans(text, field.spans, key);
          const spans: Span[] = resolved.spans;
          fields[key] = {
            value: field.value,
            confidence: field.confidence,
            spans,
          };
          for (const span of spans) {
            deps.ledger.addEvidence({
              jobId: deps.jobId,
              resumeId: resume.id,
              parseTaskId: task.id,
              field: key,
              quote: span.quote,
              charStart: span.charStart,
              charEnd: span.charEnd,
            });
          }
        }
        const result: ParseResult = {
          resumeId: resume.id,
          fields,
          anomalies: value.anomalies.flatMap((a) => a.split(/[；;]/)).filter((a) => a.trim() && !optionalMissingAnomaly(a, deps.ledger.getJob(deps.jobId)?.requirements ?? '')),
          summary: value.summary,
        };
        deps.ledger.saveParseResult(task.id, result);
        deps.ledger.setResumeStatus(resume.id, 'parsed');
        persisted = result;
      },
    });

    if (!outcome.ok) {
      deps.events.emit(deps.jobId, 'parser', 'parse.failed', {
        resumeId: resume.id,
        label: resume.label,
        taskId: task.id,
        errors: outcome.errors,
        stopReason: outcome.stopReason,
        attempts: outcome.attempts,
      });
      const current = deps.ledger.getResume(resume.id);
      if (current && current.status !== 'failed') {
        deps.ledger.setResumeStatus(resume.id, 'failed', `解析失败：${outcome.errors.join('；')}`);
      }
      return { ok: false, taskId: task.id, errors: outcome.errors };
    }

    // 从落盘结果读取，确保主流程只消费"已提交产物"而不是内存对象
    const committed = deps.ledger.getTask('parse', task.id);
    deps.events.emit(deps.jobId, 'parser', 'parse.committed', {
      resumeId: resume.id,
      label: resume.label,
      taskId: task.id,
      fields: Object.keys(outcome.value.fields).length,
      anomalies: outcome.value.anomalies,
      artifact: path.basename(committed?.result_path ?? ''),
      attempts: outcome.attempts,
    });
    return { ok: true, taskId: task.id, result: persisted ?? undefined, errors: [] };
  }
}
