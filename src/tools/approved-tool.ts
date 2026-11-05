import path from 'node:path';
import { ApprovalStore } from '../core/approvals.ts';
import { AgentRegistry } from '../core/registry.ts';
import type { McpManager } from '../mcp/manager.ts';
import type { ReportData } from '../report/builder.ts';
import { executeTool, toolSchemasWithMcp, type ToolExecResult } from './tools-call.ts';

/** 只执行落库的原始动作，不接受审批请求携带的新参数。执行中崩溃不自动重放。 */
export async function executeApprovedTool(store: ApprovalStore, id: string, jobId: string, mcp?: McpManager): Promise<ToolExecResult> {
  const approval = store.get(id, jobId);
  if (!approval || approval.kind !== 'tool') throw new Error('工具审批不存在');
  if (!store.claim(id, jobId)) throw new Error('操作未批准或已经执行');
  try {
    const payload = JSON.parse(approval.payload_json) as {
      name: string; arguments: string; report: ReportData; runDir: string; dataDir: string;
      registry: string; toolSchema: unknown;
    };
    const registry = AgentRegistry.load();
    const agent = registry.get('coordinator');
    if (payload.name.startsWith('mcp__')) await mcp?.start();
    const schema = toolSchemasWithMcp(mcp, agent.mcp).find((tool) =>
      tool.function.name === payload.name && (payload.name.startsWith('mcp__') || agent.tools.includes(payload.name)));
    if (!schema || registry.fingerprint !== payload.registry || JSON.stringify(schema) !== JSON.stringify(payload.toolSchema)) {
      throw new Error('工具定义或权限已变更，请重新发起操作');
    }
    const result = await executeTool(payload.name, payload.arguments, {
      report: payload.report, runDir: payload.runDir, dataDir: payload.dataDir, mcp,
    });
    store.finish(id, jobId, result.ok, result);
    store.ledger.appendChat(jobId, 'assistant',
      `已审批操作「${payload.name}」${result.ok ? '执行完成' : '执行失败'}。${result.message}`,
      (result.files ?? []).filter((file) => /\.(docx|pdf)$/i.test(file)).map((file) => path.basename(file)));
    return result;
  } catch (error) {
    store.finish(id, jobId, false, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
