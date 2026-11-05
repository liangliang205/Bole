import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { MemoryService } from '../../src/memory/service.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';
import type { HitlResponder } from '../../src/agents/hitl.ts';

test('人工批准评分卡 → 新任务显式复用 → 冻结快照 → 新版本与退役不改变续跑', async () => {
  const env = await setupTempEnv();
  let boot: Awaited<ReturnType<typeof bootstrap>> | undefined;
  const hitl: HitlResponder = { ask: async (q) => ({ answer: q.id === 'reuse_policy' ? '采用所选评分标准' : q.recommendedOption, actor: 'HR(test)' }) };
  try {
    const file = path.join(env.dir, 'resume.txt');
    const text = '姓名：张伟\n工作年限：5年\n技能：Java、Spring Boot、MySQL\n项目：负责支付系统，优化接口性能。';
    await writeFile(file, text);
    const files = [{ uploadId: 'u', filename: 'resume.txt', path: file, size: Buffer.byteLength(text), contentType: 'text/plain' }];
    const requirements = '招聘 Java 后端，熟悉 MySQL、支付系统。';
    boot = await bootstrap({ requirements, provider: new FakeProvider() });
    await runPipeline(boot.deps, { requirements, hitl, uploadFiles: files });
    const memory = new MemoryService(boot.deps.ledger);
    const family = memory.createFamily('支付后端');
    const profile = JSON.parse(memory.binding(boot.job.id)!.snapshot_json);
    const p = memory.proposePolicy({ familyId: family.id, sourceJobId: boot.job.id, profile, rule: '复用支付岗位评分', why: '相同业务', howToApply: '新任务' });
    const v1 = memory.approveProposal(p.id, p.content_hash, 'HR(test)');
    boot.close(); boot = undefined;
    boot = await bootstrap({ requirements, provider: new FakeProvider(), policyVersionId: v1.id });
    await runPipeline(boot.deps, { requirements, hitl, uploadFiles: files });
    const nextMemory = new MemoryService(boot.deps.ledger);
    const binding = nextMemory.binding(boot.job.id)!;
    assert.equal(binding.version_id, v1.id);
    assert.deepEqual(JSON.parse(binding.snapshot_json).scorecard, profile.scorecard);
    const p2 = nextMemory.proposePolicy({ familyId: family.id, baseVersionId: v1.id, profile, rule: '补充适用解释', why: '业务确认', howToApply: '仅新任务' });
    nextMemory.approveProposal(p2.id, p2.content_hash, 'HR(test)');
    nextMemory.retireVersion(v1.id);
    boot.deps.config.conclusionScale = { strong_yes: 99, yes: 98, maybe: 97, no: 96 };
    await runPipeline(boot.deps, { requirements, hitl, resumeOnly: true });
    assert.equal(nextMemory.binding(boot.job.id)?.snapshot_hash, binding.snapshot_hash);
    assert.deepEqual(JSON.parse(binding.snapshot_json).thresholds, profile.thresholds);
  } finally { boot?.close(); await env.restore(); }
});
