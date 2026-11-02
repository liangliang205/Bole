import type { ZodType } from 'zod';
import type { ChatResult, StreamSink } from '../types.ts';
import type { AgentDeps } from './deps.ts';

export interface JsonCallOptions<T> {
  agent: string;
  tier: 'flash' | 'pro';
  schemaName: string;
  schema: ZodType<T>;
  system: string;
  user: string;
  sharedPrefix?: string;
  meta?: Record<string, unknown>;
  phase?: string;
  label?: string;
  resumeId?: string;
  stream?: StreamSink;
  maxAttempts?: number;
  postValidate?: (value: T) => string[];
}

/**
 * 无台账任务的 Agent 调用（画像师）：schema 校验失败同轮重试，最多 2 次。
 * 解析/评估/核查走 runStructuredTask（带任务台账与两阶段提交）。
 */
export async function callAgentJson<T>(
  deps: AgentDeps,
  opts: JsonCallOptions<T>,
): Promise<{ ok: true; value: T; attempts: number; chat: ChatResult } | { ok: false; errors: string[] }> {
  const maxAttempts = opts.maxAttempts ?? deps.config.structuredOutput.maxAttempts;
  const stream = opts.stream ?? deps.stream;
  let errors: string[] = [];
  let maxTokens = 8192;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const retry = errors.length
      ? `\n\n【上一次输出未通过校验，请修正】\n${errors.join('\n')}\n只输出修正后的完整 JSON。`
      : '';
    let chat: ChatResult;
    try {
      chat = await deps.llm.chat({
        agent: opts.agent,
        tier: opts.tier,
        schemaName: opts.schemaName,
        system: opts.system,
        user: `${opts.user}${retry}`,
        sharedPrefix: opts.sharedPrefix,
        temperature: 0,
        maxTokens,
        onToken: stream
          ? (delta: string) =>
              stream({
                type: 'token',
                agent: opts.agent,
                taskId: opts.schemaName,
                phase: opts.phase ?? opts.schemaName,
                resumeId: opts.resumeId,
                label: opts.label,
                attempt,
                delta,
              })
          : undefined,
        meta: opts.meta,
      });
    } catch (error) {
      errors = [error instanceof Error ? error.message : String(error)];
      continue;
    }
    if (chat.stopReason !== 'completed') {
      errors = [`模型结算原因=${chat.stopReason}（maxTokens=${maxTokens}）`];
      if (chat.stopReason === 'max-tokens' && attempt < maxAttempts && maxTokens < 32768) {
        maxTokens = Math.min(32768, maxTokens * 2);
        continue;
      }
      return { ok: false, errors };
    }
    if (chat.json === undefined) {
      errors = ['输出不是合法 JSON'];
      continue;
    }
    const parsed = opts.schema.safeParse(chat.json);
    if (!parsed.success) {
      errors = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}：${issue.message}`);
      continue;
    }
    const extra = opts.postValidate ? opts.postValidate(parsed.data) : [];
    if (extra.length > 0) {
      errors = extra;
      continue;
    }
    return { ok: true, value: parsed.data, attempts: attempt, chat };
  }
  return { ok: false, errors };
}
