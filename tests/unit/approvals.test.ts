import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/core/ledger.ts';
import { ApprovalStore, ApprovalPendingError, ApprovalRejectedError, requireApproval } from '../../src/core/approvals.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { chatWithJob } from '../../src/chat/service.ts';
import { executeApprovedTool } from '../../src/tools/approved-tool.ts';
import { runOrchestrator } from '../../src/chat/orchestrator.ts';
import type { ChatTurn } from '../../src/types.ts';
import type { LlmRouter } from '../../src/llm/router.ts';
import type { McpManager } from '../../src/mcp/manager.ts';
import type { ReportData } from '../../src/report/builder.ts';

test('严格审批绑定内容；拒绝不执行，自动应答不能授权，默认模式不增加审批', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: 'test', requirements: 'test' });
    const store = new ApprovalStore(ledger);
    await requireApproval(store, job.id, 'tool', { x: 1 }, 'a');
    assert.equal(store.list(job.id).length, 0);
    store.setMode(job.id, 'strict');
    await assert.rejects(requireApproval(store, job.id, 'tool', { x: 1 }, 'a', new AutoHitlResponder()), ApprovalPendingError);
    const approval = store.list(job.id)[0];
    store.decide(approval.id, job.id, true, 'HR(test)');
    await requireApproval(store, job.id, 'tool', { x: 1 }, 'a');
    await assert.rejects(requireApproval(store, job.id, 'tool', { x: 2 }, 'a'), ApprovalPendingError);
    const changed = store.list(job.id)[1];
    store.decide(changed.id, job.id, false, 'HR(test)');
    await assert.rejects(requireApproval(store, job.id, 'tool', { x: 2 }, 'a'), ApprovalRejectedError);
    assert.throws(() => store.decide(approval.id, 'another-job', true, 'HR(test)'));
    assert.throws(() => store.decide(approval.id, job.id, true, 'HR(test)'));
  } finally { ledger.close(); }
});

test('严格对话工具在审批前无副作用，批准后只执行落库参数一次，同样的新调用仍需审批', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: 'test', requirements: 'test' });
    const store = new ApprovalStore(ledger);
    store.setMode(job.id, 'strict');
    const calls: string[] = [];
    const mcp = {
      start: async () => {},
      toolsFor: () => [{ type: 'function', function: { name: 'mcp__test__write', description: 'write', parameters: {} } }],
      status: () => ({ servers: [] }),
      callTool: async (_name: string, args: string) => { calls.push(args); return { ok: true, message: 'done' }; },
    } as unknown as McpManager;
    const llm = { chat: async () => ({ text: '', toolCalls: [{ id: 'call', type: 'function', function: {
      name: 'mcp__test__write', arguments: '{"target":"approved"}',
    } }] }) } as unknown as LlmRouter;
    const opts = { job, ledger, llm, mcp, message: '写入结果', report: {} as ReportData, runDir: '.', dataDir: '.' };
    await chatWithJob(opts);
    assert.equal(calls.length, 0);
    const approval = store.list(job.id)[0];
    await assert.rejects(executeApprovedTool(store, approval.id, job.id, mcp));
    store.decide(approval.id, job.id, true, 'HR(test)');
    await Promise.allSettled([executeApprovedTool(store, approval.id, job.id, mcp), executeApprovedTool(store, approval.id, job.id, mcp)]);
    assert.deepEqual(calls, ['{"target":"approved"}']);
    assert.equal(store.get(approval.id, job.id)?.status, 'completed');
    await chatWithJob(opts);
    assert.equal(store.list(job.id).filter((a) => a.status === 'pending').length, 1);
    assert.equal(calls.length, 1);
    const next = store.list(job.id).find((a) => a.status === 'pending')!;
    const payload = JSON.parse(next.payload_json) as { continuation: { message: string; turns: ChatTurn[]; callId: string } };
    store.decide(next.id, job.id, true, 'HR(test)');
    const executed = await executeApprovedTool(store, next.id, job.id, mcp);
    let sawToolResult = false;
    const resumedLlm = { chat: async (request: { messages: ChatTurn[] }) => {
      sawToolResult = request.messages.at(-1)?.role === 'tool' && request.messages.at(-1)?.content === JSON.stringify(executed);
      return { text: '原请求已完成。' };
    } } as unknown as LlmRouter;
    const continued = await runOrchestrator({ ...opts, llm: resumedLlm, message: payload.continuation.message,
      continuation: [...payload.continuation.turns, { role: 'tool', tool_call_id: payload.continuation.callId, content: JSON.stringify(executed) }],
    });
    assert.equal(sawToolResult, true);
    assert.equal(continued.answer, '原请求已完成。');
    // 即使审批已经批准，当前工具定义变化也不能沿用授权。
    await chatWithJob(opts);
    const stale = store.list(job.id).find((a) => a.status === 'pending')!;
    store.decide(stale.id, job.id, true, 'HR(test)');
    const changedMcp = { ...mcp, toolsFor: () => [] } as unknown as McpManager;
    await assert.rejects(executeApprovedTool(store, stale.id, job.id, changedMcp), /定义或权限已变更/);
    assert.equal(calls.length, 2);
  } finally { ledger.close(); }
});
