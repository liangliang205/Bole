import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { Ledger } from '../../src/core/ledger.ts';
import { runStructuredTask } from '../../src/core/structured.ts';
import { LlmRouter } from '../../src/llm/router.ts';
import { MockProvider } from '../../src/llm/mock.ts';
import { AlreadyCommittedError } from '../../src/core/state.ts';

const pricing = {
  m1: { inputPerMTok: 1, outputPerMTok: 2, cacheHitPerMTok: 0.1 },
  m2: { inputPerMTok: 1, outputPerMTok: 2, cacheHitPerMTok: 0.1 },
};

async function setup(taskKey: string, schema: z.ZodTypeAny = z.object({ ok: z.boolean() }), invalid = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-structured-'));
  const ledger = new Ledger(':memory:');
  const job = ledger.createJob({ title: 't', requirements: 'r' });
  const task = ledger.createTask('eval', { jobId: job.id, resumeId: 'res_1', batchId: 1 });
  const provider = new MockProvider({ invalidSchemaOnce: invalid ? [taskKey === 'task' ? task.id : taskKey] : [] });
  const router = new LlmRouter({
    provider,
    pricing,
    models: { flash: 'm1', pro: 'm2' },
    ledger,
    jobId: job.id,
  });
  return { dir, ledger, job, task, router, schema };
}

test('schema 校验失败同轮重试，成功后两阶段提交', async () => {
  const ctx = await setup('task', z.object({ ok: z.boolean() }), true);
  try {
    const outcome = await runStructuredTask({
      kind: 'eval',
      taskId: ctx.task.id,
      jobId: ctx.job.id,
      resumeId: 'res_1',
      batchId: 1,
      workerId: 'assessor#1',
      agent: 'assessor',
      tier: 'flash',
      schemaName: 'structured_test',
      schema: ctx.schema,
      system: 'sys',
      user: 'user',
      runDir: ctx.dir,
      ledger: ctx.ledger,
      llm: ctx.router,
      maxAttempts: 2,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.attempts, 2);
      assert.ok(outcome.artifactPath.endsWith('.json'));
      const artifact = JSON.parse(await readFile(outcome.artifactPath, 'utf8')) as { value: { ok: boolean } };
      assert.equal(artifact.value.ok, true);
    }
    const committed = ctx.ledger.getTask('eval', ctx.task.id);
    assert.equal(committed?.status, 'committed');
    assert.equal(committed?.stop_reason, 'completed');
    assert.equal(committed?.attempt, 2);
  } finally {
    ctx.ledger.close();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('提交后写入被单调守卫拒绝', async () => {
  const ctx = await setup('task');
  try {
    const outcome = await runStructuredTask({
      kind: 'eval',
      taskId: ctx.task.id,
      jobId: ctx.job.id,
      resumeId: 'res_1',
      batchId: 1,
      workerId: 'assessor#1',
      agent: 'assessor',
      tier: 'flash',
      schemaName: 'structured_test',
      schema: ctx.schema,
      system: 'sys',
      user: 'user',
      runDir: ctx.dir,
      ledger: ctx.ledger,
      llm: ctx.router,
    });
    assert.equal(outcome.ok, true);
    assert.throws(() => ctx.ledger.updateTask('eval', ctx.task.id, { attempt: 9 }), AlreadyCommittedError);
    assert.throws(() => ctx.ledger.commitTask('eval', ctx.task.id, 'x'), AlreadyCommittedError);
  } finally {
    ctx.ledger.close();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test('持续不符合 schema 的任务标记失败并记录 stop_reason', async () => {
  const ctx = await setup('task', z.object({ value: z.number() }));
  try {
    const outcome = await runStructuredTask({
      kind: 'eval',
      taskId: ctx.task.id,
      jobId: ctx.job.id,
      resumeId: 'res_1',
      batchId: 1,
      workerId: 'assessor#1',
      agent: 'assessor',
      tier: 'flash',
      schemaName: 'structured_test',
      schema: ctx.schema,
      system: 'sys',
      user: 'user',
      runDir: ctx.dir,
      ledger: ctx.ledger,
      llm: ctx.router,
      maxAttempts: 2,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.stopReason, 'error');
    const failed = ctx.ledger.getTask('eval', ctx.task.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.stop_reason, 'error');
    assert.match(String(failed?.error_json), /value/);
  } finally {
    ctx.ledger.close();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});
