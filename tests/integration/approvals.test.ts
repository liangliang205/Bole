import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { ApprovalStore, ApprovalPendingError } from '../../src/core/approvals.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { WorkflowStore } from '../../src/workflow/store.ts';

test('严格流水线：计划前不解析，重启恢复审批，发布前不落报告，批准后续跑发布', async () => {
  const env = await setupTempEnv();
  let boot: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    const file = path.join(env.dir, 'resume.txt');
    const text = '姓名：张伟\n工作年限：5年\n技能：Java、Spring Boot、MySQL\n项目：负责支付系统，优化接口性能。';
    await writeFile(file, text);
    const provider = new FakeProvider();
    boot = await bootstrap({ requirements: '招聘 Java 后端，熟悉 MySQL。', provider, executionMode: 'strict' });
    const jobId = boot.job.id;
    const dbPath = boot.deps.paths.dbPath;
    const hitl = new AutoHitlResponder();
    await assert.rejects(runPipeline(boot.deps, { requirements: boot.job.requirements, hitl,
      uploadFiles: [{ uploadId: 'u', filename: 'resume.txt', path: file, size: Buffer.byteLength(text), contentType: 'text/plain' }],
    }), ApprovalPendingError);
    assert.equal(boot.deps.ledger.listTasks('parse', { jobId }).length, 0);
    boot.close(); boot = undefined;
    const reopened = new Ledger(dbPath);
    const store = new ApprovalStore(reopened);
    assert.equal(store.mode(jobId), 'strict');
    store.decide(store.list(jobId)[0].id, jobId, true, 'HR(test)');
    reopened.close();
    boot = await bootstrap({ requirements: '招聘 Java 后端，熟悉 MySQL。', jobId, provider });
    await assert.rejects(runPipeline(boot.deps, { requirements: boot.job.requirements, hitl, resumeOnly: true }), ApprovalPendingError);
    const resumed = new ApprovalStore(boot.deps.ledger);
    const publication = resumed.list(jobId).find((a) => a.kind === 'publish-report')!;
    assert.ok(publication);
    const publicationRun = new WorkflowStore(boot.deps.ledger).inspect(jobId).runs.find((r) => r.workflow_key === 'report-publication@1.4.0');
    assert.equal(publicationRun?.status, 'waiting_approval');
    assert.ok(publicationRun?.parent_run_id);
    assert.notEqual(boot.deps.ledger.getJob(jobId)?.status, 'completed');
    assert.equal(existsSync(path.join(boot.deps.runDir, 'report.json')), false);
    const tasks = boot.deps.ledger.listTasks('parse', { jobId }).length;
    resumed.decide(publication.id, jobId, true, 'HR(test)');
    const result = await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl, resumeOnly: true });
    assert.equal(result.status, 'final');
    assert.equal(boot.deps.ledger.listTasks('parse', { jobId }).length, tasks);
    assert.equal(resumed.list(jobId).length, 2);
    assert.equal(new WorkflowStore(boot.deps.ledger).get(publicationRun!.id).status, 'succeeded');
  } finally { boot?.close(); await env.restore(); }
});
