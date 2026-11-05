import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../../src/core/ledger.ts';
import { MemoryService } from '../../src/memory/service.ts';
import { memoryRoute } from '../../src/memory/http.ts';
import { buildMemoryContext, readJobMemory } from '../../src/memory/context.ts';
import type { PolicyProfile } from '../../src/memory/types.ts';

const profile = (): PolicyProfile => ({ jd: { title: 'Java 后端', responsibilities: ['支付服务开发'], hardRequirements: ['Java'], niceToHave: ['MySQL'], exclusions: [], location: '', compensation: '', teamContext: '' },
  scorecard: { version: '1', dimensions: [
    { key: 'java', name: '技术能力', weight: 40, anchors: {} },
    { key: 'project', name: '项目实践', weight: 40, anchors: {} },
    { key: 'communication', name: '沟通', weight: 20, anchors: {} },
  ] } });
function setup() {
  const ledger = new Ledger(':memory:');
  const memory = new MemoryService(ledger);
  const family = memory.createFamily('支付后端');
  const input = { familyId: family.id, rule: '采用项目证据评分', why: '项目更贴近岗位', howToApply: '仅用于新任务', profile: profile() };
  return { ledger, memory, family, input };
}

test('规则批准前不生效，拒绝/自动应答/哈希不匹配不能发布，真人批准幂等', () => {
  const { ledger, memory, family, input } = setup();
  try {
    const p = memory.proposePolicy(input);
    assert.deepEqual(memory.recallPolicies(family.id), []);
    assert.throws(() => memory.approveProposal(p.id, 'wrong', 'HR'), /变化/);
    assert.throws(() => memory.approveProposal(p.id, p.content_hash, 'HR(auto)'), /真人/);
    const version = memory.approveProposal(p.id, p.content_hash, 'HR(test)');
    assert.equal(memory.approveProposal(p.id, p.content_hash, 'HR(test)').id, version.id);
    assert.equal(memory.recallPolicies(family.id).length, 1);
    const next = memory.proposePolicy({ ...input, baseVersionId: version.id });
    memory.rejectProposal(next.id, next.content_hash, 'HR(test)');
    assert.throws(() => memory.approveProposal(next.id, next.content_hash, 'HR(test)'), /拒绝/);
    assert.equal(memory.versions().length, 1);
  } finally { ledger.close(); }
});

test('发布事务回滚、并发提案基线冲突、内容不可变、有效期与角色保护', () => {
  const { ledger, memory, family, input } = setup();
  try {
    assert.throws(() => memory.proposePolicy({ ...input, profile: { ...profile(), scorecard: { ...profile().scorecard, dimensions: profile().scorecard.dimensions.map((d) => ({ ...d, weight: 10 })) } } }), /100/);
    const bad = profile(); bad.scorecard.dimensions[0].name = '年龄';
    assert.throws(() => memory.proposePolicy({ ...input, profile: bad }), /受保护/);
    const first = memory.proposePolicy(input);
    const concurrent = memory.proposePolicy(input);
    ledger.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON scorecard_versions BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(() => memory.approveProposal(first.id, first.content_hash, 'HR'), /injected/);
    assert.equal(memory.proposal(first.id).status, 'pending');
    assert.equal(ledger.db.prepare('SELECT status FROM approvals WHERE id=?').get(first.approval_id)?.status, 'pending');
    ledger.db.exec('DROP TRIGGER fail_publish');
    const version = memory.approveProposal(first.id, first.content_hash, 'HR');
    assert.throws(() => memory.approveProposal(concurrent.id, concurrent.content_hash, 'HR'), /基线/);
    assert.throws(() => ledger.db.prepare("UPDATE scorecard_versions SET profile_json='{}' WHERE id=?").run(version.id), /immutable/);
    assert.throws(() => ledger.db.prepare("UPDATE memory_proposals SET why='changed' WHERE id=?").run(first.id), /immutable/);
    memory.retireVersion(version.id);
    assert.deepEqual(memory.recallPolicies(family.id), []);
    assert.throws(() => memory.proposePolicy({ ...input, validFrom: '2027-01-01', validTo: '2026-01-01' }), /有效期/);
  } finally { ledger.close(); }
});

test('任务绑定隔离版本更新，退役不改变旧任务，删除来源清理投影并停止规则复用', () => {
  const { ledger, memory, input } = setup();
  try {
    const job = ledger.createJob({ title: 'Java', requirements: 'Java 支付开发' });
    const p = memory.proposePolicy({ ...input, sourceJobId: job.id });
    const v = memory.approveProposal(p.id, p.content_hash, 'HR');
    memory.selectPolicy(job.id, v.id);
    const data = profile();
    ledger.saveJobAnalysis(job.id, data.jd, data.scorecard, data.jd.title);
    const binding = memory.bindJob(job.id, data, v.id);
    const amended = profile(); amended.scorecard.dimensions[0].weight = 50; amended.scorecard.dimensions[1].weight = 30;
    const p2 = memory.proposePolicy({ ...input, baseVersionId: v.id, profile: amended });
    memory.approveProposal(p2.id, p2.content_hash, 'HR');
    memory.retireVersion(v.id);
    assert.equal(memory.binding(job.id)?.snapshot_hash, binding.snapshot_hash);
    assert.throws(() => ledger.saveJobAnalysis(job.id, amended.jd, amended.scorecard, 'changed'), /immutable/);
    assert.throws(() => memory.bindJob(job.id, amended, v.id), /冻结/);
    ledger.appendChat(job.id, 'user', 'test');
    ledger.deleteJob(job.id);
    assert.equal(memory.version(v.id).status, 'needs_review');
    assert.equal(memory.proposal(p.id).source_job_id, null);
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM chat_message_order WHERE job_id=?').get(job.id)?.n, 0);
    assert.throws(() => memory.getJobView(job.id, 'coordinator'), /不存在/);
  } finally { ledger.close(); }
});

test('提取式摘要有水位、来源校验与脱敏；新消息不丢失，记忆读取按 job 隔离', () => {
  const { ledger, memory } = setup();
  try {
    const job = ledger.createJob({ title: 'Java', requirements: 'Java' });
    const other = ledger.createJob({ title: 'other', requirements: 'other' });
    ledger.appendChat(other.id, 'user', '其他岗位私有内容');
    ledger.addDecision({ jobId: job.id, node: 'jd', question: '薪资', answer: '预算 30K', actor: 'HR' });
    for (let i = 0; i < 30; i += 1) {
      ledger.appendChat(job.id, 'user', `第${i}轮：姓名：张三 手机：13800000000 邮箱：test@example.com。` + '项目细节'.repeat(80));
      ledger.appendChat(job.id, 'assistant', `第${i}轮回复` + '核查结果'.repeat(80));
    }
    const context = buildMemoryContext(ledger, job.id, 1500);
    assert.match(context.projection, /预算 30K/);
    assert.match(String(context.turns[0].content), /非权威历史摘要/);
    assert.doesNotMatch(String(context.turns[0].content), /13800000000|test@example.com|姓名：张三/);
    assert.match(String(context.turns.at(-1)?.content), /第29轮回复/);
    buildMemoryContext(ledger, job.id, 1500);
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM memory_summaries').get()?.n, 1);
    const row = ledger.db.prepare('SELECT * FROM memory_summaries').get()!;
    assert.ok(Number(row.through_seq) > Number(row.from_seq));
    assert.ok(JSON.parse(String(row.references_json)).length > 0);
    assert.doesNotMatch(JSON.stringify(readJobMemory(ledger, job.id)), /其他岗位私有内容/);
    assert.throws(() => memory.getJobView(job.id, 'unknown'), /未知/);
    ledger.appendChat(job.id, 'user', '最后一个新问题');
    assert.match(String(buildMemoryContext(ledger, job.id, 1500).turns.at(-1)?.content), /最后一个新问题/);
    ledger.db.prepare("UPDATE chat_messages SET content='源消息已修订' WHERE id IN (SELECT message_id FROM chat_message_order WHERE job_id=? ORDER BY seq LIMIT 1)").run(job.id);
    const before = ledger.db.prepare('SELECT COUNT(*) AS n FROM memory_summaries').get()?.n;
    buildMemoryContext(ledger, job.id, 1500);
    assert.ok(Number(ledger.db.prepare('SELECT COUNT(*) AS n FROM memory_summaries').get()?.n) > Number(before));
  } finally { ledger.close(); }
});

test('记忆路由与持久化：重开数据库仍保留批准版本与原审批', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-memory-'));
  let ledger = new Ledger(path.join(dir, 'ledger.db'));
  try {
    const memory = new MemoryService(ledger);
    const family = memory.createFamily('backend');
    const p = memory.proposePolicy({ familyId: family.id, rule: '规则', why: '原因', howToApply: '新任务', profile: profile() });
    memoryRoute(ledger, 'POST', `/api/memory/proposals/${p.id}/decision`, { decision: 'approve', contentHash: p.content_hash });
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db'));
    const result = memoryRoute(ledger, 'GET', '/api/memory', {}) as { versions: { version: number }[] };
    assert.equal(result.versions[0].version, 1);
    assert.equal(new MemoryService(ledger).proposal(p.id).status, 'approved');
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});
