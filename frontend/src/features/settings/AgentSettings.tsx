import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { readValue } from '../../lib/dom.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { useUiStore } from '../../store/ui.ts';
import { MemoryTab } from '../drawer/DrawerTabs.tsx';

interface AgentVersion {
  version_key?: string;
  agent_id: string;
  version: string;
  status?: string;
  definition_json?: string;
}

interface AgentDefinition {
  name?: string;
  templateId?: string;
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

interface JobFamily {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
}

interface PolicyVersion {
  id: string;
  family_id: string;
  version: number;
  profile_json: string;
  status: 'approved' | 'retired' | 'needs_review';
  valid_from?: string;
  valid_to?: string | null;
  created_at?: string;
}

interface PolicyProposal {
  id: string;
  family_id: string;
  rule: string;
  why: string;
  how_to_apply: string;
  content_hash: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  created_at?: string;
  published_version_id?: string | null;
}

function parseDefinition(raw: string | undefined): AgentDefinition {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AgentDefinition;
  } catch {
    return {};
  }
}

const TEAM_SLOTS = ['coordinator', 'profiler', 'fetcher', 'parser', 'assessor', 'auditor', 'specialist'] as const;

const SLOT_LABEL: Record<string, string> = {
  coordinator: '协调', profiler: '画像', fetcher: '接入', parser: '解析',
  assessor: '评估', auditor: '核查', specialist: '专项检查',
};

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
  const [teamStatus, setTeamStatus] = useState('');
  const [lastRetired, setLastRetired] = useState<{ agentId: string; version: string } | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
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

  // 槽位 → 可绑定角色：模板的 slot 必须与团队槽位一致（服务端同样校验）
  const slotCandidates: Record<string, string[]> = {};
  for (const version of versions) {
    if (version.status === 'retired') continue;
    const definition = parseDefinition(version.definition_json);
    const slot = definition.templateId ? templates[definition.templateId]?.slot : undefined;
    if (!slot) continue;
    const list = slotCandidates[slot] ?? [];
    if (!list.includes(version.agent_id)) list.push(version.agent_id);
    slotCandidates[slot] = list;
  }

  const saveTeam = async (): Promise<void> => {
    const slots: Record<string, { activeAgentId: string }> = {};
    for (const slot of TEAM_SLOTS) {
      const select = document.getElementById(`team-slot-${slot}`) as HTMLSelectElement | null;
      const value = select?.value ?? '';
      if (value) slots[slot] = { activeAgentId: value };
    }
    if (!slots.coordinator) {
      setTeamStatus('至少要为「协调」槽位选择角色。');
      return;
    }
    setTeamBusy(true);
    try {
      const definition = { id: `team-${Date.now().toString(36)}`, version: '1.0.0', slots };
      const created = await api<{ team: { team_key: string } }>('/api/agent-teams', {
        method: 'POST',
        body: JSON.stringify({ definition }),
      });
      setTeamStatus(`团队已保存：${created.team?.team_key ?? ''}`);
      await queryClient.invalidateQueries({ queryKey: ['agent-teams'] });
    } catch (error) {
      setTeamStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTeamBusy(false);
    }
  };

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

  /** 退役一个已发布的角色版本；团队不能引用已退役版本。 */
  const retireVersion = async (agentId: string, version: string): Promise<void> => {
    if (!window.confirm(`确定退役 ${agentId}@${version}？已引用该版本的团队将无法再新建会话。`)) return;
    setDraftStatus('');
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version)}/retire`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setLastRetired({ agentId, version });
      setDraftStatus(`${agentId}@${version} 已退役；点「撤销退役」可立即恢复。`);
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    } catch (error) {
      setDraftStatus(`退役失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 撤销退役：把版本恢复成已发布，并把活动版本指针放回原位。 */
  const restoreVersion = async (agentId: string, version: string): Promise<void> => {
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version)}/restore`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setLastRetired(null);
      setDraftStatus(`${agentId}@${version} 已恢复。`);
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    } catch (error) {
      setDraftStatus(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
          {lastRetired ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => { void restoreVersion(lastRetired.agentId, lastRetired.version); }}
            >
              撤销退役 {lastRetired.agentId}@{lastRetired.version}
            </button>
          ) : null}
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
                    <thead><tr><th>角色</th><th>版本</th><th>状态</th><th>档位</th><th /></tr></thead>
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
                            <td>
                              {version.status === 'registered' ? (
                                <button className="btn ghost danger-text" type="button" onClick={() => { void retireVersion(version.agent_id, version.version); }}>退役</button>
                              ) : version.status === 'retired' ? (
                                <button className="btn ghost" type="button" onClick={() => { void restoreVersion(version.agent_id, version.version); }}>恢复</button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
      </section>

      <details className="agent-team-editor">
        <summary>团队配置（把角色挂到槽位）</summary>
        <p className="muted">每个槽位只能选与该槽位模板一致的角色；保存后可在新建会话时选用。</p>
        <div className="form-grid">
          {TEAM_SLOTS.map((slot) => {
            const candidates = slotCandidates[slot] ?? [];
            return (
              <label key={slot}>
                {SLOT_LABEL[slot] ?? slot}
                <select id={`team-slot-${slot}`} className="input" defaultValue={candidates[0] ?? ''}>
                  {slot === 'specialist' ? <option value="">（不启用）</option> : null}
                  {candidates.length === 0 ? <option value="">无可用角色</option> : null}
                  {candidates.map((agentId) => <option key={agentId} value={agentId}>{agentId}</option>)}
                </select>
              </label>
            );
          })}
        </div>
        <div className="knowledge-actions">
          <button className="btn primary" type="button" disabled={teamBusy} onClick={() => { void saveTeam(); }}>保存团队</button>
          <span className="settings-status" role="status">{teamStatus}</span>
        </div>
      </details>

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
/**
 * 岗位与评分标准页：版本历史 / 提案与审批 / 创建修订提案 / 当前任务记忆。
 * 版本只读（可退役）；提案可提交、批准、驳回；当前任务记忆复用任务面板的展示。
 */
export function MemoryPanel(): ReactElement {
  const queryClient = useQueryClient();
  const activeJobId = useUiStore((state) => state.activeJobId);
  const [tab, setTab] = useState<'versions' | 'proposals' | 'create' | 'job'>('versions');
  const [familyStatus, setFamilyStatus] = useState('');
  const [proposalStatus, setProposalStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const memory = useQuery({
    queryKey: ['memory'],
    queryFn: async () => api<{
      families?: JobFamily[];
      versions?: PolicyVersion[];
      proposals?: PolicyProposal[];
    }>('/api/memory'),
    staleTime: 5_000,
  });

  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: async () => (await api<{ jobs?: { id: string; title?: string; status?: string }[] }>('/api/jobs')).jobs ?? [],
    staleTime: 10_000,
  });

  const families = memory.data?.families ?? [];
  const versions = memory.data?.versions ?? [];
  const proposals = memory.data?.proposals ?? [];
  const approved = versions.filter((version) => version.status === 'approved');
  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const familyName = (id: string): string => families.find((family) => family.id === id)?.name ?? id;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['memory'] });
  };

  const createFamily = async (): Promise<void> => {
    const input = document.getElementById('memory-family-name') as HTMLInputElement | null;
    const name = (input?.value ?? '').trim();
    if (!name) { setFamilyStatus('请先填写岗位族名称。'); return; }
    setBusy(true);
    try {
      await api('/api/memory/families', { method: 'POST', body: JSON.stringify({ name, description: '' }) });
      if (input) input.value = '';
      setFamilyStatus('岗位族已创建。');
      await refresh();
    } catch (error) {
      setFamilyStatus(`创建失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (proposal: PolicyProposal, decision: 'approve' | 'reject' | 'withdraw'): Promise<void> => {
    const label = decision === 'approve' ? '批准' : decision === 'reject' ? '驳回' : '撤回';
    if (!window.confirm(`确定${label}这条提案？`)) return;
    setBusy(true);
    try {
      await api(`/api/memory/proposals/${encodeURIComponent(proposal.id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, contentHash: proposal.content_hash }),
      });
      setProposalStatus(`提案已${label}。`);
      await refresh();
    } catch (error) {
      setProposalStatus(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const retireVersion = async (version: PolicyVersion): Promise<void> => {
    if (!window.confirm(`退役 ${familyName(version.family_id)} v${version.version}？已有任务保持原快照。`)) return;
    setBusy(true);
    try {
      await api(`/api/memory/versions/${encodeURIComponent(version.id)}/retire`, { method: 'POST', body: JSON.stringify({}) });
      setProposalStatus(`${familyName(version.family_id)} v${version.version} 已退役。`);
      await refresh();
    } catch (error) {
      setProposalStatus(`退役失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const submitProposal = async (): Promise<void> => {
    const familyId = readValue('memory-family');
    const rule = readValue('memory-rule');
    const why = readValue('memory-why');
    const how = readValue('memory-how');
    const rawProfile = readValue('memory-profile');
    if (!familyId) { setProposalStatus('请先选择岗位族。'); return; }
    if (!rule || !why) { setProposalStatus('规则与修改理由都要填。'); return; }
    let profile: unknown;
    try {
      profile = rawProfile ? JSON.parse(rawProfile) : undefined;
    } catch {
      setProposalStatus('评分卡 JSON 解析失败，请检查格式。');
      return;
    }
    setBusy(true);
    try {
      await api('/api/memory/proposals', {
        method: 'POST',
        body: JSON.stringify({
          familyId,
          sourceJobId: readValue('memory-source-job') || undefined,
          baseVersionId: readValue('memory-base-version') || undefined,
          rule,
          why,
          howToApply: how,
          profile,
          validFrom: readValue('memory-valid-from') || undefined,
          validTo: readValue('memory-valid-to') || undefined,
        }),
      });
      setProposalStatus('提案已提交，等待审批。');
      setTab('proposals');
      await refresh();
    } catch (error) {
      setProposalStatus(`提交失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadSourceProfile = (): void => {
    const versionId = readValue('memory-base-version');
    const version = versions.find((item) => item.id === versionId);
    const target = document.getElementById('memory-profile') as HTMLTextAreaElement | null;
    if (!target) return;
    if (version) {
      target.value = JSON.stringify(JSON.parse(version.profile_json), null, 2);
      setProposalStatus('已载入所选版本的评分卡，可编辑后提交。');
      return;
    }
    setProposalStatus('先选择一个基准版本，或直接粘贴评分卡 JSON。');
  };

  return (
    <>
      <p className="muted">跨任务复用经过人工批准的评价标准。新版本只供新任务选择，已有任务保持原快照。</p>

      <div className="memory-family-row">
        <select id="memory-family" className="input" aria-label="岗位族">
          {families.length === 0 ? <option value="">还没有岗位族</option> : null}
          {families.map((family) => <option key={family.id} value={family.id}>{family.name}</option>)}
        </select>
        <input id="memory-family-name" className="input" placeholder="新岗位族名称" maxLength={100} />
        <button className="btn" id="memory-family-create" type="button" disabled={busy} onClick={() => { void createFamily(); }}>创建岗位族</button>
      </div>
      <p id="memory-family-status" className="settings-status" role="status">{familyStatus}</p>

      <nav className="help-nav" aria-label="记忆管理分类">
        <button type="button" data-memory-tab="versions" className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>版本历史</button>
        <button type="button" data-memory-tab="proposals" className={tab === 'proposals' ? 'active' : ''} onClick={() => setTab('proposals')}>提案与审批{pending.length > 0 ? `（${pending.length}）` : ''}</button>
        <button type="button" data-memory-tab="create" className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>创建修订提案</button>
        <button type="button" data-memory-tab="job" className={tab === 'job' ? 'active' : ''} onClick={() => setTab('job')}>当前任务记忆</button>
      </nav>

      <section data-memory-section="versions" className={tab === 'versions' ? '' : 'hidden'}>
        <div id="memory-versions">
          {memory.isLoading ? <div className="empty-note">正在读取版本…</div>
            : versions.length === 0 ? <div className="empty-note">还没有跨任务复用的评分标准。完成一次筛选后可从结果提炼。</div>
              : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>岗位族</th><th>版本</th><th>状态</th><th>生效</th><th /></tr></thead>
                    <tbody>
                      {versions.map((version) => (
                        <tr key={version.id}>
                          <td>{familyName(version.family_id)}</td>
                          <td><span className="tag">v{version.version}</span></td>
                          <td>
                            <span className={`tag${version.status === 'approved' ? ' ok' : version.status === 'retired' ? ' danger' : ''}`}>
                              {version.status === 'approved' ? '已批准' : version.status === 'retired' ? '已退役' : '待复核'}
                            </span>
                          </td>
                          <td className="muted">{fmtDateTime(version.valid_from)}</td>
                          <td>
                            {version.status === 'approved' ? (
                              <button className="btn ghost danger-text" type="button" disabled={busy} onClick={() => { void retireVersion(version); }}>退役</button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </div>
      </section>

      <section data-memory-section="proposals" className={tab === 'proposals' ? '' : 'hidden'}>
        <div id="memory-proposals">
          {proposals.length === 0
            ? <div className="empty-note">没有提案。切换到「创建修订提案」起草一条。</div>
            : proposals.map((proposal) => (
              <div className="eval-card" key={proposal.id}>
                <div className="eval-head">
                  <b>{proposal.rule || '（无规则描述）'}</b>
                  <span className={`tag${proposal.status === 'approved' ? ' ok' : proposal.status === 'rejected' ? ' danger' : ''}`}>
                    {proposal.status === 'pending' ? '待审批' : proposal.status === 'approved' ? '已批准' : proposal.status === 'rejected' ? '已驳回' : '已撤回'}
                  </span>
                </div>
                <p className="muted">{familyName(proposal.family_id)} · 提交于 {fmtDateTime(proposal.created_at)}</p>
                {proposal.why ? <p>理由：{proposal.why}</p> : null}
                {proposal.how_to_apply ? <p className="muted">应用：{proposal.how_to_apply}</p> : null}
                {proposal.status === 'pending' ? (
                  <div className="modal-actions">
                    <button className="btn primary" type="button" disabled={busy} onClick={() => { void decide(proposal, 'approve'); }}>批准</button>
                    <button className="btn ghost danger-text" type="button" disabled={busy} onClick={() => { void decide(proposal, 'reject'); }}>驳回</button>
                    <span className="spacer" />
                    <button className="btn ghost" type="button" disabled={busy} onClick={() => { void decide(proposal, 'withdraw'); }}>撤回</button>
                  </div>
                ) : null}
              </div>
            ))}
        </div>
      </section>

      <section data-memory-section="create" className={tab === 'create' ? '' : 'hidden'}>
        <p>从已完成画像的会话或已发布版本起草；提交前请去除个人信息并检查评分依据。</p>
        <div className="memory-family-row">
          <select id="memory-base-version" className="input" aria-label="基准版本">
            <option value="">不基于已有版本</option>
            {approved.map((version) => (
              <option key={version.id} value={version.id}>{familyName(version.family_id)} v{version.version}</option>
            ))}
          </select>
          <button className="btn" type="button" onClick={loadSourceProfile}>载入参考</button>
        </div>
        <div className="form-grid">
          <label className="span-2">来源会话（可选）
            <select id="memory-source-job" className="input" defaultValue="">
              <option value="">不关联会话</option>
              {(jobs.data ?? []).filter((job) => job.status === 'completed').map((job) => (
                <option key={job.id} value={job.id}>{job.title ?? job.id}</option>
              ))}
            </select>
          </label>
          <label className="span-2">规则<input id="memory-rule" className="input" placeholder="例如：支付后端更重视项目实践" /></label>
          <label className="span-2">为什么修改<textarea id="memory-why" className="input" rows={2} placeholder="业务理由，请勿填写候选人身份信息" /></label>
          <label className="span-2">如何应用<textarea id="memory-how" className="input" rows={2} placeholder="说明适用岗位与评分方法" /></label>
          <label>开始生效<input id="memory-valid-from" type="datetime-local" className="input" /></label>
          <label>结束生效（可选）<input id="memory-valid-to" type="datetime-local" className="input" /></label>
        </div>
        <details>
          <summary>编辑完整岗位与评分卡</summary>
          <textarea id="memory-profile" className="input memory-json" rows={8} aria-label="岗位和评分卡 JSON" placeholder='{"jd":{...},"scorecard":{"dimensions":[...]}}' />
          <p className="muted">权重合计必须为 100；此处不会修改来源任务。</p>
        </details>
        <button id="memory-submit" type="button" className="btn primary" disabled={busy} onClick={() => { void submitProposal(); }}>提交提案，等待审批</button>
      </section>

      <section data-memory-section="job" className={tab === 'job' ? '' : 'hidden'}>
        <p className="muted">查看当前会话已确认的条件、冻结的评分卡与摘要来源。</p>
        {activeJobId ? <MemoryTab jobId={activeJobId} /> : <div className="empty-note">先在左侧选择一个会话。</div>}
      </section>

      <p id="memory-status" className="settings-status" role="status">{proposalStatus}</p>
    </>
  );
}
