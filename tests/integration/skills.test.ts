import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { SkillStore, parseSkill, readLocalSkill, type SkillPlugin } from '../../src/skills/store.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { bootstrap } from '../../src/bootstrap.ts';
import { runPipeline } from '../../src/agents/coordinator.ts';
import { AutoHitlResponder } from '../../src/agents/hitl.ts';
import { AgentStore } from '../../src/agent-platform/store.ts';
import { FakeProvider } from '../fixtures/fake-provider.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { startWebServer } from '../../src/web/server.ts';
import type { LlmProvider } from '../../src/llm/provider.ts';

const content = '---\nname: project-evidence\ndescription: >\n  复核项目证据\n---\nCUSTOM_SKILL_MARKER：核对项目责任、结果和原文证据。';
test('Skill 导入、角色注入实际模型调用、版本冻结、停用和删除隔离', async () => {
  const env = await setupTempEnv();
  const ledger = new Ledger(process.env.BOLE_DB!);
  const store = new SkillStore(ledger);
  const fake = new FakeProvider();
  const seen: { agent: string; system: string }[] = [];
  const provider: LlmProvider = { name: fake.name, kind: fake.kind, chat: async (req) => { seen.push({ agent: req.agent, system: req.system }); return fake.chat(req); } };
  let boot: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    const meta = parseSkill(content);
    assert.equal(meta.id, 'project-evidence');
    const folder = path.join(env.dir, 'example-skill'); await mkdir(folder);
    await writeFile(path.join(folder, 'SKILL.md'), content);
    assert.equal((await readLocalSkill(folder)).name, 'project-evidence');
    const installed = store.save({ ...meta, roles: ['profiler', 'assessor'], enabled: true });
    assert.throws(() => store.save({ ...meta, roles: ['profiler'] }), /已存在/);
    boot = await bootstrap({ requirements: '招聘 Java 后端，熟悉 MySQL 和支付系统。', provider });
    const agentStore = new AgentStore(boot.deps.ledger);
    const manifest = agentStore.manifest(boot.job.id)!;
    assert.equal(manifest.skills?.length, 1);
    assert.match(agentStore.registry(manifest).get('assessor').promptContent!, /CUSTOM_SKILL_MARKER/);
    assert.doesNotMatch(agentStore.registry(manifest).get('parser').promptContent!, /CUSTOM_SKILL_MARKER/);
    const { revision: _rev, updatedAt: _time, ...definition } = installed;
    store.save({ ...definition, enabled: false, content: content.replace('CUSTOM_SKILL_MARKER', 'CHANGED_SKILL') }, installed.revision);
    assert.throws(() => store.save(definition, installed.revision), /已修改/);
    const file = path.join(env.dir, 'resume.txt');
    await writeFile(file, '姓名：张伟\n工作年限：5年\n技能：Java、Spring Boot、MySQL\n项目：负责支付系统，优化接口性能。');
    const result = await runPipeline(boot.deps, { requirements: boot.job.requirements, hitl: new AutoHitlResponder(), uploadFiles: [{ uploadId: 'up_skill', filename: 'resume.txt', path: file, size: 100, contentType: 'text/plain' }] });
    assert.equal(result.status, 'final');
    assert.ok(seen.some((r) => r.agent === 'profiler' && r.system.includes('CUSTOM_SKILL_MARKER')));
    assert.ok(seen.some((r) => r.agent === 'assessor' && r.system.includes('CUSTOM_SKILL_MARKER')));
    assert.ok(seen.filter((r) => r.agent === 'parser' || r.agent === 'auditor').every((r) => !r.system.includes('CUSTOM_SKILL_MARKER')));
    const next = await bootstrap({ requirements: '招聘 Java 后端工程师', provider });
    try { assert.equal(new AgentStore(next.deps.ledger).manifest(next.job.id)?.skills, undefined); }
    finally { next.close(); }
    store.remove(installed.id);
    assert.equal(store.list().length, 0);
    assert.match(agentStore.registry(agentStore.manifest(boot.job.id)!).get('assessor').promptContent!, /CUSTOM_SKILL_MARKER/);
    assert.throws(() => parseSkill('---\nname: [\n---\ninvalid'));
    assert.throws(() => store.save({ id: 'bad', name: 'bad', content: 'x', roles: ['fetcher'] }));
  } finally { boot?.close(); ledger.close(); await env.restore(); }
});

test('插件页 Skill HTTP 生命周期：预览、安装、编辑、启停、删除和参数校验', async () => {
  const env = await setupTempEnv();
  const oldMcp = process.env.BOLE_MCP_CONFIG; process.env.BOLE_MCP_CONFIG = path.join(env.dir, 'no-mcp.json');
  let server: Server | undefined;
  try {
    server = await startWebServer({ port: 0 });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const api = async (url: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json() as { ok: boolean; skill: SkillPlugin; skills: SkillPlugin[] };
      return { ...data, status: response.status };
    };
    assert.equal((await api('/api/skills/preview', 'POST', { content })).skill.id, 'project-evidence');
    const installed = await api('/api/skills', 'POST', { id: 'project-evidence', name: '项目证据', content, roles: ['coordinator'] });
    assert.equal(installed.status, 201);
    const disabled = await api('/api/skills/project-evidence', 'PATCH', { enabled: false, revision: installed.skill.revision });
    assert.equal(disabled.skill.enabled, false);
    assert.equal((await api('/api/skills/project-evidence', 'PATCH', { enabled: true, revision: 1 })).status, 400);
    assert.equal((await api('/api/skills', 'POST', { id: 'bad', name: 'bad', content: 'x', roles: [] })).status, 400);
    assert.equal((await api('/api/skills/preview', 'POST', { path: path.join(env.dir, 'missing') })).status, 400);
    assert.match(await (await fetch(base + '/')).text(), /id="skill-add"/);
    assert.equal((await fetch(base + '/skill-ui.js')).status, 200);
    assert.equal((await api('/api/mcp/plugins')).status, 200);
    assert.equal((await api('/api/skills/project-evidence', 'DELETE')).skills.length, 0);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (oldMcp === undefined) delete process.env.BOLE_MCP_CONFIG; else process.env.BOLE_MCP_CONFIG = oldMcp;
    await env.restore();
  }
});
