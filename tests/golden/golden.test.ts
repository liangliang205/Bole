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

const inboxDir = path.join(projectRoot(), 'data', 'inbox');
const expectationsFile = path.join(projectRoot(), 'data', 'golden', 'expectations.json');

interface Expectations {
  top5: string[];
  top5Scores: Record<string, number>;
  scoreTolerance: number;
  expectedStatusCounts: Record<string, number>;
  escalated: string[];
  duplicate: string;
  parseFailed: string[];
  selfLoop: { escalations: number; minRevisions: number };
}

before(async () => {
  if (!existsSync(path.join(inboxDir, 'R01.eml'))) await generateGoldenSet();
});

test('黄金集回归：Top5、陷阱样本与自环统计与冻结基线一致', async () => {
  const expectations = JSON.parse(readFileSync(expectationsFile, 'utf8')) as Expectations;
  const env = await setupTempEnv();
  const boot = await bootstrap({
    requirements: DEMO_REQUIREMENTS,
    seed: 'golden-2026',
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
    assert.deepEqual(summary.top.map((item) => item.label), expectations.top5);
    for (const candidate of summary.top) {
      const expected = expectations.top5Scores[candidate.label];
      assert.ok(
        Math.abs(candidate.totalScore - expected) <= expectations.scoreTolerance,
        `${candidate.label} 分数漂移过大：${candidate.totalScore} vs ${expected}`,
      );
    }

    const counts = boot.deps.ledger.resumeCounts(boot.job.id);
    for (const [status, expected] of Object.entries(expectations.expectedStatusCounts)) {
      assert.equal(counts[status], expected, `简历状态 ${status} 与基线不一致`);
    }

    const report = JSON.parse(readFileSync(summary.reports.json, 'utf8')) as {
      top: { label: string; evalTier: string; evalPhase: string }[];
      escalations: { label: string }[];
      compliance: { duplicates: { label: string }[]; failed: { label: string }[] };
    };
    assert.deepEqual(summary.top.map((item) => item.label), expectations.top5);
    assert.ok(report.top.every((item) => item.evalTier === 'pro' && item.evalPhase === 'deep'), 'Top5 应全部经过 pro 深评');
    assert.deepEqual(report.escalations.map((item) => item.label).sort(), [...expectations.escalated].sort());
    assert.deepEqual(report.compliance.duplicates.map((item) => item.label), [expectations.duplicate]);
    assert.deepEqual(report.compliance.failed.map((item) => item.label), expectations.parseFailed);

    const selfLoop = boot.deps.ledger.selfLoopStats(boot.job.id);
    assert.equal(selfLoop.escalations, expectations.selfLoop.escalations);
    assert.ok(selfLoop.revisions >= expectations.selfLoop.minRevisions);

    // R17 模拟幻觉被驳回后，同一 Worker 修正并通过核查
    const r17 = boot.deps.ledger.listResumes(boot.job.id).find((resume) => resume.label === 'R17')!;
    const reviews = boot.deps.ledger
      .listTasks('review', { jobId: boot.job.id })
      .filter((task) => task.resume_id === r17.id);
    assert.equal(reviews[0].verdict, 're_eval');
    assert.equal(reviews[reviews.length - 1].verdict, 'pass');
  } finally {
    boot.close();
    await env.restore();
  }
});
