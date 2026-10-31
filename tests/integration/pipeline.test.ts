import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { DEMO_FAULTS, DEMO_REQUIREMENTS } from '../../src/cli/demo-data.ts';
import { generateGoldenSet } from '../../scripts/generate-golden.ts';
import { projectRoot } from '../../src/util/fsx.ts';
import { setupTempEnv } from '../helpers/env.ts';
import type { EventRow } from '../../src/types.ts';

const inboxDir = path.join(projectRoot(), 'data', 'inbox');

before(async () => {
  if (!existsSync(path.join(inboxDir, 'R01.eml'))) await generateGoldenSet();
});

function payload(event: EventRow): Record<string, unknown> {
  return JSON.parse(event.payload_json) as Record<string, unknown>;
}

test('端到端：批流动 + 证据核查 + Self-Loop + 汇总 HITL', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({
    requirements: DEMO_REQUIREMENTS,
    seed: 'it-2026',
    llm: 'mock',
    faults: DEMO_FAULTS,
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

    const counts = boot.deps.ledger.resumeCounts(boot.job.id);
    assert.equal(counts.reported, 16);
    assert.equal(counts.quarantine, 2);
    assert.equal(counts.duplicate, 1);
    assert.equal(counts.failed, 1);

    // 每个解析任务都经过 pending→running→staged→committed
    for (const task of boot.deps.ledger.listTasks('parse', { jobId: boot.job.id })) {
      assert.equal(task.status, 'committed');
      assert.equal(task.stop_reason, 'completed');
      assert.ok(task.result_path && existsSync(task.result_path));
    }

    // 验真环：R17 续用同一个 Worker 修正后通过
    const events = boot.deps.ledger.listEvents({ jobId: boot.job.id, limit: 5000 });
    const reused = events.filter((event) => event.type === 'worker.reused');
    assert.ok(reused.some((event) => payload(event).label === 'R17'));
    assert.ok(events.some((event) => event.type === 'selfloop.revise'));
    assert.ok(summary.selfLoop.revisions >= 2);
    assert.equal(summary.selfLoop.escalations, 2);

    // 分档设计：扇出初筛全量 flash；短名单 pro 深评；监军始终 pro
    const evalTasks = boot.deps.ledger.listTasks('eval', { jobId: boot.job.id });
    const screenEvals = evalTasks.filter((task) => task.phase === 'screen');
    const deepEvals = evalTasks.filter((task) => task.phase === 'deep');
    assert.ok(screenEvals.length >= 18);
    assert.ok(screenEvals.every((task) => task.tier === 'flash'), '扇出初筛应全部使用 flash');
    assert.ok(deepEvals.length > 0, '应有短名单进入 pro 深评');
    assert.ok(deepEvals.every((task) => task.tier === 'pro'), '深评应全部使用 pro');
    assert.ok(events.some((event) => event.type === 'deep_eval.shortlist'));
    const reviewTiers = boot.deps.ledger.listTasks('review', { jobId: boot.job.id });
    assert.ok(reviewTiers.length >= 18);

    // 无全量屏障：第 2 批在第 1 批完成前就已经开始解析
    const batch2Start = events.find(
      (event) => event.type === 'batch.started' && payload(event).batchId === 2,
    );
    const batch1Done = events.find(
      (event) => event.type === 'batch.completed' && payload(event).batchId === 1,
    );
    assert.ok(batch2Start && batch1Done);
    assert.ok(batch2Start!.seq < batch1Done!.seq, '批间流动失效：第 2 批似乎在等第 1 批完成');

    // 报告产物齐备且 JSON 可读
    for (const file of Object.values(summary.reports)) {
      assert.ok(existsSync(file), `缺少报告文件 ${file}`);
    }
    const report = JSON.parse(readFileSync(summary.reports.json, 'utf8')) as {
      top: { label: string }[];
      compliance: { duplicates: { label: string }[]; failed: { label: string }[] };
      hitl: unknown[];
    };
    assert.equal(report.top[0].label, 'R01');
    assert.equal(report.compliance.duplicates[0].label, 'R18');
    assert.equal(report.compliance.failed[0].label, 'R19');
    assert.ok(report.hitl.length >= 4);

    // 两阶段提交后的任务不可再写
    const committedTask = boot.deps.ledger.listTasks('parse', { jobId: boot.job.id })[0];
    assert.throws(() => boot.deps.ledger.updateTask('parse', committedTask.id, { attempt: 99 }));

    // 批次级检查点恢复：把已上报简历重置为 verifying，续跑后应重新核查并回到 reported
    const reported = boot.deps.ledger.listResumes(boot.job.id).find((resume) => resume.status === 'reported');
    assert.ok(reported);
    boot.deps.ledger.forceResumeStatus(reported!.id, 'verifying', 'simulated crash');
    const resumed = await runPipeline(boot.deps, {
      requirements: DEMO_REQUIREMENTS,
      hitl: new AutoHitlResponder(),
      inboxDir,
      resumeOnly: true,
    });
    assert.equal(resumed.status, 'final');
    assert.equal(boot.deps.ledger.getResume(reported!.id)?.status, 'reported');
    assert.ok(
      boot.deps.ledger
        .listEvents({ jobId: boot.job.id, limit: 5000 })
        .some((event) => event.type === 'recovery.resume_reset'),
    );
  } finally {
    boot.close();
    await env.restore();
  }
});
