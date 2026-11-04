import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapacityPool, PoolFullError, admissionOptions, withAgentSlot } from '../../src/core/pool.ts';

test('容量池满载直接拒绝，不维护排队队列', () => {
  const pool = new CapacityPool('parse', 2);
  const first = pool.tryAcquire('r1');
  const second = pool.tryAcquire('r2');
  assert.ok(first);
  assert.ok(second);
  assert.equal(pool.tryAcquire('r3'), null);
  assert.equal(pool.stats().refused, 1);
  assert.equal(pool.stats().active, 2);

  first.release();
  assert.equal(pool.stats().active, 1);
  const third = pool.tryAcquire('r3');
  assert.ok(third);
  assert.equal(pool.stats().peak, 2);
  third.release();
  second.release();
  assert.equal(pool.stats().released, 3);
});

test('重复 release 不会把并发计数减错', () => {
  const pool = new CapacityPool('review', 1);
  const slot = pool.tryAcquire('r1');
  assert.ok(slot);
  slot.release();
  slot.release();
  assert.equal(pool.stats().active, 0);
  assert.equal(pool.stats().released, 1);
});

test('admission 在名额释放后取得槽位', async () => {
  const pool = new CapacityPool('assess', 1);
  const held = await pool.acquire('a', admissionOptions({ timeoutMs: 1000 }));
  const waiting = pool.acquire('b', admissionOptions({ timeoutMs: 1000, baseBackoffMs: 1, maxBackoffMs: 5 }));
  setTimeout(() => held.release(), 10);
  const acquired = await waiting;
  assert.ok(acquired);
  acquired.release();
  assert.ok(pool.stats().refused >= 1);
});

test('admission 在超限时抛出 PoolFullError', async () => {
  const pool = new CapacityPool('assess', 1);
  const held = await pool.acquire('a', admissionOptions({ timeoutMs: 1000 }));
  await assert.rejects(
    () =>
      pool.acquire(
        'b',
        admissionOptions({ maxRefusalRetries: 1, baseBackoffMs: 1, maxBackoffMs: 2, timeoutMs: 200 }),
      ),
    PoolFullError,
  );
  held.release();
});

test('withAgentSlot：跨阶段共享统一总上限，实际活跃数不超过 maxActiveAgents', async () => {
  const budget = new CapacityPool('agents', 2);
  const parse = new CapacityPool('parse', 5);
  const assess = new CapacityPool('assess', 5);
  const opts = admissionOptions({ timeoutMs: 3000, baseBackoffMs: 1, maxBackoffMs: 5, maxRefusalRetries: 5000 });
  let active = 0;
  let peak = 0;
  const run = (pool: CapacityPool, label: string) =>
    withAgentSlot(budget, pool, label, opts, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    });
  await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => run(parse, `p${i}`)),
    ...Array.from({ length: 4 }, (_, i) => run(assess, `a${i}`)),
  ]);
  assert.equal(peak, 2);
  assert.equal(budget.stats().peak, 2);
  assert.equal(active, 0);
  assert.equal(budget.stats().active, 0);
});
