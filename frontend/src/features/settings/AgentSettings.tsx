import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';

interface AgentVersion {
  version_key?: string;
  agent_id: string;
  version: string;
  status?: string;
  definition_json?: string;
}

interface AgentDefinition {
  name?: string;
  tier?: string;
  description?: string;
  roleTags?: string[];
}

interface AgentTemplate {
  slot?: string;
  input?: string;
  output?: string;
  capability?: string;
  schema?: string;
}

interface AgentTeam {
  team_key: string;
  definition_json?: string;
}

interface MemoryVersion {
  id: string;
  family?: string;
  version?: string;
  status?: string;
  createdAt?: string;
}

interface MemoryProposal {
  id: string;
  status?: string;
  rule?: string;
  createdAt?: string;
}

function parseDefinition(raw: string | undefined): AgentDefinition {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AgentDefinition;
  } catch {
    return {};
  }
}

const STATUS_LABEL: Record<string, string> = {
  registered: '已发布', draft: '草稿', retired: '已退役', active: '启用中',
};

/**
 * Agent 团队页：已发布角色与已保存团队（只读）。
 * 创建/编辑/发布、团队编辑器、任务绑定仍待接。
 */
export function AgentsPanel(): ReactElement {
  const queryClient = useQueryClient();
  const [draftStatus, setDraftStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: async () => api<{ versions?: AgentVersion[] }>('/api/agents'),
    staleTime: 10_000,
  });
  const teams = useQuery({
    queryKey: ['agent-teams'],
    queryFn: async () => api<{ teams?: AgentTeam[] }>('/api/agent-teams'),
    staleTime: 10_000,
  });
  const catalog = useQuery({
    queryKey: ['agent-catalog'],
    queryFn: async () => api<{ templates?: Record<string, AgentTemplate> }>('/api/agent-catalog'),
    staleTime: 60_000,
  });

  const versions = agents.data?.versions ?? [];
  const teamList = teams.data?.teams ?? [];
  const templates = catalog.data?.templates ?? {};

  /**
   * 组装一个可注册的角色定义：字段集与服务端 /api/agent-catalog 的 example 一致，
   * 契约与能力来自所选模板（slot/input/output/capability/schema）。
   */
  const buildDefinition = (templateId: string, name: string, prompt: string, tier: string): Record<string, unknown> => {
    const template = templates[templateId] ?? {};
    const id = `custom-${Date.now().toString(36)}`;
    return {
      id,
      version: '1.0.0',
      name,
      templateId,
      inputContract: template.input ?? 'recruitment.specialist-input@1',
      outputContract: template.output ?? 'recruitment.findings@1',
      capabilities: template.capability ? [template.capability] : ['resume.specialist-check@1'],
      prompt,
      roleTags: [id],
      tier,
    };
  };

  /** 保存草稿；publish 为真时再调用 register 发布并启用。 */
  const saveAgent = async (publish: boolean): Promise<void> => {
    const name = (document.getElementById('agent-name') as HTMLInputElement | null)?.value.trim() ?? '';
    const prompt = (document.getElementById('agent-prompt') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    const templateId = (document.getElementById('agent-template') as HTMLSelectElement | null)?.value ?? 'structured-llm.v1';
    const tier = (document.getElementById('agent-tier') as HTMLSelectElement | null)?.value ?? 'flash';
    if (!name) { setDraftStatus('请先填写角色名称。'); return; }
    if (prompt.length < 10) { setDraftStatus('工作指令至少写 10 个字。'); return; }
    setBusy(true);
    try {
      const created = await api<{ draft: { id: string; revision: number } }>('/api/agent-drafts', {
        method: 'POST',
        body: JSON.stringify({ definition: buildDefinition(templateId, name, prompt, tier) }),
      });
      if (publish) {
        await api(`/api/agent-drafts/${encodeURIComponent(created.draft.id)}/register`, {
          method: 'POST',
          body: JSON.stringify({ revision: created.draft.revision }),
        });
        setDraftStatus('角色已发布并启用。');
      } else {
        setDraftStatus('草稿已保存，可继续编辑后再发布。');
      }
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    } catch (error) {
      setDraftStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="screening-default-setting">
        <label htmlFor="new-agent-team">新筛选默认团队</label>
        <select id="new-agent-team" className="input" defaultValue={teamList[0]?.team_key ?? ''}>
          {teamList.length === 0 ? <option value="">内置团队</option> : null}
          {teamList.map((team) => <option key={team.team_key} value={team.team_key}>{team.team_key}</option>)}
        </select>
        <p className="muted">选择后自动保存，用于之后新建的筛选；已有任务保持原团队。</p>
      </div>
      <div className="agent-onboarding">
        <b>自定义 Agent：三步完成</b>
        <p>① 创建角色，写清职责　② 发布并启用　③ 配置到团队，在新会话中使用</p>
        <button id="agent-open-guide" className="btn ghost" type="button" disabled>操作指南（待接）</button>
      </div>
      <nav className="help-nav" aria-label="Agent 管理分类">
        <button className="active" data-agent-tab="roles" type="button">我的角色</button>
        <button data-agent-tab="editor" type="button" disabled>创建与编辑</button>
        <button data-agent-tab="teams" type="button" disabled>团队配置</button>
        <button data-agent-tab="runs" type="button" disabled>任务绑定</button>
      </nav>

      <details className="agent-team-editor">
        <summary>创建角色（草稿或直接发布）</summary>
        <div className="form-grid">
          <label>职责模板
            <select id="agent-template" className="input" defaultValue="structured-llm.v1">
              {Object.keys(templates).map((key) => <option key={key} value={key}>{key}</option>)}
            </select>
          </label>
          <label>模型档位
            <select id="agent-tier" className="input" defaultValue="flash">
              <option value="flash">快速 · 适合批量处理</option>
              <option value="pro">深入 · 适合复杂判断</option>
            </select>
          </label>
          <label className="span-2">角色名称<input id="agent-name" className="input" placeholder="例如：支付项目检查员" maxLength={60} /></label>
          <label className="span-2">工作指令<textarea id="agent-prompt" className="input" rows={5} placeholder="检查什么、依据是什么、遇到信息不足时如何处理…" /></label>
        </div>
        <div className="knowledge-actions">
          <button className="btn" type="button" disabled={busy} onClick={() => { void saveAgent(false); }}>保存草稿</button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void saveAgent(true); }}>发布并启用</button>
          <span className="settings-status" role="status">{draftStatus}</span>
        </div>
        <p className="muted">契约与能力来自所选模板；发布后需在团队配置里挂到槽位，新会话才会用到。</p>
      </details>

      <section data-agent-section="roles">
        {agents.isLoading ? <div className="empty-note">正在读取角色…</div>
          : agents.error ? <div className="empty-note">读取失败：{agents.error instanceof Error ? agents.error.message : String(agents.error)}</div>
            : versions.length === 0 ? <div className="empty-note">还没有已发布的角色。</div>
              : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>角色</th><th>版本</th><th>状态</th><th>档位</th></tr></thead>
                    <tbody>
                      {versions.map((version) => {
                        const definition = parseDefinition(version.definition_json);
                        return (
                          <tr key={version.version_key ?? `${version.agent_id}@${version.version}`}>
                            <td>
                              <b>{definition.name ?? version.agent_id}</b>
                              <div className="muted">{definition.description ?? version.agent_id}</div>
                            </td>
                            <td><span className="tag">{version.agent_id}@{version.version}</span></td>
                            <td><span className={`tag ${version.status === 'registered' ? 'ok' : version.status === 'retired' ? 'danger' : ''}`}>{STATUS_LABEL[version.status ?? ''] ?? version.status ?? ''}</span></td>
                            <td>{definition.tier ?? ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
      </section>

      <section className="agent-saved-teams">
        <h3>已保存的团队</h3>
        <p className="muted">保存的组合可以在新建会话时重复使用。</p>
        <div id="agent-team-list">
          {teamList.length === 0 ? <div className="empty-note">还没有自定义团队。</div>
            : teamList.map((team) => (
              <div className="memory-item" key={team.team_key}>
                <b>{team.team_key}</b>
                <span className="muted"> · 团队定义已保存</span>
              </div>
            ))}
        </div>
      </section>
      <p id="agent-status" className="settings-status" role="status">
        创建、编辑、发布与团队配置仍待接；当前为只读视图。
      </p>
    </>
  );
}

/**
 * 岗位与评分标准页：岗位族、版本历史与提案（只读）。
 * 创建岗位族、提交提案、审批仍待接。
 */
export function MemoryPanel(): ReactElement {
  const queryClient = useQueryClient();
  const [familyStatus, setFamilyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const memory = useQuery({
    queryKey: ['memory'],
    queryFn: async () => api<{ families?: { id: string; name?: string }[]; versions?: MemoryVersion[]; proposals?: MemoryProposal[] }>('/api/memory'),
    staleTime: 10_000,
  });
  const createFamily = async (): Promise<void> => {
    const input = document.getElementById('memory-family-name') as HTMLInputElement | null;
    const name = (input?.value ?? '').trim();
    if (!name) {
      setFamilyStatus('请先填写岗位族名称。');
      return;
    }
    setBusy(true);
    try {
      await api('/api/memory/families', { method: 'POST', body: JSON.stringify({ name, description: '' }) });
      if (input) input.value = '';
      setFamilyStatus('岗位族已创建。');
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
    } catch (error) {
      setFamilyStatus(`创建失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const families = memory.data?.families ?? [];
  const versions = memory.data?.versions ?? [];
  const proposals = memory.data?.proposals ?? [];

  return (
    <>
      <div className="screening-default-setting">
        <label htmlFor="new-policy-version">新筛选默认评分标准</label>
        <select id="new-policy-version" className="input">
          <option value="">按本次需求生成</option>
          {versions.filter((version) => version.status === 'approved').map((version) => (
            <option key={version.id} value={version.id}>{version.family ?? ''} {version.version ?? ''}</option>
          ))}
        </select>
        <p className="muted">选择后自动保存，用于之后新建的筛选；仅可选择已批准且有效的标准，已有任务保持原评分卡。</p>
      </div>
      <p className="muted">跨任务复用经过人工批准的评价标准。新版本只供新任务选择，已有任务保持原快照。</p>

      <div className="memory-family-row">
        <select id="memory-family" className="input" aria-label="岗位族">
          {families.length === 0 ? <option value="">还没有岗位族</option> : null}
          {families.map((family) => <option key={family.id} value={family.id}>{family.name ?? family.id}</option>)}
        </select>
        <input id="memory-family-name" className="input" placeholder="新岗位族名称" maxLength={100} />
        <button className="btn" id="memory-family-create" type="button" disabled={busy} onClick={() => { void createFamily(); }}>创建岗位族</button>
      </div>

      <nav className="help-nav" aria-label="记忆管理分类">
        <button type="button" data-memory-tab="versions" className="active">版本历史</button>
        <button type="button" data-memory-tab="proposals" disabled>提案与审批</button>
        <button type="button" data-memory-tab="create" disabled>创建修订提案</button>
        <button type="button" data-memory-tab="job" disabled>当前任务记忆</button>
      </nav>

      <section data-memory-section="versions">
        <div id="memory-versions">
          {memory.isLoading ? <div className="empty-note">正在读取版本…</div>
            : versions.length === 0 ? <div className="empty-note">还没有跨任务复用的评分标准。完成一次筛选后可从结果提炼。</div>
              : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>岗位族</th><th>版本</th><th>状态</th></tr></thead>
                    <tbody>
                      {versions.map((version) => (
                        <tr key={version.id}>
                          <td>{version.family ?? ''}</td>
                          <td><span className="tag">{version.version ?? version.id}</span></td>
                          <td>{version.status ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </div>
      </section>
      <section data-memory-section="proposals" className="hidden">
        <div id="memory-proposals">
          {proposals.length === 0 ? <div className="empty-note">没有待审批的提案。</div>
            : proposals.map((proposal) => (
              <div className="memory-item" key={proposal.id}>
                <b>{proposal.rule ?? proposal.id}</b> <span className="muted">{proposal.status ?? ''}</span>
              </div>
            ))}
        </div>
      </section>
      <p id="memory-family-status" className="settings-status" role="status">{familyStatus}</p>`n      <p id="memory-status" className="settings-status" role="status">
        创建岗位族、提交提案与审批仍待接；当前为只读视图。
      </p>
    </>
  );
}
