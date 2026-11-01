/**
 * 伯乐终稿阶段的工具调用循环：报告落盘后，由伯乐（coordinator）自己决定
 * 导出 Word 还是 PDF（或两者），通过 OpenAI Function Calling 标准调用已注册工具。
 * 循环执行 tool_calls、把结果回传给模型，直到模型给出最终答复。
 */
import path from 'node:path';
import { executeTool, toolSchemas } from '../tools/tools-call.ts';
import type { ReportData } from '../report/builder.ts';
import type { ChatTurn } from '../types.ts';
import type { AgentDeps } from './deps.ts';
import { sharedPrefix, systemPrompt } from './prompts.ts';

export interface ExportOutcome {
  files: string[];
  calls: number;
  summary: string;
}

const MAX_STEPS = 5;

function exportInstruction(): string {
  return `【终稿导出】报告已经生成并保存为 report.json（内容无需你再读取，也禁止用 python_exec 去探查 report.json，导出工具会自行读取）。
你现在只负责导出文件，必须按以下顺序直接行动，不要做其他调研：
1. 第一步必须调用 export_word 生成 Word；
2. 如果 HR 需求中要求 PDF（或需要分发/归档的只读文件），紧接着调用 office_export_pdf；
3. 需求没有明确指定格式时，导出 Word + PDF 两种；
4. python_exec / load_workspace_dependencies 只在用户明确要求自定义 Python 文档处理时才使用，导出场景下不要调用。
工具调用完成后，用一句中文说明导出了哪些文件。不要编造工具名或文件路径，不要修改报告内容。`;
}

function reportDigest(report: ReportData): string {
  return JSON.stringify({
    title: report.job.title,
    status: report.run.status,
    top: report.top.slice(0, 5).map((candidate) => ({
      label: candidate.label,
      totalScore: candidate.totalScore,
      conclusion: candidate.conclusion,
    })),
    reviewStats: report.compliance.reviewStats,
    failed: report.compliance.failed.length,
  });
}

/** 执行工具调用循环；任何失败都不阻塞报告落盘，只记录事件。 */
export async function runExporter(deps: AgentDeps, report: ReportData, requirements: string): Promise<ExportOutcome> {
  const files = new Set<string>();
  const system = `${systemPrompt(deps, 'coordinator')}\n\n${exportInstruction()}`;
  const messages: ChatTurn[] = [
    {
      role: 'user',
      content: `【HR 原始需求】${requirements}\n\n【报告摘要】${reportDigest(report)}\n\n现在开始：请决定导出格式并调用工具。`,
    },
  ];
  let calls = 0;
  let summary = '';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    let chat;
    try {
      chat = await deps.llm.chat({
        agent: 'coordinator',
        tier: 'flash',
        system,
        user: '',
        messages,
        tools: toolSchemas(),
        toolChoice: 'auto',
        maxTokens: 2048,
        sharedPrefix: sharedPrefix(deps, 'coordinator'),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.events.emit(deps.jobId, 'coordinator', 'tool.failed', { errors: [message] });
      summary = `导出工具调用失败：${message}`;
      break;
    }

    const toolCalls = chat.toolCalls ?? [];
    if (toolCalls.length === 0) {
      summary = (chat.text || '').trim() || '模型未选择导出文件。';
      break;
    }

    messages.push({ role: 'assistant', content: chat.text || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      calls += 1;
      const name = call.function.name;
      const started = Date.now();
      deps.events.emit(deps.jobId, 'coordinator', 'tool.called', {
        tool: name,
        arguments: call.function.arguments,
      });
      const blocked =
        files.size === 0 && (name === 'python_exec' || name === 'load_workspace_dependencies');
      const result = blocked
        ? {
            ok: false,
            message: '终稿导出阶段请先调用导出工具（export_word / office_export_pdf）；report.json 无需用 Python 读取。',
          }
        : await executeTool(name, call.function.arguments, {
            report,
            runDir: deps.runDir,
            dataDir: deps.paths.dataDir,
          });
      const durationMs = Date.now() - started;
      for (const file of result.files ?? []) {
        if (/\.(docx|pdf)$/i.test(file)) files.add(file);
      }
      deps.events.emit(deps.jobId, 'coordinator', result.ok ? 'tool.completed' : 'tool.error', {
        tool: name,
        arguments: call.function.arguments,
        message: result.message,
        files: result.files ?? [],
        durationMs,
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // 兜底：模型未产出任何文件时按需求执行默认导出（Word，必要时追加 PDF），保证终稿可交付。
  if (files.size === 0) {
    const wantsPdf = /pdf/i.test(requirements);
    const fallbackFiles: string[] = [];
    const word = await executeTool('export_word', '{}', { report, runDir: deps.runDir, dataDir: deps.paths.dataDir });
    if (word.ok) fallbackFiles.push(...(word.files ?? []));
    if (wantsPdf) {
      const pdf = await executeTool('office_export_pdf', '{}', { report, runDir: deps.runDir, dataDir: deps.paths.dataDir });
      if (pdf.ok) fallbackFiles.push(...(pdf.files ?? []));
    }
    for (const file of fallbackFiles) if (/\.(docx|pdf)$/i.test(file)) files.add(file);
    deps.events.emit(deps.jobId, 'coordinator', 'tool.fallback', {
      reason: summary || '模型未产出导出文件，已按需求默认导出',
      files: fallbackFiles,
    });
    if (!summary) summary = '已按需求导出报告文件。';
  }

  const exported = [...files].map((file) => path.basename(file));
  deps.events.emit(deps.jobId, 'coordinator', 'report.exported', {
    files: [...files],
    formats: [...files].map((file) => path.extname(file).replace('.', '')),
    summary,
  });
  return { files: [...files], calls, summary };
}
