import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../../src/bootstrap.ts';
import { planScreening, type ScreeningInventory } from '../../src/agents/planner.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';

function inventory(usable: number): ScreeningInventory {
  return {
    usable,
    duplicates: 0,
    failed: 0,
    formats: { pdf: usable },
    resumeOnly: false,
    defaults: {
      batchSize: 8,
      maxBatchesInFlight: 2,
      pools: { parse: 4, assess: 2, review: 1 },
      deepEval: { enabled: true, percent: 40 },
    },
  };
}

test('规划 Agent 决定扇出与并发：单简历 single，多简历 batch', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({ requirements: '招 Java 后端，3 年经验。', provider: new FakeProvider() });
  try {
    const single = await planScreening(boot.deps, inventory(1));
    assert.equal(single.source, 'agent');
    assert.equal(single.mode, 'single');
    assert.equal(single.maxBatchesInFlight, 1);
    assert.deepEqual(single.pools, { parse: 1, assess: 1, review: 1 });
    assert.equal(single.deepEval.enabled, false);

    const multi = await planScreening(boot.deps, inventory(5));
    assert.equal(multi.source, 'agent');
    assert.equal(multi.mode, 'batch');
    assert.equal(multi.batchSize, 8);
    assert.deepEqual(multi.pools, { parse: 4, assess: 2, review: 1 });
    assert.equal(multi.deepEval.enabled, true);
  } finally {
    boot.close();
    await env.restore();
  }
});
