import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ledger } from '../core/ledger.ts';
import { AgentRegistry } from '../core/registry.ts';
import { loadPrompt, resolvePaths } from '../config.ts';
import type { AgentPreset } from '../config.ts';
import { memoryHash } from '../memory/service.ts';
import { slotNames, teamSchema, templateCatalog, validateDefinition,
  type AgentDefinition, type AgentManifest, type AgentTeam, type AgentVersion } from './catalog.ts';

const seedTemplates = ['builtin.coordinator.v1', 'builtin.profiler.v1', 'builtin.ingest.v1', 'builtin.parser.v1', 'builtin.assessor.v1', 'builtin.auditor.v1'] as const;
export interface DiscoveryQuery { capabilitiesAll?: string[]; capabilitiesAny?: string[]; roleTags?: string[]; inputContract?: string; outputContract?: string; tier?: string; templateId?: string }
export class AgentBlockedError extends Error {}
export class AgentStore {
  readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  transaction<T>(fn: () => T): T {
    this.ledger.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.ledger.db.exec('COMMIT'); return result; }
    catch (error) { this.ledger.db.exec('ROLLBACK'); throw error; }
  }
  versions(): AgentVersion[] { return this.ledger.db.prepare('SELECT * FROM agent_versions ORDER BY agent_id,registered_at,version_key').all() as unknown as AgentVersion[]; }
  get(key: string): AgentVersion {
    const row = this.ledger.db.prepare('SELECT * FROM agent_versions WHERE version_key=?').get(key) as unknown as AgentVersion | undefined;
    if (!row) throw new Error(`Agent 版本不存在：${key}`);
    return row;
  }
  active() { return this.ledger.db.prepare('SELECT * FROM agent_active_versions ORDER BY agent_id').all() as unknown as { agent_id: string; version_key: string | null; revision: number }[]; }
  drafts() { return this.ledger.db.prepare('SELECT * FROM agent_drafts ORDER BY created_at DESC').all(); }
  draft(id: string) {
    const row = this.ledger.db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(id) as { id: string; revision: number; definition_json: string } | undefined;
    if (!row) throw new Error('Agent 草稿不存在');
    return row;
  }
  saveDraft(definition: unknown, draftId?: string, expectedRevision?: number) {
    // 草稿保存也校验格式；编辑器可在提交前暂存未完整输入的内容。
    const d = validateDefinition(definition);
    const id = draftId ?? randomUUID();
    if (draftId) {
      if (this.ledger.db.prepare('UPDATE agent_drafts SET definition_json=?,revision=revision+1 WHERE id=? AND revision=?')
        .run(JSON.stringify(d), id, expectedRevision ?? -1).changes !== 1) throw new Error('草稿已被修改，请刷新后重试');
    } else this.ledger.db.prepare('INSERT INTO agent_drafts VALUES (?,1,?,?)').run(id, JSON.stringify(d), new Date().toISOString());
    return this.draft(id);
  }
  register(definition: unknown): AgentVersion {
    const d = validateDefinition(definition);
    return this.transaction(() => this.insertVersion(d));
  }
  registerDraft(id: string, revision: number): AgentVersion {
    return this.transaction(() => {
      const row = this.draft(id);
      if (row.revision !== revision) throw new Error('草稿已变化，请刷新后注册');
      return this.insertVersion(validateDefinition(JSON.parse(row.definition_json)));
    });
  }
  private insertVersion(d: AgentDefinition): AgentVersion {
    const key = `${d.id}@${d.version}`;
    const existing = this.versions().find((v) => v.version_key === key);
    const hash = memoryHash(d);
    if (existing) {
      if (existing.content_hash !== hash) throw new Error('同一 Agent 版本不能覆盖不同内容，请增加版本号');
      return existing;
    }
    this.ledger.db.prepare('INSERT INTO agent_versions VALUES (?,?,?,?,?,?,?)')
      .run(key, d.id, d.version, JSON.stringify(d), hash, 'registered', new Date().toISOString());
    this.ledger.db.prepare('INSERT OR IGNORE INTO agent_active_versions(agent_id,revision) VALUES (?,0)').run(d.id);
    this.ledger.appendEvent(null, 'HR', 'agent.registered', { key, hash });
    return this.get(key);
  }
  activate(id: string, key: string | null, revision: number): void {
    this.transaction(() => {
      if (key) { const v = this.get(key); if (v.agent_id !== id || v.status !== 'registered') throw new Error('无法激活此版本'); }
      if (this.ledger.db.prepare('UPDATE agent_active_versions SET version_key=?,revision=revision+1 WHERE agent_id=? AND revision=?')
        .run(key, id, revision).changes !== 1) throw new Error('活动版本已变化，请刷新后重试');
      this.ledger.appendEvent(null, 'HR', 'agent.activated', { agentId: id, key });
    });
  }
  retire(key: string): void {
    this.transaction(() => {
      this.get(key);
      this.ledger.db.prepare("UPDATE agent_versions SET status='retired' WHERE version_key=?").run(key);
      this.ledger.db.prepare('UPDATE agent_active_versions SET version_key=NULL,revision=revision+1 WHERE version_key=?').run(key);
      this.ledger.appendEvent(null, 'HR', 'agent.retired', { key });
    });
  }
  discover(query: DiscoveryQuery = {}) {
    const active = new Set(this.active().map((r) => r.version_key));
    return this.versions().filter((v) => active.has(v.version_key)).map((v) => {
      const d = JSON.parse(v.definition_json) as AgentDefinition;
      const reasons: string[] = [];
      if (v.status !== 'registered') reasons.push(v.status);
      if (query.capabilitiesAll?.some((c) => !d.capabilities.includes(c))) reasons.push('缺少必需能力');
      if (query.capabilitiesAny?.length && !query.capabilitiesAny.some((c) => d.capabilities.includes(c))) reasons.push('未命中任选能力');
      if (query.roleTags?.some((tag) => !d.roleTags.includes(tag))) reasons.push('角色标签不匹配');
      if (query.inputContract && d.inputContract !== query.inputContract || query.outputContract && d.outputContract !== query.outputContract) reasons.push('契约不匹配');
      if (query.tier && query.tier !== d.tier || query.templateId && query.templateId !== d.templateId) reasons.push('执行配置不匹配');
      const load = Number(this.ledger.db.prepare("SELECT COUNT(*) AS n FROM agent_invocations WHERE version_key=? AND state='running' AND expires_at>?").get(v.version_key, new Date().toISOString())?.n ?? 0);
      return { ...v, definition: d, eligible: reasons.length === 0, capacityAvailable: load < d.limits.maxConcurrency,
        activeCalls: load, reasons: reasons.length ? reasons : ['活动版本，能力与契约匹配'],
        readiness: '执行前复核提供商、MCP 连接和实际权限' };
    });
  }
  teams() { return this.ledger.db.prepare('SELECT * FROM agent_teams ORDER BY created_at,team_key').all() as unknown as { team_key: string; definition_json: string; content_hash: string }[]; }
  registerTeam(input: unknown): AgentTeam {
    const team = teamSchema.parse(input);
    for (const [slot, binding] of Object.entries(team.slots)) {
      const candidates = 'candidates' in binding ? binding.candidates : 'activeAgentId' in binding
        ? [{ agentId: binding.activeAgentId, version: this.active().find((a) => a.agent_id === binding.activeAgentId)?.version_key?.split('@')[1] ?? '' }] : [binding];
      for (const ref of candidates) {
        const v = this.get(`${ref.agentId}@${ref.version}`);
        if (v.status !== 'registered') throw new Error('团队不能引用已退役或撤销的版本');
        const d = JSON.parse(v.definition_json) as AgentDefinition;
        if (templateCatalog[d.templateId].slot !== slot) throw new Error(`模板不能执行团队槽位 ${slot}`);
        if ('capability' in binding && !d.capabilities.includes(binding.capability)) throw new Error('团队候选不具备要求的能力');
      }
    }
    const key = `${team.id}@${team.version}`;
    const prior = this.teams().find((t) => t.team_key === key);
    if (prior && prior.content_hash !== memoryHash(team)) throw new Error('团队版本不可覆盖');
    if (!prior) this.transaction(() => {
      this.ledger.db.prepare('INSERT INTO agent_teams VALUES (?,?,?,?)').run(key, JSON.stringify(team), memoryHash(team), new Date().toISOString());
      this.ledger.appendEvent(null, 'HR', 'agent.team.registered', { teamKey: key });
    });
    return team;
  }
  seed(root?: string): void {
    if (this.ledger.db.prepare("SELECT value FROM meta WHERE key='agent-platform-seeded'").get()) return;
    const registry = AgentRegistry.load(root);
    const paths = resolvePaths(root);
    this.transaction(() => {
      if (this.ledger.db.prepare("SELECT value FROM meta WHERE key='agent-platform-seeded'").get()) return;
      for (const [index, slot] of slotNames.entries()) {
        const p = registry.get(slot);
        const templateId = seedTemplates[index];
        const template = templateCatalog[templateId];
        const d = validateDefinition({ id: slot, version: p.version, name: p.nameZh, description: p.role,
          roleTags: [slot], templateId, inputContract: template.input, outputContract: template.output, capabilities: [template.capability],
          prompt: loadPrompt(p, paths), tier: p.tier, tools: p.tools, mcp: p.mcp ?? [],
          knowledge: { accessRoles: slot === 'fetcher' ? [] : [slot], maxContextChars: 4000 },
          memory: { read: slot === 'coordinator' ? ['job-profile', 'job-decisions', 'job-chat', 'approved-policies']
            : slot === 'profiler' ? ['job-profile', 'job-decisions', 'approved-policies'] : ['job-profile', 'candidate-evidence'],
            write: ['task-result'], scope: ['coordinator', 'profiler'].includes(slot) ? 'job' : 'candidate' },
          skills: slot === 'coordinator' ? [{ id: 'screening-plan', version: '1.0.0', content: readFileSync(path.join(paths.skillsDir, 'screening-plan.md'), 'utf8') }] : [],
        });
        const v = this.insertVersion(d);
        this.ledger.db.prepare('UPDATE agent_active_versions SET version_key=?,revision=1 WHERE agent_id=?').run(v.version_key, slot);
      }
      const team = teamSchema.parse({ id: 'builtin', version: '1.0.0', slots: Object.fromEntries(slotNames.map((slot) => [slot, { activeAgentId: slot }])) });
      this.ledger.db.prepare('INSERT INTO agent_teams VALUES (?,?,?,?)').run('builtin@1.0.0', JSON.stringify(team), memoryHash(team), new Date().toISOString());
      this.ledger.db.prepare("INSERT INTO meta VALUES ('agent-platform-seeded','1')").run();
    });
  }
  importPreview(root?: string) {
    const legacy = AgentRegistry.load(root);
    const paths = resolvePaths(root);
    return slotNames.map((slot) => {
      const p = legacy.get(slot);
      const current = this.versions().find((v) => v.version_key === `${slot}@${p.version}`) ?? this.versions().find((v) => v.agent_id === slot);
      if (!current) throw new Error('请先完成初始导入');
      const original = JSON.parse(current.definition_json) as AgentDefinition;
      let definition = validateDefinition({ ...original, name: p.nameZh, description: p.role, tier: p.tier, tools: p.tools,
        mcp: p.mcp ?? [], prompt: loadPrompt(p, paths), skills: original.skills.map((s) => s.id === 'screening-plan'
          ? { ...s, content: readFileSync(path.join(paths.skillsDir, 'screening-plan.md'), 'utf8') } : s) });
      const changed = memoryHash(definition) !== current.content_hash;
      if (changed) {
        const [major, minor, patch] = p.version.split('.').map(Number);
        let next = patch + 1;
        while (this.versions().some((v) => v.version_key === `${slot}@${major}.${minor}.${next}`)) next++;
        definition = { ...definition, version: `${major}.${minor}.${next}` };
      }
      return { slot, sourceKey: current.version_key, changed, oldDefinition: original, definition };
    });
  }
  manifest(jobId: string): AgentManifest | undefined {
    const row = this.ledger.db.prepare('SELECT manifest_json FROM job_agent_manifests WHERE job_id=?').get(jobId) as { manifest_json: string } | undefined;
    return row ? JSON.parse(row.manifest_json) as AgentManifest : undefined;
  }
  bind(jobId: string, teamKey: string, models: AgentManifest['models'], providerName: string, migration = false, providerIdentity?: string): AgentManifest {
    const old = this.manifest(jobId);
    if (old) {
      if (old.providerName !== providerName) throw new Error('当前提供商与任务绑定不一致，请切回原提供商');
      if (old.providerIdentity && old.providerIdentity !== providerIdentity) throw new Error('模型网关地址或协议与任务绑定不一致');
      return old;
    }
    const row = this.teams().find((t) => t.team_key === teamKey);
    if (!row) throw new Error('Agent 团队不存在');
    const team = teamSchema.parse(JSON.parse(row.definition_json));
    const bindings: AgentManifest['bindings'] = {};
    for (const [slot, binding] of Object.entries(team.slots)) {
      const refs = 'candidates' in binding ? binding.candidates : 'activeAgentId' in binding
        ? [{ agentId: binding.activeAgentId, version: this.active().find((a) => a.agent_id === binding.activeAgentId)?.version_key?.split('@')[1] ?? '' }] : [binding];
      // 候选集合内稳定选择；在途负载仅供准入，不让任务注册顺序随机改变结果。
      const eligible = refs.map((ref) => this.get(`${ref.agentId}@${ref.version}`)).filter((v) => v.status === 'registered')
        .filter((v) => { const d = JSON.parse(v.definition_json) as AgentDefinition; return templateCatalog[d.templateId].slot === slot && (!('capability' in binding) || d.capabilities.includes(binding.capability)); })
        .sort((a, b) => a.version_key.localeCompare(b.version_key));
      if (!eligible.length) throw new Error(`团队槽位 ${slot} 没有可执行候选`);
      const selected = eligible[0];
      bindings[slot] = { key: selected.version_key, hash: selected.content_hash,
        definition: JSON.parse(selected.definition_json) as AgentDefinition,
        reason: refs.length > 1 ? `团队候选内按确切版本标识稳定选择，共 ${eligible.length} 个合格候选` : '用户指定团队的精确/活动版本绑定' };
    }
    const manifest = { teamKey, migration, providerName, providerIdentity, models, bindings };
    this.transaction(() => {
      this.ledger.db.prepare('INSERT INTO job_agent_manifests VALUES (?,?,?,?)').run(jobId, JSON.stringify(manifest), memoryHash(manifest), new Date().toISOString());
      this.ledger.appendEvent(jobId, 'agent-registry', 'agent.team.bound', { teamKey, migration, bindings: Object.fromEntries(Object.entries(bindings).map(([slot, b]) => [slot, { key: b.key, hash: b.hash, reason: b.reason }])) });
    });
    return manifest;
  }
  assertUsable(binding: AgentManifest['bindings'][string]): void {
    const row = this.get(binding.key);
    if (row.content_hash !== binding.hash) throw new AgentBlockedError('Agent 定义哈希与任务绑定不一致');
  }
  beginInvocation(jobId: string, slot: string, b: AgentManifest['bindings'][string], input: unknown, meta: unknown): string {
    return this.transaction(() => {
      this.assertUsable(b);
      const now = new Date().toISOString();
      const load = Number(this.ledger.db.prepare("SELECT COUNT(*) AS n FROM agent_invocations WHERE version_key=? AND state='running' AND expires_at>?").get(b.key, now)?.n ?? 0);
      if (load >= b.definition.limits.maxConcurrency) throw new Error(`Agent 容量已满：${b.key}`);
      const id = randomUUID();
      this.ledger.db.prepare(`INSERT INTO agent_invocations(id,job_id,slot,version_key,state,started_at,expires_at,input_hash,meta_json) VALUES (?,?,?,?,'running',?,?,?,?)`)
        .run(id, jobId, slot, b.key, now, new Date(Date.now() + b.definition.limits.timeoutMs + 10000).toISOString(), memoryHash(input), JSON.stringify(meta));
      return id;
    });
  }
  finishInvocation(id: string, ok: boolean, result: unknown): void {
    this.ledger.db.prepare('UPDATE agent_invocations SET state=?,finished_at=?,result_hash=?,error=? WHERE id=?')
      .run(ok ? 'completed' : 'failed', new Date().toISOString(), memoryHash(result), ok ? null : String(result).slice(0, 2000), id);
  }
  registry(manifest: AgentManifest): AgentRegistry {
    const presets: Record<string, AgentPreset> = {};
    for (const [slot, b] of Object.entries(manifest.bindings)) {
      const d = b.definition;
      presets[slot] = { id: d.id, nameZh: d.name, role: d.description, version: d.version, tier: d.tier,
        tools: d.tools, mcp: d.mcp, capabilities: d.capabilities, maxDepth: slot === 'coordinator' ? 1 : 0,
        canDelegate: slot === 'coordinator', outputSchema: templateCatalog[d.templateId].schema, prompt: '',
        promptContent: d.prompt + d.skills.filter((s) => s.id !== 'screening-plan').map((s) => `\n【技能 ${s.id}@${s.version}】\n${s.content}`).join(''), definitionHash: b.hash };
    }
    return AgentRegistry.bound(presets, memoryHash(manifest));
  }
}
