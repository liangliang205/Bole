import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/core/ledger.ts';
import { WorkflowStore } from '../../src/workflow/store.ts';
import { ApprovalStore } from '../../src/core/approvals.ts';
import { chatWithJob } from '../../src/chat/service.ts';
import type { LlmRouter } from '../../src/llm/router.ts';

test('对话模型真实调用当前任务续跑；无报告亦可用，不能替换目标或仅凭状态询问执行', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: 'resume', requirements: 'test' }); ledger.setJobStatus(job.id, 'paused');
    const store = new WorkflowStore(ledger); const hash = store.define('test@1.0.0', { version: 1 });
    const root = store.create(job.id, 'test@1.0.0', hash, {}); store.state(root.id, 'paused');
    let count = 0; let args = '{}';
    const llm = { chat: async (req: { tools: { function: { name: string } }[] }) => {
      assert.ok(req.tools.some((t) => t.function.name === 'resume_workflow'));
      return { text: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'resume_workflow', arguments: args } }] };
    } } as unknown as LlmRouter;
    const send = (message: string) => chatWithJob({ job: ledger.getJob(job.id)!, ledger, llm, report: null, message, resumeWorkflow: async () => { count++; } });
    assert.match((await send('请继续筛选')).answer, /已启动/); assert.equal(count, 1);
    assert.match((await send('为什么没有继续？')).answer, /未启动/); assert.equal(count, 1);
    assert.match((await send('不要续跑')).answer, /未启动/); assert.equal(count, 1);
    args = '{"jobId":"other"}'; assert.match((await send('请续跑')).answer, /不接受/); assert.equal(count, 1); args = '{}';
    store.state(root.id, 'succeeded', null, {}); assert.match((await send('请续跑')).answer, /已结束/); assert.equal(count, 1);
    store.state(root.id, 'waiting_confirmation'); assert.match((await send('请续跑')).answer, /人工确认/); assert.equal(count, 1);
  } finally { ledger.close(); }
});

test('严格模式对话续跑先审批；拒绝不执行，批准后保留原检查点目标', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: 'resume', requirements: 'test' });
    const approvals = new ApprovalStore(ledger); approvals.setMode(job.id, 'strict');
    const store = new WorkflowStore(ledger); const hash = store.define('test@1.0.0', { version: 1 });
    const root = store.create(job.id, 'test@1.0.0', hash, {}); store.state(root.id, 'paused');
    let starts = 0;
    const llm = { chat: async () => ({ text: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'resume_workflow', arguments: '{}' } }] }) } as unknown as LlmRouter;
    const send = () => chatWithJob({ job, ledger, llm, report: null, message: '请续跑', resumeWorkflow: async () => { starts++; } });
    assert.match((await send()).answer, /等待人工审批/); assert.equal(starts, 0);
    const pending = approvals.list(job.id)[0]; assert.equal(JSON.parse(pending.payload_json).rootRunId, root.id);
    assert.match((await send()).answer, /先处理现有审批/); assert.equal(starts, 0);
    approvals.decide(pending.id, job.id, true, 'HR');
    assert.match((await send()).answer, /已启动/); assert.equal(starts, 1);
  } finally { ledger.close(); }
});
