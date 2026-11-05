import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Ledger } from '../../src/core/ledger.ts';
import { ApprovalPendingError, ApprovalRejectedError, ApprovalStore } from '../../src/core/approvals.ts';
import { defineWorkflow, task, sequence, parallel, branches, condition, loop, subworkflow, approval, WorkflowEngine, WorkflowRegistry, WorkflowStore, WorkflowPausedError, WorkflowUncertainError, WorkflowBusyError, WorkflowCancelledError } from '../../src/workflow/index.ts';
import type { Node, Outcome } from '../../src/workflow/index.ts';
import { workflowRoute } from '../../src/workflow/http.ts';
import { json } from '../../src/workflow/store.ts';

const number = z.number();
function setup() { const ledger = new Ledger(':memory:'); const job = ledger.createJob({ title: 'workflow', requirements: 'test' }); return { ledger, job }; }
function def<I, O>(body: Node<I, O>, input: z.ZodType<I>, output: z.ZodType<O>, id = 'test', version = '1.0.0') {
  return defineWorkflow({ id, version, input, output, body, implementation: 'unit-source-v1' });
}
function numeric(id: string, handler: (v: number) => number | Promise<number>, recovery: 'retry' | 'confirm' = 'retry') { return task({ id, input: number, output: number, recovery, handler }); }
const outcomeNumber = z.union([z.object({ key: z.string(), ok: z.literal(true), value: number }), z.object({ key: z.string(), ok: z.literal(false), error: z.string() })]);

test('代码化顺序、动态并行、条件、嵌套子流程及有界修正循环真实执行', async () => {
  const { ledger, job } = setup();
  try {
    const child = def(sequence('validate-correct', loop('fix', { body: numeric('correct', (v) => v + 1), until: (v) => v >= 3, maxIterations: 4 }),
      task({ id: 'verified', input: z.object({ status: z.enum(['completed', 'exhausted']), iterations: number, value: number }), output: number, recovery: 'retry', handler: (v) => { assert.equal(v.status, 'completed'); return v.value; } })), number, number, 'checker');
    const chosen = condition('route', { test: (v: number) => v < 3, then: subworkflow('check', 'checker@1.0.0', number, number), otherwise: numeric('already-valid', (v) => v) });
    const body = sequence('main', numeric('prepare', (v) => v + 1), parallel('items', { items: (v: number) => [v, v + 1, v + 3], key: (_v, i) => `item-${i}`, concurrency: 2, failure: 'collect', body: chosen }));
    const registry = new WorkflowRegistry().register(child).register(def(body, number, z.array(outcomeNumber)));
    const engine = new WorkflowEngine(ledger, registry);
    const result = await engine.start<number, Outcome<number>[]>(job.id, 'test@1.0.0', 0);
    assert.deepEqual(result.map((r) => r.ok && r.value), [3, 3, 4]);
    const view = engine.store.inspect(job.id);
    assert.equal(view.runs.length, 3);
    assert.ok(view.runs.filter((r) => r.parent_run_id).every((r) => r.parent_run_id === view.runs[0].id && r.root_run_id === view.runs[0].id));
    assert.ok(view.nodes.some((n) => n.path.includes('iteration-2')));
    assert.ok(view.nodes.some((n) => n.kind === 'condition' && n.control_json === '"then"'));
    assert.deepEqual(await engine.resume(view.runs[0].id), result);
    assert.throws(() => ledger.db.prepare("UPDATE workflow_runs SET input_json='{}' WHERE id=?").run(view.runs[0].id), /immutable/);
    assert.throws(() => ledger.db.prepare("UPDATE workflow_nodes SET input_json='{}' WHERE run_id=?").run(view.runs[0].id), /immutable/);
    assert.throws(() => ledger.db.prepare("UPDATE workflow_definitions SET content_hash='forged'").run(), /immutable/);
  } finally { ledger.close(); }
});

test('并行限制容量并保持输出顺序；collect 保留独立分支成功结果', async () => {
  const { ledger, job } = setup(); let active = 0; let peak = 0;
  try {
    const work = numeric('work', async (v) => { active++; peak = Math.max(peak, active); try { await new Promise<void>((r) => setTimeout(r, 5 * (4 - v))); if (v === 2) throw new Error('broken item'); return v * 2; } finally { active--; } });
    const body = parallel('fanout', { items: (_v: number) => [1, 2, 3], key: (v) => `key-${v}`, concurrency: 2, failure: 'collect', body: work });
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(body, number, z.array(outcomeNumber))));
    const result = await engine.start<number, Outcome<number>[]>(job.id, 'test@1.0.0', 0);
    assert.equal(peak, 2); assert.equal(active, 0);
    assert.deepEqual(result.map((r) => r.key), ['key-1', 'key-2', 'key-3']);
    assert.deepEqual(result.map((r) => r.ok), [true, false, true]);
    assert.equal(engine.store.root(job.id)?.status, 'succeeded');
  } finally { ledger.close(); }
});

test('fail-fast 停止派发剩余分支并等待在途任务收束', async () => {
  const { ledger, job } = setup(); const started: number[] = []; let settled = false;
  try {
    const work = numeric('work', async (v) => { started.push(v); if (v === 1) throw new Error('stop'); await new Promise<void>((r) => setTimeout(r, 10)); settled = true; return v; });
    const body = parallel('fanout', { items: (_v: number) => [1, 2, 3, 4], key: String, concurrency: 2, failure: 'fail-fast', body: work });
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(body, number, z.array(outcomeNumber))));
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 0), /stop/);
    assert.deepEqual(started, [1, 2]); assert.equal(settled, true); assert.equal(engine.store.root(job.id)?.status, 'failed');
  } finally { ledger.close(); }
});

test('循环超限返回 exhausted，不伪装验证通过；无效并发与重复分支被拒绝', async () => {
  const { ledger, job } = setup();
  try {
    const body = loop('bounded', { body: numeric('advance', (v) => v + 1), until: (v) => v > 10, maxIterations: 2 });
    const output = z.object({ status: z.enum(['completed', 'exhausted']), iterations: number, value: number });
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(body, number, output)));
    assert.deepEqual(await engine.start(job.id, 'test@1.0.0', 0), { status: 'exhausted', iterations: 2, value: 2 });
    for (const [id, concurrency, key] of [['invalid-capacity', 0, String], ['duplicate-keys', 2, () => 'same']] as const) {
      const another = ledger.createJob({ title: id, requirements: 'test' });
      const bad = parallel(id, { items: (_v: number) => [1, 2], key, concurrency, failure: 'collect', body: numeric('work', (v) => v) });
      const runner = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(bad, number, z.array(outcomeNumber), id)));
      await assert.rejects(runner.start(another.id, `${id}@1.0.0`, 0), /并发数|key/);
    }
  } finally { ledger.close(); }
});

test('审批子流程重启恢复：等待向上传播，独立分支继续，批准后不重复执行', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bole-workflow-'));
  let ledger = new Ledger(path.join(directory, 'ledger.db')); let independent = 0; let checked = 0;
  try {
    const job = ledger.createJob({ title: 'approval', requirements: 'test' });
    const child = def(sequence('approval-flow', numeric('checked', (v) => { checked++; return v; }), approval('human', { title: '核对并批准', input: number })), number, number, 'approval');
    const middle = def(subworkflow('approval-call', 'approval@1.0.0', number, number), number, number, 'reviewer');
    const body = branches('independent-branches', { branches: { approval: subworkflow('nested', 'reviewer@1.0.0', number, number), other: numeric('other', (v) => { independent++; return v + 1; }) }, concurrency: 2, failure: 'fail-fast' });
    const registry = new WorkflowRegistry().register(child).register(middle).register(def(body, number, z.array(outcomeNumber)));
    let engine = new WorkflowEngine(ledger, registry);
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 4), ApprovalPendingError);
    const root = engine.store.root(job.id)!; const view = engine.store.inspect(job.id);
    assert.equal(root.status, 'waiting_approval'); assert.equal(independent, 1); assert.equal(checked, 1);
    const nested = view.runs.find((r) => r.parent_run_id)!;
    assert.equal(nested.status, 'waiting_approval'); assert.equal(nested.parent_run_id, root.id);
    const grandchild = view.runs.find((r) => r.workflow_key === 'approval@1.0.0')!;
    assert.equal(grandchild.parent_run_id, nested.id); assert.equal(grandchild.root_run_id, root.id);
    ledger.close(); ledger = new Ledger(path.join(directory, 'ledger.db'));
    const approvals = new ApprovalStore(ledger); const pending = approvals.list(job.id)[0]; approvals.decide(pending.id, job.id, true, 'HR');
    // Adding a newer child does not change the explicit old reference.
    registry.register(def(numeric('new-work', (v) => v + 100), number, number, 'approval', '2.0.0'));
    engine = new WorkflowEngine(ledger, registry);
    const result = await engine.resume<Outcome<number>[]>(root.id);
    assert.deepEqual(result.map((r) => r.ok && r.value), [4, 5]);
    assert.equal(independent, 1); assert.equal(checked, 1); assert.equal(engine.store.inspect(job.id).runs.length, 3);
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test('拒绝审批及子流程输出契约失败按 fail-fast 规则传播至父运行', async () => {
  const { ledger, job } = setup();
  try {
    const child = def(approval('human', { title: '审批', input: number }), number, number, 'approval');
    const registry = new WorkflowRegistry().register(child).register(def(subworkflow('child', 'approval@1.0.0', number, number), number, number));
    const engine = new WorkflowEngine(ledger, registry);
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 0), ApprovalPendingError);
    const approvals = new ApprovalStore(ledger); approvals.decide(approvals.list(job.id)[0].id, job.id, false, 'HR');
    await assert.rejects(engine.resume(engine.store.root(job.id)!.id), ApprovalRejectedError);
    assert.ok(engine.store.inspect(job.id).runs.every((r) => r.status === 'failed'));
    const other = ledger.createJob({ title: 'contract', requirements: 'test' });
    const bad = def(numeric('negative', () => -1), number, z.number().positive(), 'bad');
    const badEngine = new WorkflowEngine(ledger, new WorkflowRegistry().register(bad).register(def(subworkflow('bad-child', 'bad@1.0.0', number, number), number, number, 'bad-parent')));
    await assert.rejects(badEngine.start(other.id, 'bad-parent@1.0.0', 0), /Too small|small/);
    assert.ok(badEngine.store.inspect(other.id).runs.every((r) => r.status === 'failed'));
  } finally { ledger.close(); }
});

test('暂停续跑复用成功节点；同版本实现变化、输入变化及嵌套循环引用被拒绝', async () => {
  const { ledger, job } = setup(); let first = 0; let second = 0;
  try {
    const body = sequence('steps', numeric('first', (v) => { first++; return v + 1; }), numeric('second', (v) => { second++; return v + 1; }));
    const registry = new WorkflowRegistry().register(def(body, number, number));
    const paused = new WorkflowEngine(ledger, registry, { shouldPause: () => first > 0 });
    await assert.rejects(paused.start(job.id, 'test@1.0.0', 0), WorkflowPausedError);
    assert.equal(paused.store.root(job.id)?.status, 'paused'); assert.equal(second, 0);
    const engine = new WorkflowEngine(ledger, registry);
    assert.equal(await engine.resume(paused.store.root(job.id)!.id), 2); assert.equal(first, 1); assert.equal(second, 1);
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 3), /快照不一致/);
    const changed = new WorkflowRegistry().register(def(numeric('different', (v) => v), number, number));
    await assert.rejects(new WorkflowEngine(ledger, changed).resume(paused.store.root(job.id)!.id), /发布新版本/);
    const recursive = new WorkflowRegistry().register(def(subworkflow('self', 'test@1.0.0', number, number), number, number));
    assert.throws(() => recursive.bundle('test@1.0.0'), /循环引用/);
    assert.throws(() => def(sequence('duplicate', numeric('same', (v) => v), numeric('same', (v) => v)), number, number), /不能重复/);
  } finally { ledger.close(); }
});

test('条件选择在等待期间冻结，审批后不会重新选择路径', async () => {
  const { ledger, job } = setup(); let select = true;
  try {
    const body = condition('choose', { test: (_v: number) => select, then: approval('human', { title: '审批', input: number }), otherwise: numeric('fallback', (v) => v + 100) });
    const registry = new WorkflowRegistry().register(def(body, number, number)); const engine = new WorkflowEngine(ledger, registry);
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 5), ApprovalPendingError);
    select = false;
    const approvals = new ApprovalStore(ledger); approvals.decide(approvals.list(job.id)[0].id, job.id, true, 'HR');
    assert.equal(await engine.resume(engine.store.root(job.id)!.id), 5);
  } finally { ledger.close(); }
});

test('外部副作用中断不自动重放；人工确认、契约校验和租约互斥', async () => {
  const { ledger, job } = setup(); let effects = 0;
  try {
    const body = numeric('external', () => { effects++; throw new Error('connection lost after write'); }, 'confirm');
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(body, number, number)));
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 1), WorkflowUncertainError);
    const root = engine.store.root(job.id)!;
    await assert.rejects(engine.resume(root.id), WorkflowUncertainError); assert.equal(effects, 1);
    const other = ledger.createJob({ title: 'other', requirements: 'test' });
    assert.throws(() => workflowRoute(ledger, 'POST', `/api/run/${other.id}/workflow/confirm`, { runId: root.id, path: '/external', action: 'retry' }), /不属于/);
    engine.store.confirm(root.id, '/external', { action: 'complete', output: 'wrong type' }, 'HR');
    await assert.rejects(engine.resume(root.id), WorkflowUncertainError);
    assert.equal(engine.store.node(root.id, '/external')?.status, 'waiting_confirmation');
    workflowRoute(ledger, 'POST', `/api/run/${job.id}/workflow/confirm`, { runId: root.id, path: '/external', action: 'complete', output: 8 });
    assert.equal(await engine.resume(root.id), 8); assert.equal(effects, 1);
    ledger.db.prepare('UPDATE workflow_runs SET lease_owner=?,lease_until=? WHERE id=?').run('another-process', Date.now() + 60000, root.id);
    await assert.rejects(engine.resume(root.id), WorkflowBusyError);
    ledger.db.prepare('UPDATE workflow_runs SET lease_until=0 WHERE id=?').run(root.id);
    assert.equal(await engine.resume(root.id), 8);
  } finally { ledger.close(); }
});

test('崩溃遗留 running 节点仅安全任务可重试；显式重试外部任务须人工确认', async () => {
  const { ledger, job } = setup(); let calls = 0; let fail = true;
  try {
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(numeric('safe', (v) => { calls++; return v + 1; }), number, number)));
    assert.equal(await engine.start(job.id, 'test@1.0.0', 0), 1);
    const root = engine.store.root(job.id)!;
    ledger.db.prepare("UPDATE workflow_runs SET status='running',lease_owner='crashed',lease_until=0 WHERE id=?").run(root.id);
    ledger.db.prepare("UPDATE workflow_nodes SET status='running',output_json=NULL WHERE run_id=?").run(root.id);
    assert.equal(await engine.resume(root.id), 1); assert.equal(calls, 2);
    const externalJob = ledger.createJob({ title: 'external', requirements: 'test' });
    const external = new WorkflowEngine(ledger, new WorkflowRegistry().register(def(numeric('external', (v) => { if (fail) throw new Error('unknown'); return v; }, 'confirm'), number, number, 'external')));
    await assert.rejects(external.start(externalJob.id, 'external@1.0.0', 2), WorkflowUncertainError);
    const externalRoot = external.store.root(externalJob.id)!; fail = false;
    external.store.confirm(externalRoot.id, '/external', { action: 'retry' }, 'HR');
    assert.equal(await external.resume(externalRoot.id), 2);
  } finally { ledger.close(); }
});

test('取消阻止续跑；删除会话同时清理节点且保留定义与审计', async () => {
  const { ledger, job } = setup();
  try {
    const registry = new WorkflowRegistry().register(def(approval('wait', { title: 'wait', input: number }), number, number));
    const engine = new WorkflowEngine(ledger, registry);
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 0), ApprovalPendingError);
    const root = engine.store.root(job.id)!; engine.cancel(root.id);
    await assert.rejects(engine.resume(root.id), WorkflowCancelledError);
    assert.equal(ledger.deleteJob(job.id), true);
    assert.equal(new WorkflowStore(ledger).inspect(job.id).nodes.length, 0);
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM workflow_definitions').get()?.n, 1);
    assert.ok(ledger.listEvents({ jobId: job.id, limit: 100 }).length);
  } finally { ledger.close(); }
});

test('显式审批在默认模式下也等待人工，自动应答不能批准', async () => {
  const { ledger, job } = setup();
  try {
    const registry = new WorkflowRegistry().register(def(approval('human', { title: '人工核对', input: number }), number, number));
    const engine = new WorkflowEngine(ledger, registry, { approvalResponder: { ask: async () => ({ answer: '批准', actor: 'auto' }) } });
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 1), ApprovalPendingError);
    assert.equal(new ApprovalStore(ledger).list(job.id)[0].status, 'pending');
  } finally { ledger.close(); }
});

test('嵌套副作用确认后从祖先等待状态恢复，只允许确认实际任务节点', async () => {
  const { ledger, job } = setup(); let effects = 0;
  try {
    const child = def(sequence('child-steps', numeric('external', () => { effects++; throw new Error('unknown external result'); }, 'confirm'), numeric('after', (v) => v + 1)), number, number, 'external-child');
    const body = sequence('root-steps', numeric('before', (v) => v), subworkflow('external-child', 'external-child@1.0.0', number, number));
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(child).register(def(body, number, number)));
    await assert.rejects(engine.start(job.id, 'test@1.0.0', 1), WorkflowUncertainError);
    const view = engine.store.inspect(job.id); const root = engine.store.root(job.id)!;
    assert.ok(view.runs.every((r) => r.status === 'waiting_confirmation'));
    assert.throws(() => engine.store.confirm(root.id, '/root-steps', { action: 'complete', output: 999 }, 'HR'), /实际任务|任务节点/);
    const pending = view.nodes.find((n) => n.kind === 'task' && n.status === 'waiting_confirmation')!;
    engine.store.confirm(pending.run_id, pending.path, { action: 'complete', output: 4 }, 'HR');
    assert.equal(await engine.resume(root.id), 5); assert.equal(effects, 1);
    assert.ok(engine.store.inspect(job.id).runs.every((r) => r.status === 'succeeded'));
  } finally { ledger.close(); }
});

test('检查点拒绝有损 JSON 值及类实例，允许共享但无循环的对象', () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, { value: undefined }, [undefined], circular, new Date(), new Map()]) assert.throws(() => json(value), /工作流数据/);
  const shared = { valid: true };
  assert.equal(json({ a: shared, b: shared }), '{"a":{"valid":true},"b":{"valid":true}}');
});
