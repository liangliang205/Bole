import path from 'node:path';
import type { ZodType } from 'zod';
import { writeJson } from '../util/fsx.ts';
import { nowIso } from '../util/time.ts';
import type { ChatResult, StopReason, TaskKind, ModelTier } from '../types.ts';
import type { Ledger } from './ledger.ts';
import type { LlmRouter } from '../llm/router.ts';

export interface StructuredTaskOptions<T> {
  kind: TaskKind;
  taskId: string;
  jobId: string;
  resumeId: string;
  batchId: number;
  workerId: string;
  agent: string;
  tier: ModelTier;
  schemaName: string;
  schema: ZodType<T>;
  system: string;
  user: string;
  sharedPrefix?: string;
  runDir: string;
  meta?: Record<string, unknown>;
  maxAttempts?: number;
  temperature?: number;
  maxTokens?: number;
  ledger: Ledger;
  llm: LlmRouter;
  /** schema 之外的确定性校验（例如引文必须能在原文定位）。 */
  postValidate?: (value: T) => string[];
  /** staged 之后、commit 之前写入业务字段（仍在 staged 状态，可被审计）。 */
  persist?: (value: T) => void;
}

export type StructuredOutcome<T> =
  | { ok: true; value: T; attempts: number; artifactPath: string; chat: ChatResult }
  | { ok: false; stopReason: StopReason; errors: string[]; attempts: number };

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}：${issue.message}`);
}

/**
 * 结构化输出两阶段提交：
 *   running → 模型输出 → schema 校验 → 落盘 → staged → commit（提交后单调锁定）
 * 校验失败同轮退回模型重试（≤maxAttempts），错误信息回喂，而不是外包给"再跑一遍"。
 */
export async function runStructuredTask<T>(opts: StructuredTaskOptions<T>): Promise<StructuredOutcome<T>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let errors: string[] = [];
  let attempts = 0;

  opts.ledger.transitionTask(opts.kind, opts.taskId, 'running', {
    worker_id: opts.workerId,
    attempt: 0,
  });

  for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const retryContext =
      errors.length > 0
        ? `\n\n【上一次输出未通过校验，请修正】\n${errors.join('\n')}\n只输出修正后的完整 JSON。`
        : '';
    let chat: ChatResult;
    try {
      chat = await opts.llm.chat({
        agent: opts.agent,
        tier: opts.tier,
        schemaName: opts.schemaName,
        system: opts.system,
        user: `${opts.user}${retryContext}`,
        sharedPrefix: opts.sharedPrefix,
        temperature: opts.temperature ?? 0,
        maxTokens: opts.maxTokens ?? 4096,
        meta: { ...(opts.meta ?? {}), key: opts.taskId, taskId: opts.taskId, jobId: opts.jobId, resumeId: opts.resumeId, batchId: opts.batchId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors = [message];
      if (attempts >= maxAttempts) {
        opts.ledger.failTask(opts.kind, opts.taskId, 'error', errors);
        return { ok: false, stopReason: 'error', errors, attempts };
      }
      continue;
    }

    if (chat.stopReason !== 'completed') {
      errors = [`模型结算原因=${chat.stopReason}`];
      opts.ledger.failTask(opts.kind, opts.taskId, chat.stopReason, errors);
      return { ok: false, stopReason: chat.stopReason, errors, attempts };
    }

    if (chat.json === undefined) {
      errors = ['输出不是合法 JSON 对象（可能被截断或包含多余文本）'];
      opts.ledger.updateTask(opts.kind, opts.taskId, { attempt: attempts });
      continue;
    }

    const parsed = opts.schema.safeParse(chat.json);
    if (!parsed.success) {
      errors = formatIssues(parsed.error);
      opts.ledger.updateTask(opts.kind, opts.taskId, { attempt: attempts });
      continue;
    }

    const extraErrors = opts.postValidate ? opts.postValidate(parsed.data) : [];
    if (extraErrors.length > 0) {
      errors = extraErrors;
      opts.ledger.updateTask(opts.kind, opts.taskId, { attempt: attempts });
      continue;
    }

    const artifactPath = path.join(opts.runDir, 'artifacts', opts.kind, `${opts.taskId}.json`);
    try {
      await writeJson(artifactPath, {
        taskId: opts.taskId,
        kind: opts.kind,
        agent: opts.agent,
        schemaName: opts.schemaName,
        provider: opts.llm.provider.name,
        model: chat.model,
        usage: chat.usage,
        stopReason: chat.stopReason,
        committedHint: nowIso(),
        value: parsed.data,
      });
    } catch (error) {
      errors = [`结果落盘失败：${error instanceof Error ? error.message : String(error)}`];
      opts.ledger.failTask(opts.kind, opts.taskId, 'error', errors);
      return { ok: false, stopReason: 'error', errors, attempts };
    }

    opts.ledger.updateTask(opts.kind, opts.taskId, {
      status: 'staged',
      attempt: attempts,
      result_path: artifactPath,
    });
    try {
      opts.persist?.(parsed.data);
    } catch (error) {
      errors = [`业务字段写入失败：${error instanceof Error ? error.message : String(error)}`];
      opts.ledger.failTask(opts.kind, opts.taskId, 'error', errors);
      return { ok: false, stopReason: 'error', errors, attempts };
    }
    opts.ledger.commitTask(opts.kind, opts.taskId, artifactPath);
    return { ok: true, value: parsed.data, attempts, artifactPath, chat };
  }

  opts.ledger.failTask(opts.kind, opts.taskId, 'error', errors);
  return { ok: false, stopReason: 'error', errors, attempts: maxAttempts };
}
