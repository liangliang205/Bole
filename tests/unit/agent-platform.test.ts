import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../../src/core/ledger.ts';
import { AgentBlockedError, AgentStore } from '../../src/agent-platform/store.ts';
import { validateDefinition, templateCatalog, teamSchema } from '../../src/agent-platform/catalog.ts';
import { agentRoute } from '../../src/agent-platform/http.ts';
import { buildMemoryContext } from '../../src/memory/context.ts';
import { LlmRouter } from '../../src/llm/router.ts';
import type { LlmProvider } from '../../src/llm/provider.ts';

function definition() { const t = templateCatalog['structured-llm.v1']; return validateDefinition({ id: 'qualification', version: '1.0.0', name: '资格核查', templateId: 'structured-llm.v1', inputContract: t.input, outputContract: t.output, capabilities: [t.capability], prompt: '核对证据，不要编造。' }); }
function setup() { const ledger = new Ledger(':memory:'); const store = new AgentStore(ledger); store.seed(); return { ledger, store }; }

test('新团队只接受单个角色绑定；历史候选团队兼容读取并固定实际版本', () => {
  const { ledger, store } = setup();
  try {
    const team = teamSchema.parse(JSON.parse(store.teams()[0].definition_json));
    const original = store.active().find((a) => a.agent_id === 'assessor')!.version_key!;
    const previous = store.get(original);
    const next = store.register({ ...JSON.parse(previous.definition_json), version: '99.0.0' });
    const legacy = { ...team, id: 'legacy', slots: { ...team.slots, assessor: { candidates: [{ agentId: next.agent_id, version: next.version }, { agentId: previous.agent_id, version: previous.version }], capability: 'resume.assess@1' } } };
    assert.throws(() => store.registerTeam(legacy), /只需指定一个/);
    // Simulate a previously stored immutable team; no rewrite/migration of historical definitions.
    ledger.db.prepare('INSERT INTO agent_teams VALUES (?,?,?,?)').run('legacy@1.0.0', JSON.stringify(legacy), 'legacy-hash', new Date().toISOString());
    const job = ledger.createJob({ title: 'legacy', requirements: 'test' });
    const manifest = store.bind(job.id, 'legacy@1.0.0', { flash: 'flash', pro: 'pro' }, 'test');
    assert.equal(manifest.bindings.assessor.key, [previous.version_key, next.version_key].sort()[0]);
    assert.match(manifest.bindings.assessor.reason, /历史候选定义兼容/);
    assert.equal(JSON.parse(store.teams().find((t) => t.team_key === 'legacy@1.0.0')!.definition_json).slots.assessor.candidates.length, 2);
  } finally { ledger.close(); }
});

test('运行时注册、草稿乐观并发、能力发现与同版本幂等', () => {
  const { ledger, store } = setup();
  try {
    store.seed(); assert.equal(store.versions().length, 6);
    const draft = store.saveDraft(definition());
    assert.equal(store.discover({ capabilitiesAll: ['resume.specialist-check@1'] }).filter((d) => d.eligible).length, 0);
    const saved = store.saveDraft({ ...definition(), name: '新版名称' }, draft.id, draft.revision);
    assert.throws(() => store.saveDraft(definition(), draft.id, draft.revision), /草稿已被修改/);
    assert.throws(() => store.registerDraft(draft.id, draft.revision), /草稿已变化/);
    const registered = store.registerDraft(draft.id, saved.revision);
    assert.equal(store.register({ ...definition(), name: '新版名称' }).version_key, registered.version_key);
    assert.throws(() => store.register(definition()), /不能覆盖/);
    store.activate('qualification', registered.version_key, 0);
    const found = store.discover({ capabilitiesAll: ['resume.specialist-check@1'], outputContract: 'recruitment.findings@1' }).filter((d) => d.eligible);
    assert.equal(found[0].version_key, registered.version_key);
    assert.throws(() => store.activate('qualification', null, 0), /活动版本已变化/);
    const loaded = store.draft(draft.id); assert.equal(loaded.revision, 2);
  } finally { ledger.close(); }
});

test('契约/能力/工具/记忆边界校验，团队不允许跳过核查模板', () => {
  const { ledger, store } = setup();
  try {
    assert.throws(() => validateDefinition({ ...definition(), outputContract: 'recruitment.audit@1' }), /契约/);
    assert.throws(() => validateDefinition({ ...definition(), capabilities: ['resume.audit@1'] }), /能力/);
    assert.throws(() => validateDefinition({ ...definition(), tools: ['python_exec'] }), /工具循环/);
    assert.throws(() => validateDefinition({ ...definition(), tools: ['unknown'] }));
    assert.throws(() => validateDefinition({ ...definition(), memory: { read: ['job-chat'], write: [], scope: 'candidate' } }), /不能读取/);
    assert.throws(() => validateDefinition({ ...definition(), memory: { read: [], write: ['policy-proposal-draft'], scope: 'job' } }), /人工入口/);
    assert.throws(() => validateDefinition({ ...definition(), templateId: 'file:///tmp/injected.js' }));
    const v = store.register(definition());
    const team = teamSchema.parse(JSON.parse(store.teams()[0].definition_json));
    team.id = 'invalid'; team.slots.auditor = { agentId: v.agent_id, version: v.version };
    assert.throws(() => store.registerTeam(team), /槽位/);
    assert.throws(() => ledger.db.prepare("UPDATE agent_versions SET definition_json='{}' WHERE version_key=?").run(v.version_key), /immutable/);
  } finally { ledger.close(); }
});

test('任务绑定不受激活/回滚/退役影响；并发激活失败一起回滚', () => {
  const { ledger, store } = setup();
  try {
    const models = { flash: 'flash', pro: 'pro' };
    const j1 = ledger.createJob({ title: 'one', requirements: 'test' });
    const old = store.bind(j1.id, 'builtin@1.0.0', models, 'test');
    const oldAgent = old.bindings.assessor;
    const v2 = store.register({ ...oldAgent.definition, version: '9.0.0', prompt: 'new version' });
    store.activate('assessor', v2.version_key, 1);
    const j2 = ledger.createJob({ title: 'two', requirements: 'test' });
    assert.equal(store.bind(j2.id, 'builtin@1.0.0', models, 'test').bindings.assessor.key, v2.version_key);
    assert.equal(store.manifest(j1.id)?.bindings.assessor.key, oldAgent.key);
    assert.equal(store.registry(old).get('assessor').promptContent, oldAgent.definition.prompt);
    ledger.db.exec("CREATE TRIGGER fail_activation BEFORE INSERT ON events WHEN NEW.type='agent.activated' BEGIN SELECT RAISE(ABORT,'injected activation failure'); END");
    assert.throws(() => store.activate('assessor', oldAgent.key, 2), /injected/);
    assert.equal(store.active().find((a) => a.agent_id === 'assessor')?.version_key, v2.version_key);
    ledger.db.exec('DROP TRIGGER fail_activation');
    store.activate('assessor', oldAgent.key, 2);
    store.retire(oldAgent.key); store.assertUsable(oldAgent);
    assert.throws(() => store.assertUsable({ ...oldAgent, hash: 'invalid' }), AgentBlockedError);
    assert.throws(() => store.bind(ledger.createJob({ title: 'three', requirements: 'test' }).id, 'builtin@1.0.0', models, 'test'));
    assert.throws(() => ledger.db.prepare("UPDATE job_agent_manifests SET manifest_json='{}' WHERE job_id=?").run(j1.id), /immutable/);
  } finally { ledger.close(); }
});

test('Agent 全局容量与只读岗位记忆权限，租约过期可恢复', () => {
  const { ledger, store } = setup();
  try {
    const v = store.register({ ...definition(), limits: { maxConcurrency: 1, timeoutMs: 1000, maxToolSteps: 1 } });
    store.activate(v.agent_id, v.version_key, 0);
    const job = ledger.createJob({ title: 'test', requirements: 'test' });
    const b = { key: v.version_key, hash: v.content_hash, definition: JSON.parse(v.definition_json), reason: 'test' };
    const first = store.beginInvocation(job.id, 'specialist', b, {}, {});
    assert.throws(() => store.beginInvocation(job.id, 'specialist', b, {}, {}), /容量/);
    assert.equal(store.discover({ capabilitiesAll: ['resume.specialist-check@1'] }).find((d) => d.eligible)?.capacityAvailable, false);
    store.finishInvocation(first, true, {});
    const second = store.beginInvocation(job.id, 'specialist', b, {}, {});
    ledger.db.prepare("UPDATE agent_invocations SET expires_at='2000-01-01' WHERE id=?").run(second);
    store.beginInvocation(job.id, 'specialist', b, {}, {});
    ledger.appendChat(job.id, 'user', '早期敏感讨论'); ledger.appendChat(job.id, 'assistant', 'old'); ledger.appendChat(job.id, 'user', '当前请求');
    const context = buildMemoryContext(ledger, job.id, 100, []);
    assert.equal(context.turns.length, 1); assert.equal(context.turns[0].content, '当前请求');
  } finally { ledger.close(); }
});

test('HTTP 路由注册与团队存储，重开数据库后定义和活动指针保留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-agents-'));
  let ledger = new Ledger(path.join(dir, 'ledger.db'));
  try {
    const draft = (agentRoute(ledger, 'POST', '/api/agent-drafts', { definition: definition() }) as { draft: { id: string; revision: number } }).draft;
    agentRoute(ledger, 'POST', `/api/agent-drafts/${draft.id}/register`, { revision: 1 });
    agentRoute(ledger, 'POST', '/api/agents/qualification/activate', { revision: 0, versionKey: 'qualification@1.0.0' });
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db'));
    const store = new AgentStore(ledger); store.seed();
    assert.equal(store.get('qualification@1.0.0').status, 'registered');
    assert.equal(store.active().find((a) => a.agent_id === 'qualification')?.version_key, 'qualification@1.0.0');
    assert.equal(store.importPreview().every((p) => !p.changed), true);
    assert.throws(() => agentRoute(ledger, 'POST', '/api/agents/qualification/versions/1.0.0/revoke', {}), /未知/);
    assert.equal(store.get('qualification@1.0.0').status, 'registered');
    const job = ledger.createJob({ title: 'legacy', requirements: 'test' });
    const team = teamSchema.parse(JSON.parse(store.teams()[0].definition_json));
    team.id = 'legacy'; team.slots.specialist = { agentId: 'qualification', version: '1.0.0' }; store.registerTeam(team);
    const binding = store.bind(job.id, 'legacy@1.0.0', { flash: 'flash', pro: 'pro' }, 'test').bindings.specialist;
    ledger.db.prepare("UPDATE agent_versions SET status='revoked' WHERE version_key=?").run(binding.key);
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db'));
    const migrated = new AgentStore(ledger);
    assert.equal(migrated.get(binding.key).status, 'retired');
    assert.equal(migrated.active().find((a) => a.agent_id === 'qualification')?.version_key, null);
    assert.equal(migrated.manifest(job.id)!.bindings.specialist.hash, binding.hash);
    migrated.assertUsable(binding);
    assert.equal(migrated.discover({ capabilitiesAll: ['resume.specialist-check@1'] }).filter((d) => d.eligible).length, 0);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('同 ID 不同版本跨槽位按真实槽位路由，模型网关/模型快照受控，调用记录不复制原文', async () => {
  const { ledger, store } = setup();
  try {
    const defaultTeam = teamSchema.parse(JSON.parse(store.teams()[0].definition_json));
    const parser = JSON.parse(store.get(store.active().find((a) => a.agent_id === 'parser')!.version_key!).definition_json);
    const assessor = JSON.parse(store.get(store.active().find((a) => a.agent_id === 'assessor')!.version_key!).definition_json);
    store.register({ ...parser, id: 'multi', version: '1.0.0' });
    store.register({ ...assessor, id: 'multi', version: '2.0.0' });
    defaultTeam.id = 'multi-team';
    defaultTeam.slots.parser = { agentId: 'multi', version: '1.0.0' };
    defaultTeam.slots.assessor = { agentId: 'multi', version: '2.0.0' };
    store.registerTeam(defaultTeam);
    const job = ledger.createJob({ title: 'test', requirements: 'test' });
    store.bind(job.id, 'multi-team@1.0.0', { flash: 'fixed-flash', pro: 'fixed-pro' }, 'test', false, 'gateway-1');
    let actualModel = '';
    const provider: LlmProvider = { name: 'test', kind: 'mock', chat: async (req) => {
      actualModel = req.model ?? '';
      return { text: 'ok', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 }, stopReason: 'completed', model: req.model!, latencyMs: 1, cacheHit: false };
    } };
    const router = new LlmRouter({ provider, providerIdentity: 'gateway-1', ledger, jobId: job.id, pricing: {}, models: { flash: 'changed', pro: 'changed' } });
    await router.chat({ agent: 'multi', tier: 'flash', model: 'forged-model', system: 'test', user: 'private input', meta: { agentSlot: 'assessor', text: 'private full resume' } });
    const row = ledger.db.prepare('SELECT * FROM agent_invocations WHERE job_id=?').get(job.id)!;
    assert.equal(row.slot, 'assessor'); assert.equal(row.version_key, 'multi@2.0.0');
    assert.equal(actualModel, 'fixed-flash');
    assert.doesNotMatch(String(row.meta_json), /private full resume/);
    const wrong = new LlmRouter({ provider, providerIdentity: 'gateway-2', ledger, jobId: job.id, pricing: {}, models: { flash: '', pro: '' } });
    await assert.rejects(wrong.chat({ agent: 'assessor', tier: 'flash', system: '', user: '' }), /网关/);
  } finally { ledger.close(); }
});
