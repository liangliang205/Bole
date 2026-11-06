import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/core/ledger.ts';
import { assertScreeningComplete, prepareReport, publishReport } from '../../src/workflows/recruitment/report.ts';
import type { AgentDeps } from '../../src/agents/deps.ts';
import type { PipelineRunOptions } from '../../src/agents/coordinator.ts';
import type { Publication } from '../../src/workflows/recruitment/report.ts';

test('所有候选人到达明确终态才允许报告；生成和发布入口均拦截未完成任务', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: 'completion', requirements: 'test' });
    const row = ledger.insertResume({ id: 'resume-test', jobId: job.id, label: 'R01', sha256: 'test', dedupKey: 'test', sourceMsgId: 'test', sourcePath: '', rawPath: '', normPath: '', format: 'txt', status: 'queued' });
    const deps = { ledger, jobId: job.id } as AgentDeps;
    for (const status of ['queued', 'parsing', 'parsed', 'evaluating', 'evaluated', 'verifying'] as const) {
      ledger.forceResumeStatus(row.id, status, 'test');
      assert.throws(() => assertScreeningComplete(deps), /筛选尚未完成/);
      await assert.rejects(prepareReport(deps, [], Date.now(), false), /禁止发布/);
      await assert.rejects(publishReport(deps, {} as PipelineRunOptions, {} as Publication), /禁止发布/);
    }
    for (const status of ['verified', 'reported', 'quarantine', 'failed', 'duplicate'] as const) {
      ledger.forceResumeStatus(row.id, status, 'test');
      assert.doesNotThrow(() => assertScreeningComplete(deps));
    }
  } finally { ledger.close(); }
});
