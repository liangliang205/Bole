import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { bootstrap } from '../../src/bootstrap.ts';
import { collectMailbox, mailboxQuerySchema, prepareCandidateEmail, sendApprovedCandidateEmail } from '../../src/mail/service.ts';
import type { MailCommand } from '../../src/mail/client.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { ApprovalStore } from '../../src/core/approvals.ts';
import { runOrchestrator } from '../../src/chat/orchestrator.ts';
import type { ReportData } from '../../src/report/builder.ts';

const resume = '姓名：张伟\n工作年限：5年\n技能：Java、Spring Boot、MySQL\n项目：负责支付系统，优化接口性能。';

test('邮箱分页保留条件、附件入库进入完整筛选；HR 审批精确邮件后只发送一次', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({ requirements: '招聘 Java 后端，熟悉 MySQL 和支付系统。', provider: new FakeProvider() });
  const calls: string[][] = [];
  const command: MailCommand = async (args, cwd) => {
    calls.push(args);
    if (args[0] === '+me') return { aliases: [{ email: 'hr@agent.qq.com', is_primary: true }] };
    if (args[1] === '+search') return { data: args.includes('--cursor') ? [] : [{ message_id: 'msg_one' }], pagination: { has_more: !args.includes('--cursor'), next_cursor: 'page2' } };
    if (args[1] === '+read') return { message_id: 'msg_one', from: { email: 'candidate@example.com' }, attachments: [{ attachment_id: 'att_one', filename: 'resume.txt', size: 100 }, { filename: 'large.pdf', download_url: 'https://untrusted.invalid/' }, { attachment_id: 'att_exe', filename: 'evil.exe' }] };
    if (args[0] === 'attachment') { const file = path.join(cwd!, 'resume.txt'); await writeFile(file, resume); return { saved_to: file }; }
    if (args[1] === '+send') return { message_id: 'msg_sent' };
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  try {
    const query = mailboxQuerySchema.parse({ query: 'Java', after: '2026-01-01T00:00:00Z' });
    const files = await collectMailbox(boot.deps, query, command);
    assert.equal(files.length, 1);
    const pages = calls.filter((a) => a[1] === '+search');
    assert.equal(pages.length, 2);
    assert.ok(pages.every((a) => a.includes('Java') && a.includes(query.after!)));
    assert.equal((await collectMailbox(boot.deps, query, command)).length, 0, '恢复导入不会重复下载');
    assert.equal(calls.filter((a) => a[0] === 'attachment').length, 1);
    assert.throws(() => prepareCandidateEmail(boot.deps.ledger, boot.job.id, { candidate: 'R01', subject: '面试邀请', body: '请参加面试' }), /先完成筛选/);
    const summary = await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl: new AutoHitlResponder(), uploadFiles: [] });
    assert.equal(summary.status, 'final');
    assert.equal(boot.deps.ledger.listResumes(boot.job.id).length, 1);
    const originalChat = boot.deps.llm.chat.bind(boot.deps.llm);
    boot.deps.llm.chat = async (req) => {
      assert.ok(req.tools?.some((t) => t.function.name === 'prepare_candidate_email'));
      return { ...await originalChat(req), toolCalls: [{ id: 'call_mail', type: 'function', function: { name: 'prepare_candidate_email', arguments: JSON.stringify({ candidate: 'R01', subject: '面试邀请', body: '请参加面试' }) } }] };
    };
    const answer = await runOrchestrator({ job: boot.deps.ledger.getJob(boot.job.id)!, report: JSON.parse(await readFile(summary.reports.json, 'utf8')) as ReportData,
      ledger: boot.deps.ledger, llm: boot.deps.llm, message: '我选 R01，请发邮件邀请面试', runDir: boot.deps.runDir, dataDir: boot.deps.paths.dataDir });
    assert.match(answer.answer, /尚未发送/);
    const store = new ApprovalStore(boot.deps.ledger);
    const approval = store.list(boot.job.id).find((a) => a.kind === 'recruitment-mail')!;
    assert.equal(store.mode(boot.job.id), 'default');
    await assert.rejects(sendApprovedCandidateEmail(boot.deps.ledger, boot.job.id, approval.id, command), /未获批准/);
    assert.equal(calls.filter((a) => a[1] === '+send').length, 0);
    const payload = JSON.parse(approval.payload_json) as { to: string; body: string };
    assert.equal(payload.to, 'candidate@example.com');
    store.decide(approval.id, boot.job.id, true, 'HR(web)');
    await sendApprovedCandidateEmail(boot.deps.ledger, boot.job.id, approval.id, command);
    await assert.rejects(sendApprovedCandidateEmail(boot.deps.ledger, boot.job.id, approval.id, command), /已执行/);
    assert.equal(calls.filter((a) => a[1] === '+send').length, 1);
    assert.ok(calls.some((a) => a.includes(payload.to) && a.includes(payload.body) && a.includes('--confirmed')));
    prepareCandidateEmail(boot.deps.ledger, boot.job.id, { candidate: 'R01', subject: '修改邀请', body: '新时间' });
    const next = store.list(boot.job.id).find((a) => a.status === 'pending')!;
    store.decide(next.id, boot.job.id, true, 'HR(web)');
    const changedAccount: MailCommand = async () => ({ aliases: [{ email: 'other@agent.qq.com' }] });
    await assert.rejects(sendApprovedCandidateEmail(boot.deps.ledger, boot.job.id, next.id, changedAccount), /邮箱不一致/);
    assert.equal(store.get(next.id, boot.job.id)?.status, 'failed');
    assert.equal(calls.filter((a) => a[1] === '+send').length, 1);
  } finally { boot.close(); await env.restore(); }
});

test('邮箱附件路径越界被拦截，不能导入任意本机文件', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({ requirements: '招聘全栈工程师', provider: new FakeProvider() });
  const outside = path.join(env.dir, 'outside.txt');
  await writeFile(outside, 'private');
  const command: MailCommand = async (args) => {
    if (args[0] === '+me') return { aliases: [{ email: 'hr@agent.qq.com' }] };
    if (args[1] === '+search') return { data: [{ message_id: 'msg_one' }] };
    if (args[1] === '+read') return { message_id: 'msg_one', from: { email: 'candidate@example.com' }, attachments: [{ attachment_id: 'att_one', filename: 'resume.txt' }] };
    return { saved_to: outside };
  };
  try {
    assert.equal((await collectMailbox(boot.deps, mailboxQuerySchema.parse({}), command)).length, 0);
    assert.equal(boot.deps.ledger.db.prepare('SELECT COUNT(*) AS n FROM recruitment_mail_sources').get()?.n, 0);
  } finally { boot.close(); await env.restore(); }
});
