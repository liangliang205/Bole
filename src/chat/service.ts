import path from 'node:path';
import type { Ledger } from '../core/ledger.ts';
import type { LlmRouter } from '../llm/router.ts';
import type { ReportData } from '../report/builder.ts';
import { executeTool, toolSchemas } from '../tools/tools-call.ts';
import type { ChatMessageRow, ChatTurn, JobRow } from '../types.ts';
import { INTERVIEW_SKILL_BODY, INTERVIEW_SKILL_CATALOG, wantsInterviewAdvice } from './interview-skill.ts';

const CONCLUSION_LABELS: Record<string, string> = {
  strong_yes: '强烈推荐',
  yes: '推荐',
  maybe: '待定',
  no: '不推荐',
  strong_no: '强烈不推荐',
  pending: '待评估',
};

interface ReportLike {
  top?: {
    label?: string;
    totalScore?: number;
    conclusion?: string;
    reason?: string;
    evalTier?: string;
    evalPhase?: string;
  }[];
  escalations?: { label?: string; reason?: string; score?: number | null }[];
  others?: { label?: string; totalScore?: number; conclusion?: string; reason?: string }[];
  compliance?: {
    failed?: { label?: string; reason?: string }[];
    duplicates?: { label?: string; duplicateOf?: string }[];
  };
}

function conclusion(value: string | undefined): string {
  return CONCLUSION_LABELS[value ?? ''] ?? value ?? '待评估';
}

/** 给主 Agent 的稳定上下文：同一 job 的所有追问复用同一前缀，便于命中 prompt cache。 */
export function buildJobChatContext(job: JobRow, report: ReportLike | null): string {
  const lines: string[] = [
    '你是伯乐，招聘筛选平台的主 Agent。筛选流水线已经完成，现在只由你回答 HR 的后续追问。',
    '要求：基于下面的岗位、评分卡、候选人结论与失败/转人工明细回答；不要声称重新运行了筛选，也不要虚构候选人。',
    '如果信息不足，直接说明缺什么；回答用中文，简洁、可执行。',
    '',
    '【岗位需求】',
    job.requirements,
  ];
  if (report?.top?.length) {
    lines.push('', '【候选人结论】');
    report.top.forEach((candidate, index) => {
      lines.push(
        `${index + 1}. ${candidate.label ?? '未命名'}：${candidate.totalScore ?? 0} 分，${conclusion(candidate.conclusion)}。理由：${candidate.reason ?? '无'}`,
      );
    });
  } else {
    lines.push('', '【候选人结论】', '暂无通过证据核查的候选人。');
  }
  if (report?.escalations?.length) {
    lines.push('', '【转人工】');
    for (const item of report.escalations) lines.push(`- ${item.label ?? '未命名'}：${item.reason ?? '需人工复核'}`);
  }
  if (report?.compliance?.duplicates?.length) {
    lines.push('', '【重复投递】', ...report.compliance.duplicates.map((item) => `- ${item.label ?? '未命名'}（重复于 ${item.duplicateOf ?? '已存在简历'}）`));
  }
  if (report?.compliance?.failed?.length) {
    lines.push('', '【失败/未完成】', ...report.compliance.failed.map((item) => `- ${item.label ?? '未命名'}：${item.reason ?? '失败'}`));
  }
  if (report?.others?.length) {
    lines.push('', '【其他候选人】');
    for (const item of report.others.slice(0, 20)) {
      lines.push(`- ${item.label ?? '未命名'}：${item.totalScore ?? 0} 分，${conclusion(item.conclusion)}；${item.reason ?? ''}`);
    }
  }
  return lines.join('\n');
}

export async function chatWithJob(opts: {
  job: JobRow;
  report: ReportData | null;
  ledger: Ledger;
  llm: LlmRouter;
  message: string;
  runDir?: string;
  dataDir?: string;
}): Promise<{ answer: string; messages: ChatMessageRow[] }> {
  const message = opts.message.trim();
  if (!message) throw new Error('消息不能为空');
  if (message.length > 4000) throw new Error('单条消息不能超过 4000 个字符');
  opts.ledger.appendChat(opts.job.id, 'user', message);
  const history = opts.ledger.listChat(opts.job.id, 40);
  const toolsEnabled = Boolean(opts.report && opts.runDir && opts.dataDir);
  const system = [
    buildJobChatContext(opts.job, opts.report),
    `【可用技能】${INTERVIEW_SKILL_CATALOG}`,
    wantsInterviewAdvice(message) ? INTERVIEW_SKILL_BODY : '',
    toolsEnabled
      ? [
          '【文件生成规则】文件工具是可选的，不是每次回答的默认步骤。',
          '- 只有 HR 在当前对话中明确要求生成、导出或下载 Word/PDF/可编辑报告时，才调用工具。',
          '- Word 使用 export_word；PDF 使用 office_export_pdf，且需要先有 docx 源文件。',
          '- HR 没有明确要求生成文件时，不调用任何工具，直接用文字回答；不要主动生成或建议性生成文件。',
          '- 工具成功后只报告实际生成的文件名和下载结果；界面会显示文件卡片，不要在正文输出绝对路径。失败时保留已有源文件并说明限制，不要反复转换未变化的输入，也不要用 python_exec 检查 report.json。',
        ].join('\n')
      : '',
  ].filter(Boolean).join('\n\n');
  const turns: ChatTurn[] = history.map((item) => ({ role: item.role, content: item.content }));
  const files = new Set<string>();
  let answer = '';

  for (let step = 0; step < 5; step += 1) {
    const result = await opts.llm.chat({
      agent: 'coordinator',
      tier: 'pro',
      system,
      user: message,
      messages: turns,
      ...(toolsEnabled ? { tools: toolSchemas(), toolChoice: 'auto' as const } : {}),
      temperature: 0.2,
      maxTokens: 2048,
      meta: { jobId: opts.job.id, kind: 'job-chat' },
    });
    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      answer = result.text.trim();
      break;
    }
    turns.push({ role: 'assistant', content: result.text || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const executed = await executeTool(call.function.name, call.function.arguments, {
        report: opts.report!,
        runDir: opts.runDir!,
        dataDir: opts.dataDir!,
      });
      for (const file of executed.files ?? []) {
        if (/\.(docx|pdf)$/i.test(file)) files.add(file);
      }
      turns.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(executed) });
    }
  }

  if (!answer) throw new Error('主 Agent 没有返回内容');
  const names = [...files].map((file) => path.basename(file));
  if (names.length) {
    // 工具结果里的绝对路径只用于卡片下载，不把本机路径展示给 HR。
    answer = answer
      .replace(/^文件路径[:：].*$/gm, '')
      .replace(/(?:[A-Za-z]:\\|\/)[^\s]+\.(?:docx|pdf)/gi, '')
      .trim();
  }
  opts.ledger.appendChat(opts.job.id, 'assistant', answer, names);
  return { answer, messages: opts.ledger.listChat(opts.job.id, 100) };
}
