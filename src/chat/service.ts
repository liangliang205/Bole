import path from 'node:path';
import type { Ledger } from '../core/ledger.ts';
import type { LlmRouter } from '../llm/router.ts';
import type { ReportData } from '../report/builder.ts';
import type { McpManager } from '../mcp/manager.ts';
import type { ChatAttachment, ChatMessageRow, JobRow } from '../types.ts';
import { runOrchestrator } from './orchestrator.ts';

export { buildJobChatContext } from './context.ts';

export function publicChatMessages(messages: ChatMessageRow[]): ChatMessageRow[] {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => ({ name: attachment.name, text: '' })),
  }));
}

/**
 * 完成后对话入口：主 Agent（编排者）自主决定直接回答、委派对话助手或调用工具。
 * 这里只负责消息校验、落库与路径脱敏，具体决策在 orchestrator.ts。
 */
export async function chatWithJob(opts: {
  job: JobRow;
  report: ReportData | null;
  ledger: Ledger;
  llm: LlmRouter;
  message: string;
  attachments?: ChatAttachment[];
  runDir?: string;
  dataDir?: string;
  mcp?: McpManager;
}): Promise<{ answer: string; messages: ChatMessageRow[] }> {
  const attachments = opts.attachments ?? [];
  const message = opts.message.trim() || (attachments.length ? '请查看附件。' : '');
  if (!message) throw new Error('消息不能为空');
  if (message.length > 4000) throw new Error('单条消息不能超过 4000 个字符');
  opts.ledger.appendChat(opts.job.id, 'user', message, [], attachments);

  const { answer: rawAnswer, files } = await runOrchestrator({
    job: opts.job,
    report: opts.report,
    ledger: opts.ledger,
    llm: opts.llm,
    message,
    attachments,
    runDir: opts.runDir,
    dataDir: opts.dataDir,
    mcp: opts.mcp,
  });

  const names = files.map((file) => path.basename(file));
  let answer = rawAnswer;
  if (names.length) {
    // 工具结果里的绝对路径只用于卡片下载，不把本机路径展示给 HR。
    answer = answer
      .replace(/^文件路径[:：].*$/gm, '')
      .replace(/(?:[A-Za-z]:\\|\/)[^\s]+\.(?:docx|pdf)/gi, '')
      .trim();
  }
  opts.ledger.appendChat(opts.job.id, 'assistant', answer, names);
  return { answer, messages: publicChatMessages(opts.ledger.listChat(opts.job.id, 100)) };
}
