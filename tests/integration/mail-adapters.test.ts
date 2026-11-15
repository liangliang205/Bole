import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { MailAdapterStore, mailAdapterSchema, configuredAdapter } from '../../src/mail/adapters.ts';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { prepareCandidateEmail, sendApprovedCandidateEmail, freezeMailboxQuery } from '../../src/mail/service.ts';
import { ApprovalStore } from '../../src/core/approvals.ts';
import { WorkflowStore } from '../../src/workflow/store.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { makeDocx } from '../fixtures/documents.ts';

test('其他邮箱 CLI 全链路：字段映射、非 QQ ID、配置冻结与 HR 审批后发信', async () => {
  const env = await setupTempEnv();
  const boot = await bootstrap({ requirements: '招聘 Java 后端工程师，熟悉 MySQL 和支付系统', provider: new FakeProvider() });
  try {
    const script = path.join(env.dir, 'different-mail.mjs');
    const log = path.join(env.dir, 'mail-calls.jsonl');
    const docxPath = path.join(env.dir, 'resume.docx');
    await writeFile(docxPath, makeDocx('姓名：张伟\n工作年限：5年\n技能：Java、Spring Boot、MySQL\n项目：负责支付系统，优化接口性能。'));
    await writeFile(script, `import fs from 'node:fs';import path from 'node:path';
const [log,op,raw]=process.argv.slice(2);const v=JSON.parse(raw);fs.appendFileSync(log,JSON.stringify({op,...v})+'\\n');
let payload;
if(op==='identity')payload={address:'hr@example.org'};
if(op==='search')payload={letters:[{uid:'mail/2026#one'}],next:null};
if(op==='read')payload={sender:{address:'candidate@example.org'},files:[{key:'file/one',title:'resume.docx'}]};
if(op==='download'){const p=path.join(v.outputDir,'resume.docx');fs.copyFileSync(${JSON.stringify(docxPath)},p);payload={file:p};}
if(op==='send')payload={receipt:'sent-1'};
console.log(JSON.stringify({payload}));`);
    const definition = mailAdapterSchema.parse({ id: 'other-mail', name: '另一种邮箱', command: process.execPath, baseArgs: [script, log],
      operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: [op, '{input}'], resultPath: 'payload' }])),
      fields: { email: 'address', items: 'letters', messageId: 'uid', nextCursor: 'next', sender: 'sender.address', attachments: 'files', attachmentId: 'key', filename: 'title', savedPath: 'file' } });
    const store = new MailAdapterStore(boot.deps.ledger); store.save(definition);
    const result = await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl: new AutoHitlResponder(), mailbox: { providerId: definition.id, query: '', maxMessages: 5 } });
    assert.equal(result.status, 'final');
    assert.equal(boot.deps.ledger.listResumes(boot.job.id).length, 1);
    const frozen = JSON.parse(new WorkflowStore(boot.deps.ledger).root(boot.job.id)!.input_json) as { mailbox: { adapter: { command: string } } };
    assert.equal(frozen.mailbox.adapter.command, process.execPath);
    store.save({ ...definition, command: 'changed-not-a-real-command' });
    prepareCandidateEmail(boot.deps.ledger, boot.job.id, { candidate: 'R01', subject: '面试邀请', body: '请回复方便的面试时间' });
    const approvals = new ApprovalStore(boot.deps.ledger);
    const approval = approvals.list(boot.job.id).find((a) => a.kind === 'recruitment-mail')!;
    await assert.rejects(sendApprovedCandidateEmail(boot.deps.ledger, boot.job.id, approval.id), /未获批准/);
    approvals.decide(approval.id, boot.job.id, true, 'HR(web)');
    await sendApprovedCandidateEmail(boot.deps.ledger, boot.job.id, approval.id);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((s) => JSON.parse(s) as { op: string; to?: string });
    assert.equal(calls.filter((c) => c.op === 'send').length, 1);
    assert.equal(calls.find((c) => c.op === 'send')!.to, 'candidate@example.org');
    assert.throws(() => freezeMailboxQuery({ providerId: 'missing', query: '', maxMessages: 5 }, boot.deps.ledger), /不存在/);
    const broken = configuredAdapter(definition, async () => ({}));
    await assert.rejects(broken.identity());
    await assert.rejects(broken.send({ to: 'candidate@example.org', subject: 'x', body: 'x' }), /发送回执/);
  } finally { boot.close(); await env.restore(); }
});
