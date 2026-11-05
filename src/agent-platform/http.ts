import type { Ledger } from '../core/ledger.ts';
import { AgentStore } from './store.ts';
import { templateCatalog, validateDefinition } from './catalog.ts';
import { memoryHash } from '../memory/service.ts';

/** 管理 API 不暴露到 Agent 工具池，沿用本地单用户访问边界。 */
export function agentRoute(ledger: Ledger, method: string, pathname: string, body: Record<string, unknown>, query: URLSearchParams = new URLSearchParams()): unknown {
  const store = new AgentStore(ledger);
  store.seed();
  if (method === 'GET' && pathname === '/api/agent-catalog') return { templates: templateCatalog,
    scope: '模板和契约由代码注册；新角色默认无工具和长期记忆权限',
    example: { id: 'qualification-checker', version: '1.0.0', name: '职业资格检查', templateId: 'structured-llm.v1',
      inputContract: templateCatalog['structured-llm.v1'].input, outputContract: templateCatalog['structured-llm.v1'].output,
      capabilities: [templateCatalog['structured-llm.v1'].capability], prompt: '检查简历中的职业资格。只输出有原文依据的发现，没有发现时输出空 findings。', roleTags: ['qualification'] } };
  if (method === 'GET' && pathname === '/api/agents') return { version: 'dynamic-1', fingerprint: memoryHash(store.active()),
    agents: store.discover().map((v) => ({ id: v.agent_id, nameZh: v.definition.name, role: v.definition.description, tier: v.definition.tier,
      maxDepth: templateCatalog[v.definition.templateId].slot === 'coordinator' ? 1 : 0, tools: v.definition.tools, mcp: v.definition.mcp,
      capabilities: v.definition.capabilities, outputSchema: templateCatalog[v.definition.templateId].schema, version: v.version })),
    versions: store.versions(), drafts: store.drafts(), active: store.active(),
    discovery: store.discover({ capabilitiesAll: query.get('capabilitiesAll')?.split(',').filter(Boolean), capabilitiesAny: query.get('capabilitiesAny')?.split(',').filter(Boolean),
      roleTags: query.get('roleTags')?.split(',').filter(Boolean), inputContract: query.get('inputContract') ?? undefined,
      outputContract: query.get('outputContract') ?? undefined, tier: query.get('tier') ?? undefined, templateId: query.get('templateId') ?? undefined }),
    invocations: ledger.db.prepare('SELECT * FROM agent_invocations ORDER BY started_at DESC LIMIT 50').all() };
  if (pathname === '/api/agent-drafts' && method === 'POST') return { draft: store.saveDraft(body.definition) };
  const draft = /^\/api\/agent-drafts\/([^/]+)(?:\/(validate|register))?$/.exec(pathname);
  if (draft) {
    const id = decodeURIComponent(draft[1]);
    if (method === 'PATCH' && !draft[2]) return { draft: store.saveDraft(body.definition, id, Number(body.revision)) };
    if (method === 'DELETE' && !draft[2]) { ledger.db.prepare('DELETE FROM agent_drafts WHERE id=?').run(id); return { deleted: true }; }
    const row = store.draft(id);
    if (method === 'POST' && draft[2] === 'validate') return { definition: validateDefinition(JSON.parse(row.definition_json)), valid: true };
    if (method === 'POST' && draft[2] === 'register') {
      if (body.revision !== row.revision) throw new Error('草稿已变化，请刷新后注册');
      return { version: store.registerDraft(id, row.revision) };
    }
  }
  const active = /^\/api\/agents\/([^/]+)\/activate$/.exec(pathname);
  if (active && method === 'POST') { store.activate(decodeURIComponent(active[1]), typeof body.versionKey === 'string' ? body.versionKey : null, Number(body.revision)); return { updated: true }; }
  const versions = /^\/api\/agents\/([^/]+)\/versions$/.exec(pathname);
  if (versions && method === 'GET') return { versions: store.versions().filter((v) => v.agent_id === decodeURIComponent(versions[1])) };
  const state = /^\/api\/agents\/([^/]+)\/versions\/([^/]+)\/retire$/.exec(pathname);
  if (state && method === 'POST') { store.retire(`${decodeURIComponent(state[1])}@${decodeURIComponent(state[2])}`); return { updated: true }; }
  if (pathname === '/api/agent-teams' && method === 'GET') return { teams: store.teams() };
  if (pathname === '/api/agent-teams' && method === 'POST') return { team: store.registerTeam(body.definition) };
  const manifest = /^\/api\/run\/([^/]+)\/agent-manifest$/.exec(pathname);
  if (manifest && method === 'GET') return { manifest: store.manifest(decodeURIComponent(manifest[1])) ?? null,
    invocations: ledger.db.prepare('SELECT * FROM agent_invocations WHERE job_id=? ORDER BY started_at').all(decodeURIComponent(manifest[1])) };
  if (pathname === '/api/agents/import-preview' && method === 'GET') {
    return { previews: store.importPreview(), note: '仅预览；需创建草稿并注册新版本，不会覆盖生产定义。' };
  }
  throw new Error('未知 Agent 管理接口');
}
