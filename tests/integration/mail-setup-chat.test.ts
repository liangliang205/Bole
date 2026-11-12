import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { Ledger } from '../../src/core/ledger.ts';
import { SkillStore } from '../../src/skills/store.ts';
import { MailAdapterStore } from '../../src/mail/adapters.ts';
import { chatWithMailSetup, SETUP_CHAT_SEED } from '../../src/mail/setup-chat.ts';
import { MailSetupRuntime } from '../../src/mail/setup-runtime.ts';
import { publicDocumentAddress, readSetupDocument } from '../../src/mail/setup-document.ts';
import type { LlmRouter } from '../../src/llm/router.ts';
import type { ChatRequest } from '../../src/types.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { createServer } from 'node:http';
import { ProviderStore } from '../../src/settings/provider-store.ts';
import { resolvePaths } from '../../src/config.ts';
import { startWebServer, drainWebServer } from '../../src/web/server.ts';

test('首页接入对话：读文档、安装、自动配置、原始授权链接、跨轮验证；无需简历', async () => {
  const env = await setupTempEnv();
  const ledger = new Ledger(path.join(env.dir, 'setup.db'));
  try {
    const job = ledger.createJob({ title: '工作台对话', requirements: '请阅读文档帮我接入邮箱', seed: SETUP_CHAT_SEED });
    ledger.setJobStatus(job.id, 'idle');
    const cli = { package: 'different-mail-cli', command: process.execPath, baseArgs: [path.join(env.dir, 'mail.mjs')] };
    const definition = { id: 'company-inbox', name: '公司邮箱', skillId: 'different-mail', command: cli.command, baseArgs: cli.baseArgs,
      operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: [op] }])),
      fields: { email: 'email', items: 'items', messageId: 'id', sender: 'sender', attachments: 'files', attachmentId: 'id', filename: 'name', savedPath: 'path' } };
    let installs = 0, authorizations = 0, identities = 0, completed = false;
    const rawUrl = 'https://auth.example.org/login?state=a%2Fb&nonce=x%2By';
    const runtime = { install: async () => { installs++; return [cli]; }, help: async () => 'identity returns {email}, search/read/download/send return JSON', startAuth: async () => { authorizations++; return { state: 'waiting' as const, urls: [rawUrl] }; }, authStatus: () => ({ state: completed ? 'completed' as const : 'waiting' as const, urls: completed ? [] : [rawUrl] }) };
    let steps: [string, unknown][] = [ ['read_setup_document', { url: 'https://docs.example.org/setup' }], ['install_mail_cli', { package: cli.package }], ['install_mail_plugin', { command: 'npx skills add example/mail --skill different-mail' }], ['read_mail_skill', { id: 'different-mail' }], ['mail_cli_help', { cli: 0, args: ['--help'] }], ['save_mail_connection', { definition }], ['start_mail_authorization', { cli: 0, args: ['auth', 'login'] }] ];
    const requests: ChatRequest[] = [];
    const llm = { chat: async (request: ChatRequest) => {
      requests.push(request);
      const next = steps.shift();
      return next ? { text: '', toolCalls: [{ id: `call-${requests.length}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { text: completed ? '已验证公司邮箱。' : '请完成浏览器授权。' };
    } } as unknown as LlmRouter;
    const common = { jobId: job.id, ledger, llm, runtime, readDocument: async () => 'Install different-mail-cli and its skill. OAuth login is required.',
      installPlugin: async () => { new SkillStore(ledger).save({ id: 'different-mail', name: 'Different Mail', content: 'CLI 接口说明' }); return { installed: true }; },
      identity: async () => { identities++; return 'hr@example.org'; } };
    const first = await chatWithMailSetup({ ...common, message: '请阅读 https://docs.example.org/setup 并安装配置招聘邮箱' });
    assert.ok(first.answer.includes('```\n' + rawUrl + '\n```'), '直接展示原始授权 URL，不改写参数');
    assert.equal(first.mailboxConnection, undefined);
    assert.equal(new MailAdapterStore(ledger).list()[0]?.id, definition.id);
    assert.equal(ledger.listResumes(job.id).length, 0);
    assert.equal(identities, 0, '尚未验证不能返回已连接状态');
    completed = true;
    steps = [['mail_authorization_status', {}], ['check_mail_connection', { id: definition.id }]];
    const second = await chatWithMailSetup({ ...common, message: '我已授权，继续检查连接' });
    assert.deepEqual(second.mailboxConnection, { id: definition.id, mailbox: 'hr@example.org' });
    assert.equal(second.messages.length, 4);
    assert.equal(installs, 1); assert.equal(authorizations, 1); assert.equal(identities, 1);
    assert.equal(ledger.getJob(job.id)?.status, 'idle');
    assert.ok(requests.every((request) => !request.tools?.some((tool) => /send_mail|shell|exec/.test(tool.function.name))));
  } finally { ledger.close(); await env.restore(); }
});

test('接入失败保留对话，不把失败的身份检查报告为已连接', async () => {
  const env = await setupTempEnv(); const ledger = new Ledger(path.join(env.dir, 'failure.db'));
  try {
    const job = ledger.createJob({ title: '对话', requirements: '接入邮箱', seed: SETUP_CHAT_SEED });
    let calls = 0;
    const llm = { chat: async (request: ChatRequest) => {
      if (calls++ === 0) return { text: '', toolCalls: [{ id: 'check', type: 'function', function: { name: 'check_mail_connection', arguments: '{"id":"missing"}' } }] };
      assert.match(JSON.stringify(request.messages), /请先配置邮箱连接/);
      return { text: '连接尚未配置完成。' };
    } } as unknown as LlmRouter;
    const result = await chatWithMailSetup({ jobId: job.id, ledger, llm, message: '检查邮箱连接', runtime: { install: async () => [], help: async () => '', startAuth: async () => ({ state: 'failed', urls: [] }), authStatus: () => ({ state: 'missing', urls: [] }) }, installPlugin: async () => ({}) });
    assert.equal(result.mailboxConnection, undefined); assert.equal(result.messages.length, 2);
  } finally { ledger.close(); await env.restore(); }
});

test('授权子进程跨轮等待且不会重复启动，不返回 stdout 中的令牌', async () => {
  const env = await setupTempEnv(); const runtime = new MailSetupRuntime(env.dir);
  try {
    const script = path.join(env.dir, 'oauth.mjs'), log = path.join(env.dir, 'calls.txt');
    await writeFile(script, "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], process.argv.slice(3).join(' ')+'\\n'); console.log('secret-token=never-return'); console.log('https://auth.example.org/?state=a%2Fb&nonce=c%2Bd'); setTimeout(() => process.exit(0), 2200);");
    const cli = { package: 'test-cli', command: process.execPath, baseArgs: [script, log] };
    const first = await runtime.startAuth('job', cli, ['auth', 'login']);
    assert.equal(first.state, 'waiting'); assert.equal(first.urls[0], 'https://auth.example.org/?state=a%2Fb&nonce=c%2Bd');
    assert.doesNotMatch(JSON.stringify(first), /never-return/);
    await runtime.startAuth('job', cli, ['auth', 'login']);
    assert.equal(await readFile(log, 'utf8'), 'auth login\n');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(runtime.authStatus('job').state, 'completed');
    assert.deepEqual(runtime.authStatus('job').urls, []);
    await runtime.startAuth('job', cli, ['auth', 'login'], true);
    assert.equal(await readFile(log, 'utf8'), 'auth login\nauth login\n');
    await assert.rejects(runtime.install('../unsafe'));
    await assert.rejects(runtime.install('mail-cli; echo nope'));
  } finally { runtime.close(); await env.restore(); }
});

test('安装文档拒绝本机、内网、IPv6 映射及非 HTTPS 地址', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.20.0.1', '192.168.1.2', '::1', '::ffff:127.0.0.1', 'fd00::1', '2001:db8::1']) assert.equal(publicDocumentAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicDocumentAddress(ip), true, ip);
  await assert.rejects(readSetupDocument('https://127.0.0.1/setup'), /本机或内网/);
  await assert.rejects(readSetupDocument('http://example.org/setup'), /HTTPS/);
  await assert.rejects(readSetupDocument('https://user:password@example.org/setup'), /HTTPS/);
});

test('CLI 身份探测可供 Agent 自动配置，隐藏凭据并阻止发信等其他操作', async () => {
  const env = await setupTempEnv(); const runtime = new MailSetupRuntime(env.dir);
  try {
    const script = path.join(env.dir, 'identity.mjs');
    await writeFile(script, "console.log(JSON.stringify(process.argv.includes('--print-output-schema')?{fields:{'data.aliases':'array'}}:{ok:true,data:{email:'hr@example.org',access_token:'never-return',profile:{password:'hidden-password'}}}));");
    const cli = { package: 'identity-cli', command: process.execPath, baseArgs: [script] };
    const output = await runtime.help(cli, ['+me']);
    assert.match(output, /hr@example.org/); assert.doesNotMatch(output, /never-return|hidden-password/);
    assert.match(output, /已隐藏/);
    const schema = await runtime.help(cli, ['message', '+search', '--print-output-schema']);
    assert.match(schema, /data.aliases/);
    assert.doesNotMatch(schema, /never-return|hidden-password/);
    await assert.rejects(runtime.help(cli, ['send', '--to', 'candidate@example.org']), /仅支持 CLI 帮助、输出字段说明或只读身份查询/);
    await assert.rejects(runtime.help(cli, ['auth', 'login']), /start_mail_authorization/);
  } finally { runtime.close(); await env.restore(); }
});

test('真实 HTTP 入口：无简历创建对话、发送请求并恢复历史，不启动招聘工作流', async () => {
  const env = await setupTempEnv();
  let systemPrompt = '';
  const model = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string }[] };
    systemPrompt = body.messages.find((m) => m.role === 'system')?.content ?? '';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'test', choices: [{ message: { role: 'assistant', content: '请提供邮箱安装文档，我会帮你接入。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  })().catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    const address = model.address(); assert.ok(address && typeof address === 'object');
    const store = new ProviderStore(resolvePaths().dataDir);
    const provider = await store.save({ name: 'Test', baseUrl: `http://127.0.0.1:${address.port}`, api: 'openai-chat', flashModel: 'test', proModel: 'test', apiKey: 'test-only-key' });
    await store.activate(provider.id);
    const settings = new Ledger(resolvePaths().dbPath);
    try {
      const adapters = new MailAdapterStore(settings);
      const definition = { name: '邮箱一', command: 'unused', operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: [op] }])), fields: { email: 'email', items: 'items', messageId: 'id', sender: 'from', attachments: 'files', attachmentId: 'id', filename: 'name', savedPath: 'path' } };
      adapters.save({ ...definition, id: 'first' });
      adapters.save({ ...definition, id: 'selected', name: '用户选中的邮箱' });
      const authScript = path.join(env.dir, 'auth-mail.mjs');
      await writeFile(authScript, `const args=process.argv.slice(2); if(args.join(' ')==='auth login'){console.log('请授权');console.log('https://auth.example.org/login?state=a%2Fb&nonce=c%2Bd');setTimeout(()=>process.exit(0),1400);}else if(args[0]==='+me')console.log(JSON.stringify({email:'hr@example.org'}));else console.log(JSON.stringify({}));`);
      new SkillStore(settings).save({ id: 'agently-mail', name: 'Agently Mail', content: 'Mail integration instructions' });
      adapters.save({ id: 'auth-mail', name: '可认证邮箱', skillId: 'agently-mail', command: process.execPath, baseArgs: [authScript],
        operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: op === 'identity' ? ['+me'] : [op] }])),
        fields: { email: 'email', items: 'items', messageId: 'id', sender: 'from', attachments: 'files', attachmentId: 'id', filename: 'name', savedPath: 'path' } });
    } finally { settings.close(); }
    server = await startWebServer({ port: 0 });
    const webAddress = server.address(); assert.ok(webAddress && typeof webAddress === 'object');
    const base = `http://127.0.0.1:${webAddress.port}`;
    const created = await fetch(base + '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '请帮我接入招聘邮箱' }) });
    assert.equal(created.status, 201);
    const { jobId } = await created.json() as { jobId: string };
    const replied = await fetch(`${base}/api/run/${jobId}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '请帮我接入招聘邮箱', preferredMailProviderId: 'selected' }) });
    const reply = await replied.json() as { ok: boolean; answer: string; error?: string };
    assert.equal(reply.ok, true, reply.error); assert.match(reply.answer, /安装文档/);
    assert.match(systemPrompt, /无需先上传简历/);
    assert.match(systemPrompt, /"id":"selected","name":"用户选中的邮箱"/);
    const fallback = await fetch(`${base}/api/run/${jobId}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '继续', preferredMailProviderId: 'removed' }) });
    assert.equal(fallback.status, 200);
    assert.match(systemPrompt, /选择的默认邮箱：null/);
    const history = await (await fetch(`${base}/api/run/${jobId}/chat`)).json() as { messages: unknown[] };
    assert.equal(history.messages.length, 4);
    const snapshot = await (await fetch(`${base}/api/run/${jobId}`)).json() as { run: { status: string }; snapshot: { job: { seed: string } } };
    assert.equal(snapshot.run.status, 'idle'); assert.equal(snapshot.snapshot.job.seed, SETUP_CHAT_SEED);
    const authorization = await fetch(`${base}/api/mail/adapters/auth-mail/authorization`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const waiting = await authorization.json() as { ok: boolean; state: string; urls: string[] };
    assert.equal(waiting.ok, true); assert.equal(waiting.state, 'waiting');
    assert.deepEqual(waiting.urls, ['https://auth.example.org/login?state=a%2Fb&nonce=c%2Bd']);
    const busyStatus = await (await fetch(`${base}/api/mail/status?providerId=auth-mail`)).json() as { ok: boolean; authorizationState?: string; error?: string };
    assert.equal(busyStatus.ok, true); assert.equal(busyStatus.authorizationState, 'waiting'); assert.match(busyStatus.error ?? '', /认证仍在进行中/);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const verified = await (await fetch(`${base}/api/mail/adapters/auth-mail/authorization`)).json() as { state: string; mailbox?: string };
    assert.equal(verified.state, 'completed'); assert.equal(verified.mailbox, 'hr@example.org');
    const ledger = new Ledger(resolvePaths().dbPath);
    try { assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE job_id=?').get(jobId)?.n, 0); } finally { ledger.close(); }
  } finally {
    if (server) await drainWebServer(server, 0);
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await env.restore();
  }
});
