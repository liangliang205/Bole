/** Deterministic SDK example; the production recruitment workflow uses real LLM Agents. */
import { z } from 'zod';
import { Ledger } from '../src/core/ledger.ts';
import { ApprovalPendingError, ApprovalStore } from '../src/core/approvals.ts';
import { defineWorkflow, task, sequence, parallel, condition, loop, subworkflow, approval, WorkflowRegistry, WorkflowEngine } from '../src/workflow/index.ts';

const candidate = z.object({ name: z.string(), source: z.string(), quote: z.string(), verified: z.boolean() });
const loopResult = z.object({ status: z.enum(['completed', 'exhausted']), iterations: z.number(), value: candidate });
const check = task({ id: 'check-and-correct', input: candidate, output: candidate, recovery: 'retry', handler: (input) => {
  if (input.source.includes(input.quote)) return { ...input, verified: true };
  return { ...input, quote: input.source, verified: false };
} });
const verify = defineWorkflow({ id: 'evidence-review', version: '1.0.0', implementation: 'example-v1', input: candidate, output: candidate,
  body: sequence('review', loop('correction-loop', { body: check, until: (v) => v.verified, maxIterations: 2 }),
    task({ id: 'require-verified', input: loopResult, output: candidate, recovery: 'retry', handler: (v) => { if (v.status === 'exhausted' || !v.value.verified) throw new Error('核查未通过，转人工'); return v.value; } })) });
const human = defineWorkflow({ id: 'approval', version: '1.0.0', implementation: 'example-v1', input: candidate, output: candidate,
  body: approval('approve', { title: '确认原文核查结果', input: candidate }) });
const body = sequence('candidate', subworkflow('verify', 'evidence-review@1.0.0', candidate, candidate), condition('needs-human', {
  test: (v: z.infer<typeof candidate>) => v.verified,
  then: subworkflow('approval', 'approval@1.0.0', candidate, candidate),
  otherwise: task({ id: 'reject-unverified', input: candidate, output: candidate, recovery: 'retry', handler: () => { throw new Error('未通过核查'); } }),
}));
const fanout = parallel('candidates', { items: (v: z.infer<typeof candidate>[]) => v, key: (v) => v.name, concurrency: 2, failure: 'collect', body });
const output = z.array(z.union([z.object({ key: z.string(), ok: z.literal(true), value: candidate }), z.object({ key: z.string(), ok: z.literal(false), error: z.string() })]));
const root = defineWorkflow({ id: 'example', version: '1.0.0', implementation: 'example-v1', input: z.array(candidate), output, body: fanout });
const ledger = new Ledger(':memory:');
try {
  const job = ledger.createJob({ title: 'SDK 示例', requirements: '验证并审批' });
  const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(verify).register(human).register(root));
  try { await engine.start(job.id, 'example@1.0.0', [{ name: 'A', source: '参与支付系统开发', quote: '不存在的资格证书', verified: false }, { name: 'B', source: '负责数据库优化', quote: '数据库优化', verified: false }]); }
  catch (error) { if (!(error instanceof ApprovalPendingError)) throw error; }
  const store = new ApprovalStore(ledger);
  console.log('核查修正后进入子流程审批：', store.list(job.id).map((a) => ({ id: a.id, status: a.status })));
  // Example only: simulate the human action explicitly. Production uses the approval UI.
  for (const pending of store.list(job.id).filter((a) => a.status === 'pending')) store.decide(pending.id, job.id, true, 'example-human');
  console.log('审批后恢复：', JSON.stringify(await engine.resume(engine.store.root(job.id)!.id), null, 2));
  console.log('父子运行：', engine.store.inspect(job.id).runs.map((r) => ({ id: r.id, workflow: r.workflow_key, parent: r.parent_run_id, status: r.status })));
} finally { ledger.close(); }
