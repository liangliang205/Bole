import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Ledger } from '../../src/core/ledger.ts';
import { ExecutionScheduler } from '../../src/scheduler/execution.ts';
import type { ExecutionScope } from '../../src/scheduler/execution.ts';
import { WorkflowStore } from '../../src/workflow/store.ts';
import { AgentStore } from '../../src/agent-platform/store.ts';
import { currentExecutionId } from '../../src/scheduler/execution.ts';
import { WorkflowPausedError, WorkflowBusyError } from '../../src/workflow/types.ts';
import { defineWorkflow, task, sequence, WorkflowRegistry, WorkflowEngine } from '../../src/workflow/index.ts';
import { callAgentJson } from '../../src/agents/structured-call.ts';
import { runStructuredTask } from '../../src/core/structured.ts';
import type { AgentDeps } from '../../src/agents/deps.ts';
import type { LlmRouter } from '../../src/llm/router.ts';

function scope(ledger: Ledger, name: string): ExecutionScope & { jobId: string } {
  const job = ledger.createJob({ title: name, requirements: 'test' });
  const store = new WorkflowStore(ledger); const hash = store.define('scheduler-test@1.0.0', {});
  const row = store.create(job.id, 'scheduler-test@1.0.0', hash, {}); store.state(row.id, 'running');
  ledger.db.prepare('UPDATE workflow_runs SET lease_owner=?,lease_until=? WHERE id=?').run(name, Date.now() + 30000, row.id);
  return { jobId: job.id, runId: row.id, rootRunId: row.id, nodePath: '/task', checkpoint: () => {} };
}
const resource = [{ key: 'platform:agents', capacity: 1 }];
function latch() { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; }

test('多个会话共享容量，等待不计作失败或执行尝试，释放后继续派发', async () => {
  const ledger = new Ledger(':memory:'); const lock = latch();
  try {
    const scheduler = new ExecutionScheduler(ledger); const a = scope(ledger, 'a'); const b = scope(ledger, 'b');
    let active = 0; let peak = 0;
    const first = scheduler.run(a, 'work', resource, async () => { active++; peak = Math.max(peak, active); await lock.wait; active--; return 1; });
    const second = scheduler.run(b, 'work', resource, async () => { active++; peak = Math.max(peak, active); active--; return 2; });
    const queued = scheduler.list(b.jobId)[0]; assert.equal(queued.state, 'queued'); assert.equal(queued.attempts, 0); assert.match(queued.reason!, /等待/);
    await assert.rejects(scheduler.run(b, 'work', resource, async () => 3), WorkflowBusyError);
    lock.release(); assert.deepEqual(await Promise.all([first, second]), [1, 2]); assert.equal(peak, 1);
    assert.equal(scheduler.list(b.jobId)[0].attempts, 1); assert.equal(scheduler.list(b.jobId)[0].state, 'succeeded');
  } finally { lock.release(); ledger.close(); }
});

test('简单优先级和老化只影响尚未开始的任务，不抢占在途操作', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const scheduler = new ExecutionScheduler(ledger);
    for (const aged of [false, true]) {
      const lock = latch(); const order: string[] = [];
      const hold = scope(ledger, `hold-${aged}`); const low = scope(ledger, `low-${aged}`); const high = scope(ledger, `high-${aged}`);
      const holder = scheduler.run(hold, 'hold', resource, async () => { await lock.wait; });
      const lowRun = scheduler.run(low, 'low', resource, async () => { order.push('low'); }, 0);
      if (aged) ledger.db.prepare('UPDATE execution_queue SET created_at=? WHERE run_id=?').run(Date.now() - 180000, low.runId);
      const highRun = scheduler.run(high, 'high', resource, async () => { order.push('high'); }, 2);
      assert.deepEqual(order, []); lock.release(); await Promise.all([holder, lowRun, highRun]);
      assert.deepEqual(order, aged ? ['low', 'high'] : ['high', 'low']);
    }
  } finally { ledger.close(); }
});

test('等待中暂停会撤回派发，恢复复用同一队列条目', async () => {
  const ledger = new Ledger(':memory:'); const lock = latch();
  try {
    const scheduler = new ExecutionScheduler(ledger); const a = scope(ledger, 'a'); const b = scope(ledger, 'b'); let paused = false; let executed = false;
    b.checkpoint = () => { if (paused) throw new WorkflowPausedError(); };
    const holder = scheduler.run(a, 'hold', resource, async () => { await lock.wait; });
    const pending = scheduler.run(b, 'work', resource, async () => { executed = true; }); const id = scheduler.list(b.jobId)[0].id;
    paused = true; await assert.rejects(pending, WorkflowPausedError); assert.equal(executed, false); assert.equal(scheduler.list(b.jobId)[0].attempts, 0);
    paused = false; lock.release(); await holder;
    await scheduler.run(b, 'work', resource, async () => { executed = true; });
    assert.equal(executed, true); assert.equal(scheduler.list(b.jobId)[0].id, id);
  } finally { lock.release(); ledger.close(); }
});

test('数据库重开后保留待办，过期租约释放容量，新执行者不能被旧结果覆盖', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bole-execution-')); const filename = path.join(directory, 'ledger.db');
  let ledger = new Ledger(filename);
  try {
    let scheduler = new ExecutionScheduler(ledger); const a = scope(ledger, 'crashed');
    const item = scheduler.enqueue(a, 'work', resource);
    ledger.db.prepare("UPDATE execution_queue SET state='running' WHERE id=?").run(item.id);
    ledger.db.prepare('UPDATE workflow_runs SET lease_until=0 WHERE id=?').run(a.runId);
    ledger.close(); ledger = new Ledger(filename); scheduler = new ExecutionScheduler(ledger);
    assert.equal(scheduler.list(a.jobId)[0].state, 'interrupted');
    assert.equal(ledger.db.prepare('SELECT state FROM execution_queue WHERE id=?').get(item.id)?.state, 'running');
    ledger.db.prepare('UPDATE workflow_runs SET lease_owner=?,lease_until=? WHERE id=?').run('successor', Date.now() + 30000, a.runId);
    assert.equal(await scheduler.run(a, 'work', resource, async () => 7), 7);
    assert.equal(scheduler.list(a.jobId)[0].id, item.id); assert.equal(scheduler.list(a.jobId)[0].owner, 'successor');
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test('工作流依赖仍由顺序节点保证，成功节点与执行队列均不重复运行', async () => {
  const ledger = new Ledger(':memory:'); let first = 0; let second = 0;
  try {
    const job = ledger.createJob({ title: 'workflow', requirements: 'test' });
    const before = task({ id: 'before', input: z.number(), output: z.number(), recovery: 'retry', handler: (v, ctx) => ctx.schedule('before', resource, async () => { first++; return v + 1; }) });
    const after = task({ id: 'after', input: z.number(), output: z.number(), recovery: 'retry', handler: (v, ctx) => ctx.schedule('after', resource, async () => { assert.equal(first, 1); second++; return v + 1; }) });
    const definition = defineWorkflow({ id: 'scheduled', version: '1.0.0', implementation: 'test', input: z.number(), output: z.number(), body: sequence('main', before, after) });
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(definition));
    assert.equal(await engine.start(job.id, 'scheduled@1.0.0', 0), 2);
    assert.equal(await engine.resume(engine.store.root(job.id)!.id), 2); assert.equal(first, 1); assert.equal(second, 1);
    const queue = new ExecutionScheduler(ledger).list(job.id); assert.equal(queue.length, 2); assert.ok(queue.every((r) => r.attempts === 1));
    assert.equal(ledger.deleteJob(job.id), true); assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM execution_queue').get()?.n, 0);
  } finally { ledger.close(); }
});

test('执行者失去根租约后不能覆盖新执行者的节点与运行状态', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: 'fencing', requirements: 'test' });
    const body = task({ id: 'work', input: z.number(), output: z.number(), recovery: 'retry', handler: async (v, ctx) => {
      ledger.db.prepare('UPDATE workflow_runs SET lease_owner=?,lease_until=? WHERE id=?').run('new-owner', Date.now() + 30000, ctx.rootRunId); return v;
    } });
    const definition = defineWorkflow({ id: 'fencing', version: '1.0.0', implementation: 'test', input: z.number(), output: z.number(), body });
    const engine = new WorkflowEngine(ledger, new WorkflowRegistry().register(definition));
    await assert.rejects(engine.start(job.id, 'fencing@1.0.0', 1), WorkflowPausedError);
    const root = engine.store.root(job.id)!; assert.equal(root.lease_owner, 'new-owner'); assert.equal(root.status, 'running');
    assert.equal(engine.store.node(root.id, '/work')?.status, 'running');
  } finally { ledger.close(); }
});

test('Agent 非队列调用占用容量，队列内调用与预留不会重复计数', async () => {
  const ledger = new Ledger(':memory:'); const lock = latch(); let first: Promise<void> | undefined; let second: Promise<void> | undefined;
  try {
    const a = scope(ledger, 'a'); const b = scope(ledger, 'b');
    const agents = new AgentStore(ledger); agents.seed();
    const version = agents.get(agents.active().find((v) => v.agent_id === 'assessor')!.version_key!);
    const binding = { key: version.version_key, hash: version.content_hash, definition: JSON.parse(version.definition_json), reason: 'test' };
    const external = agents.beginInvocation(a.jobId, 'assessor', binding, {}, {});
    const scheduler = new ExecutionScheduler(ledger);
    const restricted = [{ key: `agent:${binding.key}`, capacity: 1 }]; let started = false;
    const waiting = scheduler.run(b, 'wait-external', restricted, async () => { started = true; });
    await delay(50); assert.equal(started, false);
    agents.finishInvocation(external, true, {}); await waiting; assert.equal(started, true);
    const capacityTwo = [{ key: `agent:${binding.key}`, capacity: 2 }]; let secondStarted = false;
    first = scheduler.run(a, 'own', capacityTwo, async () => {
      const id = agents.beginInvocation(a.jobId, 'assessor', binding, {}, { executionId: currentExecutionId() });
      try { await lock.wait; } finally { agents.finishInvocation(id, true, {}); }
    });
    second = scheduler.run(b, 'second', capacityTwo, async () => { secondStarted = true; });
    await delay(90); assert.equal(secondStarted, true, 'first 的预留及 invocation 必须只算一份容量');
  } finally { lock.release(); await Promise.all([first, second]); ledger.close(); }
});

test('暂停信号不进入模型通用重试或失败结算，业务任务保留可恢复状态', async () => {
  const ledger = new Ledger(':memory:'); let calls = 0;
  try {
    const job = ledger.createJob({ title: 'pause', requirements: 'test' });
    const llm = { chat: async () => { calls++; throw new WorkflowPausedError(); } } as unknown as LlmRouter;
    const deps = { ledger, llm, jobId: job.id, config: { structuredOutput: { maxAttempts: 3 } } } as AgentDeps;
    await assert.rejects(callAgentJson(deps, { agent: 'profiler', tier: 'pro', schemaName: 'profile', schema: z.object({ ok: z.boolean() }), system: 'test', user: 'test' }), WorkflowPausedError);
    assert.equal(calls, 1);
    const task = ledger.createTask('eval', { jobId: job.id, resumeId: 'test', batchId: 1 });
    await assert.rejects(runStructuredTask({ ledger, llm, kind: 'eval', taskId: task.id, jobId: job.id, resumeId: 'test', batchId: 1, workerId: 'test', agent: 'assessor', tier: 'flash', schemaName: 'test', schema: z.object({ ok: z.boolean() }), system: 'test', user: 'test', runDir: os.tmpdir(), maxAttempts: 3 }), WorkflowPausedError);
    assert.equal(calls, 2); assert.equal(ledger.getTask('eval', task.id)?.status, 'aborted');
  } finally { ledger.close(); }
});
