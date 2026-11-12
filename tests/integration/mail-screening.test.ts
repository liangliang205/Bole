import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { MailAdapterStore } from '../../src/mail/adapters.ts';
import { SkillStore } from '../../src/skills/store.ts';
import { chatWithMailSetup, SETUP_CHAT_SEED } from '../../src/mail/setup-chat.ts';
import { prepareMailScreening } from '../../src/web/mail-screening.ts';
import { mailConnections } from '../../src/web/mail-connections.ts';
import { WorkflowStore } from '../../src/workflow/store.ts';
import type { LlmRouter } from '../../src/llm/router.ts';
import type { ChatRequest } from '../../src/types.ts';

test('自然语言收取：Agent 在同一会话启动筛选，时间段传入真实邮箱子进程，岗位进入评估', async () => {
  const env = await setupTempEnv();
  const requirements = '招聘 Java 后端工程师，熟悉 MySQL 和支付系统';
  const boot = await bootstrap({ requirements, provider: new FakeProvider() });
  try {
    const ledger = boot.deps.ledger;
    ledger.db.prepare('UPDATE jobs SET seed=?,status=? WHERE id=?').run(SETUP_CHAT_SEED, 'idle', boot.job.id);
    const script = path.join(env.dir, 'mail.mjs'), log = path.join(env.dir, 'calls.jsonl');
    await writeFile(script, `import fs from 'node:fs';import path from 'node:path';
const [log,op,raw]=process.argv.slice(2);const v=JSON.parse(raw);fs.appendFileSync(log,JSON.stringify({op,...v})+'\\n');let payload;
if(op==='identity')payload={email:'hr@example.org'};
if(op==='search'){const letters=[{id:'earlier',date:'2026-10-25T12:00:00+08:00'},{id:'inside',date:'2026-11-01T12:00:00+08:00'},{id:'later',date:'2026-11-02T12:00:00+08:00'}];payload={messages:letters.filter(m=>(!v.after||Date.parse(m.date)>=Date.parse(v.after))&&(!v.before||Date.parse(m.date)<Date.parse(v.before)))};}
if(op==='read')payload={sender:'candidate@example.org',files:[{id:'resume',name:'resume.txt'}]};
if(op==='download'){const file=path.join(v.outputDir,'resume.txt');fs.writeFileSync(file,'姓名：张伟\\n工作年限：5年\\n技能：Java、Spring Boot、MySQL\\n项目：负责支付系统，优化接口性能。');payload={path:file};}
if(op==='send')throw new Error('筛选阶段不应发送邮件');console.log(JSON.stringify({payload}));`);
    const definition = { id: 'company-mail', name: '公司招聘邮箱', command: process.execPath, baseArgs: [script, log],
      operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: [op, '{input}'], resultPath: 'payload' }])),
      fields: { email: 'email', items: 'messages', messageId: 'id', sender: 'sender', attachments: 'files', attachmentId: 'id', filename: 'name', savedPath: 'path' } };
    const store = new MailAdapterStore(ledger); store.save(definition);
    const original = store.list()[0]!;
    const after = '2026-10-26T00:00:00+08:00', before = '2026-11-02T00:00:00+08:00';
    const request = { requirements, providerId: definition.id, query: '', after, before, maxMessages: 50,
      searchArgs: ['search', '{"query":"{query}","after":"{after}","before":"' + before + '","cursor":"{cursor}"}'] };
    let steps = 0, starts = 0, forbiddenInstalls = 0;
    const llm = { chat: async (req: ChatRequest) => {
      assert.match(req.system, /2026年11月8日/);
      const name = steps++ === 0 ? 'list_mail_setup' : 'start_mail_screening';
      return { text: '', toolCalls: [{ id: 'action-' + steps, type: 'function', function: { name, arguments: name === 'list_mail_setup' ? '{}' : JSON.stringify({ request }) } },
        ...(name === 'start_mail_screening' ? [{ id: 'must-not-run', type: 'function', function: { name: 'install_mail_plugin', arguments: '{"command":"unused"}' } }] : [])] };
    } } as unknown as LlmRouter;
    const result = await chatWithMailSetup({ jobId: boot.job.id, ledger, llm, message: '帮我筛选上周收到的 Java 后端工程师简历，熟悉 MySQL 和支付系统', timeZone: 'Asia/Shanghai', now: new Date('2026-11-08T04:00:00Z'),
      runtime: { install: async () => [], help: async () => '', startAuth: async () => ({ state: 'missing', urls: [] }), authStatus: () => ({ state: 'missing', urls: [] }) },
      installPlugin: async () => { forbiddenInstalls++; },
      startScreening: async (raw) => {
        starts++;
        const prepared = await prepareMailScreening(ledger, boot.job.id, raw);
        ledger.db.prepare("UPDATE jobs SET seed='live',requirements=? WHERE id=?").run(raw.requirements, boot.job.id);
        const summary = await runPipeline(boot.deps, { requirements: raw.requirements, mailbox: prepared.mailbox, hitl: new AutoHitlResponder() });
        assert.equal(summary.status, 'final');
        return { jobId: boot.job.id, runId: boot.deps.runId, status: 'completed' };
      } });
    assert.equal(result.screeningRun?.jobId, boot.job.id); assert.equal(starts, 1); assert.equal(forbiddenInstalls, 0);
    assert.equal(ledger.listResumes(boot.job.id).length, 1);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { op: string; before?: string; after?: string; messageId?: string });
    assert.equal(calls.find((call) => call.op === 'search')?.after, after); assert.equal(calls.find((call) => call.op === 'search')?.before, before);
    assert.deepEqual(calls.filter((call) => call.op === 'read').map((call) => call.messageId), ['inside']);
    assert.ok(!calls.some((call) => call.op === 'send'));
    assert.deepEqual(store.list().find((a) => a.id === definition.id), original, '本次时间条件不修改共享邮箱配置');
    assert.deepEqual(mailConnections(ledger).adapters.map((a) => a.id), [definition.id], '任务专用配置不出现在邮箱列表');
    const root = new WorkflowStore(ledger).root(boot.job.id)!;
    assert.match(root.input_json, /2026-11-02/); assert.match(root.input_json, /支付系统/);
  } finally { boot.close(); await env.restore(); }
});

test('日期能力不足、反向时间、超限、切换操作及停用插件不启动收取', async () => {
  const env = await setupTempEnv(); const boot = await bootstrap({ requirements: '招聘后端工程师', provider: new FakeProvider() });
  try {
    const ledger = boot.deps.ledger; let identityCalls = 0;
    const skill = new SkillStore(ledger).save({ id: 'mail', name: 'Mail', content: 'Instructions' });
    new MailAdapterStore(ledger).save({ id: 'mail', name: 'Mail', skillId: skill.id, command: 'unused', operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: [op, '{input}'] }])), fields: { email: 'email', items: 'items', messageId: 'id', sender: 'sender', attachments: 'files', attachmentId: 'id', filename: 'name', savedPath: 'path' } });
    const request = { requirements: '招聘后端工程师', providerId: 'mail', query: '', after: '2026-11-01T00:00:00+08:00', before: '2026-11-08T00:00:00+08:00', maxMessages: 50 };
    const identity = async () => { identityCalls++; return 'hr@example.org'; };
    await assert.rejects(prepareMailScreening(ledger, boot.job.id, request, identity), /截止时间/);
    await assert.rejects(prepareMailScreening(ledger, boot.job.id, { ...request, after: request.before, before: request.after }, identity));
    await assert.rejects(prepareMailScreening(ledger, boot.job.id, { ...request, maxMessages: 201 }, identity));
    await assert.rejects(prepareMailScreening(ledger, boot.job.id, { ...request, searchArgs: ['send', '--body', request.before] }, identity), /不能切换/);
    new SkillStore(ledger).save({ id: skill.id, name: skill.name, content: skill.content, enabled: false }, skill.revision);
    await assert.rejects(prepareMailScreening(ledger, boot.job.id, request, identity), /邮箱连接不可用/);
    assert.equal(identityCalls, 0); assert.equal(ledger.listResumes(boot.job.id).length, 0);
  } finally { boot.close(); await env.restore(); }
});
