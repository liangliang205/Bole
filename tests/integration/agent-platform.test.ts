import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { AgentStore } from '../../src/agent-platform/store.ts';
import { teamSchema, validateDefinition, templateCatalog } from '../../src/agent-platform/catalog.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';
import type { LlmProvider, ProviderResult } from '../../src/llm/provider.ts';
import { startWebServer } from '../../src/web/server.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { chatWithJob } from '../../src/chat/service.ts';

const resumeText = '姓名：张伟\n工作年限：5年\n技能：Java、Spring Boot、MySQL\n项目：负责支付系统，优化接口性能。';

test('动态新增专职角色与评估角色真实协作：证据打回重试、成本元数据、版本冻结与复用', async () => {
  const env = await setupTempEnv();
  let boot: Awaited<ReturnType<typeof bootstrap>> | undefined;
  const fake = new FakeProvider();
  const actualAgents: string[] = [];
  let specialistAttempts = 0;
  let lastChatSystem = '';
  const provider: LlmProvider = { name: fake.name, kind: fake.kind, chat: async (req) => {
    actualAgents.push(req.agent);
    if (!req.schemaName) {
      lastChatSystem = req.system;
      return { text: '已根据当前岗位回答。', usage: { promptTokens: 10, completionTokens: 10, cachedPromptTokens: 0 }, stopReason: 'completed', model: req.model ?? 'fake', latencyMs: 1, cacheHit: false };
    }
    if (req.schemaName !== 'specialist_findings') return fake.chat(req);
    const output = { findings: [{ code: 'payment', severity: 'info', note: '存在支付项目经验', evidence: [{ field: 'project', quote: specialistAttempts++ === 0 ? '原文不存在的资格证书' : '负责支付系统' }] }] };
    return { text: JSON.stringify(output), json: output, usage: { promptTokens: 10, completionTokens: 10, cachedPromptTokens: 0 },
      stopReason: 'completed', model: req.model ?? 'fake', latencyMs: 1, cacheHit: false } satisfies ProviderResult;
  } };
  try {
    boot = await bootstrap({ requirements: '招聘 Java 后端', provider });
    const store = new AgentStore(boot.deps.ledger);
    const template = templateCatalog['structured-llm.v1'];
    const specialist = store.register(validateDefinition({ id: 'payment-qualification', version: '1.0.0', name: '支付资格检查',
      templateId: 'structured-llm.v1', inputContract: template.input, outputContract: template.output, capabilities: [template.capability], prompt: '核查支付经历，引用原文。' }));
    store.activate(specialist.agent_id, specialist.version_key, 0);
    const assessorDef = store.manifest(boot.job.id)!.bindings.assessor.definition;
    const assessor = store.register({ ...assessorDef, id: 'payment-assessor', version: '1.0.0', name: '支付岗位评估', prompt: 'CUSTOM_PAYMENT_PROMPT\n' + assessorDef.prompt });
    store.activate(assessor.agent_id, assessor.version_key, 0);
    const team = teamSchema.parse(JSON.parse(store.teams()[0].definition_json));
    team.id = 'payment'; team.slots.specialist = { agentId: specialist.agent_id, version: specialist.version };
    team.slots.assessor = { activeAgentId: assessor.agent_id }; store.registerTeam(team);
    boot.close(); boot = undefined;
    const file = path.join(env.dir, 'resume.txt'); await writeFile(file, resumeText);
    boot = await bootstrap({ requirements: '招聘 Java 后端，熟悉 MySQL 和支付系统。', provider, agentTeamKey: 'payment@1.0.0' });
    const run = await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl: new AutoHitlResponder(), uploadFiles: [{ uploadId: 'u', filename: 'resume.txt', path: file, size: Buffer.byteLength(resumeText), contentType: 'text/plain' }] });
    assert.equal(run.status, 'final');
    assert.equal(specialistAttempts, 2, '无原文引用必须同轮重试');
    assert.ok(actualAgents.includes('payment-qualification'));
    assert.ok(actualAgents.includes('payment-assessor'));
    assert.match(boot.deps.registry.get('assessor').promptContent!, /CUSTOM_PAYMENT_PROMPT/);
    assert.equal(boot.deps.ledger.db.prepare("SELECT COUNT(*) AS n FROM agent_invocations WHERE job_id=? AND slot='specialist'").get(boot.job.id)?.n, 2);
    const rows = boot.deps.ledger.db.prepare('SELECT * FROM specialist_results WHERE job_id=?').all(boot.job.id);
    assert.equal(rows.length, 1); assert.doesNotMatch(String(rows[0].result_json), /不存在的资格证书/);
    assert.match(String(rows[0].result_json), /charStart/);
    const report = JSON.parse(await (await import('node:fs/promises')).readFile(run.reports.json, 'utf8'));
    assert.ok(report.agentBindings.some((b: { key: string }) => b.key === assessor.version_key));
    assert.ok(report.cost.byAgent.some((a: { agent: string }) => a.agent === 'payment-assessor'));
    const pinned = new AgentStore(boot.deps.ledger);
    const v2 = pinned.register({ ...assessorDef, id: 'payment-assessor', version: '2.0.0', prompt: 'v2 prompt' });
    pinned.activate('payment-assessor', v2.version_key, 1);
    pinned.retire(assessor.version_key);
    const hash = pinned.manifest(boot.job.id)!.bindings.assessor.hash;
    const id = boot.job.id;
    boot.close(); boot = undefined;
    boot = await bootstrap({ requirements: '招聘 Java 后端', jobId: id, provider });
    assert.equal(new AgentStore(boot.deps.ledger).manifest(id)!.bindings.assessor.hash, hash);
    await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl: new AutoHitlResponder(), resumeOnly: true });
    assert.equal(specialistAttempts, 2, '续跑不重做已完成的专职检查');
    const finalStore = new AgentStore(boot.deps.ledger);
    const coordinator = finalStore.manifest(id)!.bindings.coordinator.definition;
    const nextCoordinator = finalStore.register({ ...coordinator, version: '99.0.0', prompt: 'NEW_COORDINATOR_99' });
    finalStore.activate('coordinator', nextCoordinator.version_key, 1);
    await chatWithJob({ job: boot.deps.ledger.getJob(id)!, report: null, ledger: boot.deps.ledger, llm: boot.deps.llm, message: '你好' });
    assert.doesNotMatch(lastChatSystem, /NEW_COORDINATOR_99/);
    finalStore.retire(specialist.version_key);
    await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl: new AutoHitlResponder(), resumeOnly: true });
    finalStore.assertUsable(finalStore.manifest(id)!.bindings.specialist);
  } finally { boot?.close(); await env.restore(); }
});

test('HTTP 动态注册无需重启：草稿、发现、激活、退役及管理脚本', async () => {
  const env = await setupTempEnv();
  const oldMcp = process.env.BOLE_MCP_CONFIG;
  process.env.BOLE_MCP_CONFIG = path.join(env.dir, 'none.json');
  let server: Server | undefined;
  try {
    server = await startWebServer({ port: 0 });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const api = async (url: string, body?: unknown) => {
      const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as { ok: boolean; example: unknown; draft: { id: string; revision: number }; version: { version_key: string }; discovery: { eligible: boolean; version_key: string }[]; checks: { name: string; detail: string }[] };
      assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const catalog = await api('/api/agent-catalog');
    const draft = (await api('/api/agent-drafts', { definition: catalog.example })).draft;
    await api(`/api/agent-drafts/${draft.id}/register`, { revision: draft.revision });
    await api('/api/agents/qualification-checker/activate', { versionKey: 'qualification-checker@1.0.0', revision: 0 });
    assert.equal((await api('/api/agents?capabilitiesAll=resume.specialist-check%401')).discovery.filter((d) => d.eligible).length, 1);
    await api('/api/agents/qualification-checker/versions/1.0.0/retire', {});
    assert.equal((await api('/api/agents?capabilitiesAll=resume.specialist-check%401')).discovery.filter((d) => d.eligible).length, 0);
    assert.equal((await fetch(base + '/agent-ui.js')).status, 200);
    const doctor = await api('/api/doctor');
    assert.match(doctor.checks.find((check) => check.name === '动态 Agent 注册表')!.detail, /7 个已注册版本/);
    const html = await (await fetch(base + '/')).text();
    assert.doesNotMatch(html, /id="settings-tools"/);
    assert.match(html, /id="agent-environment-check"/);
    assert.doesNotMatch(html, /data-agent-tab="trial"|id="agent-trial-run"/);
    assert.match(html, /data-drawer-tab="workflow"/);
    assert.equal((await fetch(base + '/api/agent-invocations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    const ledger = new Ledger(process.env.BOLE_DB!);
    assert.equal(new AgentStore(ledger).get('qualification-checker@1.0.0').status, 'retired');
    const job = ledger.createJob({ title: 'workflow inspection', requirements: 'test' }); ledger.close();
    const view = await api(`/api/run/${job.id}/workflow`) as unknown as { runs: unknown[]; nodes: unknown[] };
    assert.deepEqual(view.runs, []); assert.deepEqual(view.nodes, []);
    assert.equal((await fetch(`${base}/api/run/missing/workflow`)).status, 400);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => { server!.close((error) => error ? reject(error) : resolve()); server!.closeAllConnections(); });
    if (oldMcp === undefined) delete process.env.BOLE_MCP_CONFIG; else process.env.BOLE_MCP_CONFIG = oldMcp;
    await env.restore();
  }
});
