import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { runFetcher } from '../../src/agents/fetcher.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { HireboxClient, type McpTransport } from '../../src/mcp/client.ts';
import { DEMO_FAULTS, DEMO_REQUIREMENTS } from '../../src/cli/demo-data.ts';
import { generateGoldenSet } from '../../scripts/generate-golden.ts';
import { projectRoot } from '../../src/util/fsx.ts';
import { setupTempEnv } from '../helpers/env.ts';

const inboxDir = path.join(projectRoot(), 'data', 'inbox');

before(async () => {
  if (!existsSync(path.join(inboxDir, 'R01.eml'))) await generateGoldenSet();
});

test('错误注入：MCP 超时不影响台账一致性，失败如实上报', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({ requirements: DEMO_REQUIREMENTS, seed: 'err-mcp', llm: 'mock' });
  const failing: McpTransport = {
    kind: 'fake-timeout',
    async request() {
      throw new Error('MCP 请求超时：inbox.list (5000ms)');
    },
    notify() {},
    async close() {},
  };
  try {
    const client = new HireboxClient(failing);
    const result = await runFetcher(boot.deps, { inboxDir, client });
    assert.equal(result.manifest.pulled, 0);
    assert.equal(result.resumes.length, 0);
    assert.equal(result.manifest.failed.length, 1);
    assert.match(result.manifest.failed[0].reason, /超时/);
    assert.equal(boot.deps.ledger.listResumes(boot.job.id).length, 0);
    assert.ok(
      boot.deps.ledger
        .listEvents({ jobId: boot.job.id, limit: 100 })
        .some((event) => event.type === 'fetch.failed'),
    );
  } finally {
    boot.close();
    await env.restore();
  }
});

test('错误注入：每份任务首轮 schema 违规，同轮重试后仍完成全流程', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({
    requirements: DEMO_REQUIREMENTS,
    seed: 'err-schema',
    llm: 'mock',
    faults: { ...DEMO_FAULTS, invalidSchemaFor: ['*'] },
  });
  try {
    const summary = await runPipeline(boot.deps, {
      requirements: DEMO_REQUIREMENTS,
      hitl: new AutoHitlResponder(),
      inboxDir,
    });
    assert.equal(summary.status, 'final');
    assert.deepEqual(
      summary.top.map((item) => item.label),
      ['R01', 'R05', 'R11', 'R03', 'R15'],
    );
    const parses = boot.deps.ledger.listTasks('parse', { jobId: boot.job.id });
    assert.ok(parses.length >= 18);
    for (const task of parses) {
      assert.equal(task.status, 'committed');
      assert.equal(task.attempt, 2, '首轮违规后应在同一轮内重试并落账 attempt=2');
    }
    const evals = boot.deps.ledger.listTasks('eval', { jobId: boot.job.id });
    assert.ok(evals.some((task) => task.attempt === 2 && task.status === 'committed'));
  } finally {
    boot.close();
    await env.restore();
  }
});
