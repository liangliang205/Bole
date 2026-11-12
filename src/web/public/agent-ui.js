(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const defaultTeamKey = 'bole.screening.defaultTeam';
  $('#new-agent-team').addEventListener('change', () => {
    try { localStorage.setItem(defaultTeamKey, $('#new-agent-team').value); status('默认团队已保存，将用于新建筛选。'); }
    catch { status('当前选择已应用，浏览器未能保存；刷新后需重新选择。'); }
  });
  const dialog = $('#agent-dialog');
  const environmentTab = document.createElement('button');
  environmentTab.type = 'button'; environmentTab.dataset.agentTab = 'environment'; environmentTab.textContent = '运行检查';
  dialog.querySelector('nav').append(environmentTab);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let catalog;
  let data = { versions: [], drafts: [], active: [], discovery: [] };
  let teams = [];
  let draft;
  let busy = false;
  const labels = { 'structured-llm.v1': ['专职检查（推荐入门）', '在解析后增加一项专项检查，例如职业资格或行业经历。只引用原文，不直接淘汰候选人。'],
    'builtin.coordinator.v1': ['主 Agent · 协调与对话', '调整计划和完成后对话。建议从已有主 Agent 复制，以保留内置技能。'],
    'builtin.profiler.v1': ['岗位画像', '整理招聘需求、评分卡和澄清问题。'], 'builtin.ingest.v1': ['材料接入', '确定性接入器；读取文件、去重和归一化，提示词不改变其代码逻辑。'],
    'builtin.parser.v1': ['简历解析', '提取字段并保留原文证据。'], 'builtin.assessor.v1': ['匹配评估', '按冻结的评分卡评估，保留代码计分与核查重评。'],
    'builtin.auditor.v1': ['证据核查', '复核引用与结论，保留机制层否决。'], 'tool-agent.v1': ['工具助手', '用于对话和授权工具操作；工具权限需要在高级配置中明确开启。'] };
  const roleNames = { coordinator: '伯乐', profiler: '画像师', parser: '录事', assessor: '相马官', auditor: '监军' };
  function describeTemplate() { $('#agent-template-description').textContent = labels[$('#agent-template').value]?.[1] || ''; }
  const status = (text) => { $('#agent-status').textContent = text; };
  async function api(path, body, method = 'POST') {
    const response = await fetch(path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '请求失败');
    return result;
  }
  async function action(fn) {
    if (busy) return;
    busy = true; dialog.setAttribute('aria-busy', 'true');
    try { status('处理中…'); await fn(); } catch (error) { status(error.message); }
    finally { busy = false; dialog.removeAttribute('aria-busy'); }
  }
  function tab(name) {
    dialog.querySelectorAll('[data-agent-section]').forEach((el) => el.classList.toggle('hidden', el.dataset.agentSection !== name));
    dialog.querySelectorAll('[data-agent-tab]').forEach((el) => { el.classList.toggle('active', el.dataset.agentTab === name); el.setAttribute('aria-pressed', String(el.dataset.agentTab === name)); });
  }
  const parsed = (v) => JSON.parse(v.definition_json);
  function edit(definition, row) {
    draft = row;
    $('#agent-template').value = definition.templateId;
    $('#agent-id').value = definition.id; $('#agent-version').value = definition.version;
    $('#agent-name').value = definition.name; $('#agent-prompt').value = definition.prompt;
    $('#agent-description').value = definition.description || '';
    $('#agent-tier').value = definition.tier || 'flash';
    $('#agent-knowledge-roles').innerHTML = Object.entries(roleNames).map(([id, name]) => `<label><input type="checkbox" value="${id}" ${(definition.knowledge?.accessRoles || []).includes(id) ? 'checked' : ''}>${esc(name)}</label>`).join('');
    const coordinator = catalog.templates[definition.templateId]?.slot === 'coordinator';
    $('#agent-tool-options').classList.toggle('hidden', !coordinator);
    $('#agent-tool-checkboxes').innerHTML = Object.entries({ export_word: '生成 Word 报告', office_export_pdf: '转换 PDF', load_workspace_dependencies: '准备文件工具依赖', python_exec: '执行本地 Python' }).map(([id, name]) => `<label><input type="checkbox" value="${id}" ${(definition.tools || []).includes(id) ? 'checked' : ''}>${name}</label>`).join('');
    $('#agent-chat-memory').checked = (definition.memory?.read || []).includes('job-chat');
    $('#agent-definition').value = JSON.stringify(definition, null, 2);
    describeTemplate(); tab('editor'); status(row ? `已载入草稿，第 ${row.revision} 次保存` : '已自动填写标识与版本，填写名称和工作指令即可');
  }
  function definition() {
    if (!$('#agent-definition').value) throw new Error('请在“创建与编辑”中选择职责并点击“按此职责新建”');
    if (!$('#agent-name').value.trim()) throw new Error('请填写角色名称');
    if (!$('#agent-prompt').value.trim()) throw new Error('请填写工作指令');
    const base = JSON.parse($('#agent-definition').value);
    const coordinator = catalog.templates[base.templateId]?.slot === 'coordinator';
    const reads = (base.memory?.read || []).filter((read) => read !== 'job-chat');
    if (coordinator && $('#agent-chat-memory').checked) reads.push('job-chat');
    return { ...base, id: $('#agent-id').value.trim(), version: $('#agent-version').value.trim(),
      name: $('#agent-name').value.trim(), description: $('#agent-description').value.trim(), prompt: $('#agent-prompt').value,
      tier: $('#agent-tier').value,
      tools: coordinator ? [...$('#agent-tool-checkboxes').querySelectorAll('input:checked')].map((el) => el.value) : [],
      memory: { ...(base.memory || { write: [], scope: 'candidate' }), read: reads, ...(reads.includes('job-chat') ? { scope: 'job' } : {}) },
      knowledge: { ...(base.knowledge || { maxContextChars: 4000 }), accessRoles: [...$('#agent-knowledge-roles').querySelectorAll('input:checked')].map((el) => el.value) } };
  }
  function newDefinition() {
    const templateId = $('#agent-template').value;
    const template = catalog.templates[templateId];
    return { id: `agent-${crypto.randomUUID().slice(0, 8)}`, version: '1.0.0', name: '', description: '', roleTags: [], templateId,
      inputContract: template.input, outputContract: template.output, capabilities: [template.capability],
      prompt: templateId === 'structured-llm.v1' ? '检查简历中与岗位相关的专项经历。每项发现必须引用原文；没有依据时返回空 findings，不编造资格或经历。' : '根据输入完成任务，遵守输出契约，不编造原文证据。', tier: 'flash', tools: [], mcp: [], skills: [],
      knowledge: { accessRoles: [], maxContextChars: 4000 }, memory: { read: [], write: [], scope: 'candidate' },
      limits: { maxConcurrency: 4, timeoutMs: 180000, maxToolSteps: 5 } };
  }
  async function save() {
    const result = await api(draft ? `/api/agent-drafts/${encodeURIComponent(draft.id)}` : '/api/agent-drafts',
      { definition: definition(), revision: draft?.revision }, draft ? 'PATCH' : 'POST');
    draft = result.draft;
    await api(`/api/agent-drafts/${encodeURIComponent(draft.id)}/validate`, {});
    return draft;
  }
  function render() {
    $('#agent-discovery').innerHTML = data.discovery.map((v) => `<p>${esc(v.definition.name)} · ${esc(v.version_key)} · ${v.eligible ? '匹配' : '不匹配'} · 负载 ${v.activeCalls}/${v.definition.limits.maxConcurrency} · ${esc(v.reasons.join('，'))}</p>`).join('') || '<p class="muted">没有已激活角色。注册后需激活才能参与发现。</p>';
    $('#agent-version-list').innerHTML = data.versions.map((v) => {
      const d = parsed(v);
      const active = data.active.find((a) => a.agent_id === v.agent_id);
      const isActive = active?.version_key === v.version_key;
      const card = `<article class="memory-item agent-role-card">
        <div class="agent-card-heading"><div><h3>${esc(d.name)}</h3><small class="muted">${esc(v.version_key)} · ${esc(labels[d.templateId]?.[0] || d.templateId)}</small></div><span class="tag ${v.status === 'registered' && isActive ? 'ok' : ''}">${esc(v.status !== 'registered' ? '已退役' : isActive ? '已启用' : '未启用')}</span></div>
        <p class="agent-card-description muted">${esc(d.description.slice(0, 140) || labels[d.templateId]?.[1] || '')}</p>
        <div class="agent-card-footer"><div class="agent-card-details">
          <details><summary>定义与权限快照</summary><pre class="approval-preview">${esc(JSON.stringify(d, null, 2))}</pre></details>
          ${v.status === 'registered' ? `<details class="agent-maintenance"><summary>版本维护</summary><button class="btn ghost" type="button" data-activate="${esc(v.version_key)}">${isActive ? '停用默认选择' : '启用此版本'}</button><button class="btn ghost" type="button" data-state="retire" data-key="${esc(v.version_key)}">退役</button></details>` : ''}
        </div><div class="agent-card-actions">
          <button type="button" class="btn ghost" data-clone="${esc(v.version_key)}">复制为新版本</button>
          ${v.status === 'registered' ? `<button class="btn ${catalog.templates[d.templateId].slot === 'specialist' ? 'primary' : 'ghost'}" type="button" title="预填团队角色，保存团队后用于新会话" data-add-team="${esc(v.version_key)}">配置到团队</button>` : ''}
        </div></div></article>`;
      const preferred = active?.version_key || data.versions.filter((r) => r.agent_id === v.agent_id).at(-1)?.version_key;
      return preferred === v.version_key ? card : `<details class="agent-history"><summary>${esc(d.name)} · 历史版本 ${esc(v.version)}</summary>${card}</details>`;
    }).join('');
    $('#agent-draft-list').innerHTML = '<option value="">选择草稿</option>' + data.drafts.map((r) => `<option value="${esc(r.id)}">${esc(parsed(r).name)} · ${esc(parsed(r).version)} · r${r.revision}</option>`).join('');
    let selected = $('#new-agent-team').value;
    try { selected = localStorage.getItem(defaultTeamKey) || selected; } catch { /* Use current selection. */ }
    $('#new-agent-team').innerHTML = teams.map((t) => `<option value="${esc(t.team_key)}">${t.team_key === 'builtin@1.0.0' ? '内置团队' : esc(t.team_key)}</option>`).join('');
    if (teams.some((t) => t.team_key === selected)) $('#new-agent-team').value = selected;
    else { try { localStorage.removeItem(defaultTeamKey); } catch { /* Storage may be unavailable. */ } }
    $('#agent-team-list').innerHTML = teams.map((t) => `<details class="memory-item"><summary>${esc(t.team_key)}</summary><pre class="approval-preview">${esc(JSON.stringify(parsed(t), null, 2))}</pre></details>`).join('');
    const previous = Object.fromEntries([...$('#agent-team-slots').querySelectorAll('select')].map((el) => [el.dataset.slot, el.value]));
    const slotField = (slot) => `<label class="memory-weight">${esc({ coordinator: '主 Agent', profiler: '画像', fetcher: '接入', parser: '解析', assessor: '评估', auditor: '核查', specialist: '增加专职检查（可选）' }[slot])}<select class="input" data-slot="${slot}">${slot === 'specialist' ? '<option value="">不增加额外检查</option>' : `<option value="active:${slot}">沿用内置角色的当前启用版本</option>`}${data.versions.filter((v) => v.status === 'registered' && catalog.templates[parsed(v).templateId].slot === slot).map((v) => `<option value="${esc(v.version_key)}">${esc(parsed(v).name)} · v${esc(v.version)}</option>`).join('')}</select></label>`;
    $('#agent-team-specialist').innerHTML = slotField('specialist');
    $('#agent-base-role-fields').innerHTML = ['coordinator', 'profiler', 'fetcher', 'parser', 'assessor', 'auditor'].map(slotField).join('');
    if (!$('#agent-team-id').value) $('#agent-team-id').value = `team-${crypto.randomUUID().slice(0, 8)}`;
    $('#agent-team-slots').querySelectorAll('select').forEach((el) => { if ([...el.options].some((o) => o.value === previous[el.dataset.slot])) el.value = previous[el.dataset.slot]; });
    window.dispatchEvent(new CustomEvent('bole-agent-names', { detail: Object.fromEntries(data.versions.map((v) => [v.agent_id, parsed(v).name])) }));
  }
  async function load() {
    catalog ??= await api('/api/agent-catalog');
    const previousTemplate = $('#agent-template').value || 'structured-llm.v1';
    $('#agent-template').innerHTML = Object.keys(labels).filter((key) => catalog.templates[key]).map((key) => `<option value="${esc(key)}">${esc(labels[key][0])}</option>`).join('');
    $('#agent-template').value = previousTemplate; describeTemplate();
    data = await api('/api/agents?capabilitiesAll=' + encodeURIComponent($('#agent-capability-filter').value.trim()));
    teams = (await api('/api/agent-teams')).teams;
    render();
  }
  async function showManifest() {
    const jobId = $('#chat-view').dataset.jobId;
    $('#agent-manifest').textContent = jobId ? JSON.stringify(await api(`/api/run/${encodeURIComponent(jobId)}/agent-manifest`), null, 2) : '请先选择一个会话。历史无绑定任务将在首次续跑时建立迁移清单，不伪造其原始版本。';
    tab('runs');
  }
  window.addEventListener('bole-settings-tab', (event) => { if (event.detail === 'agents') action(async () => { await load(); status(''); }); });
  dialog.querySelectorAll('[data-agent-tab]').forEach((button) => button.addEventListener('click', () => {
    tab(button.dataset.agentTab);
    if (button.dataset.agentTab === 'runs') action(showManifest);
    if (button.dataset.agentTab === 'editor' && !$('#agent-definition').value && catalog) edit(newDefinition());
  }));
  $('#agent-template').addEventListener('change', () => {
    if (!catalog) return;
    const next = newDefinition();
    if ($('#agent-definition').value) {
      next.id = $('#agent-id').value; next.version = $('#agent-version').value;
      next.name = $('#agent-name').value; next.description = $('#agent-description').value;
      if ($('#agent-prompt').value.trim()) next.prompt = $('#agent-prompt').value;
    }
    edit(next, draft);
    status('职责已切换。名称和工作指令已保留；工具、知识与记忆权限已重置，请按需勾选。');
  });
  $('#agent-apply-json').addEventListener('click', () => { try { edit(JSON.parse($('#agent-definition').value), draft); } catch { status('JSON 格式不正确，请检查后再应用'); } });
  $('#agent-open-guide').addEventListener('click', () => window.dispatchEvent(new CustomEvent('bole-help-open', { detail: 'agent-guide' })));
  $('#agent-new').addEventListener('click', () => { if (catalog) edit(newDefinition()); });
  $('#agent-environment-check').addEventListener('click', () => action(async () => {
    const output = $('#agent-environment-output');
    const button = $('#agent-environment-check'); button.disabled = true;
    output.textContent = '检查中…';
    try {
      const result = await api('/api/doctor');
      const counts = result.checks.reduce((all, check) => { all[check.status] = (all[check.status] || 0) + 1; return all; }, {});
      output.innerHTML = `<p>${counts.ok || 0} 项正常 · ${counts.warn || 0} 项需关注 · ${counts.fail || 0} 项异常</p>` + result.checks.map((check) => `<div class="eval-card"><span class="tag ${check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'danger'}">${esc({ ok: '正常', warn: '需关注', fail: '异常' }[check.status] || check.status)}</span> <b>${esc(check.name)}</b><p class="muted">${esc(check.detail)}</p></div>`).join('');
      status('本地检查完成');
    } catch (error) { output.textContent = `检查失败：${error.message}`; throw error; }
    finally { button.disabled = false; }
  }));
  $('#agent-save-draft').addEventListener('click', () => action(async () => { await save(); await load(); status(`已保存并校验 revision ${draft.revision}`); }));
  $('#agent-register').addEventListener('click', () => action(async () => {
    await save();
    const result = await api(`/api/agent-drafts/${encodeURIComponent(draft.id)}/register`, { revision: draft.revision });
    try {
      const current = await api('/api/agents');
      const active = current.active.find((r) => r.agent_id === result.version.agent_id);
      if (active.version_key !== result.version.version_key) await api(`/api/agents/${encodeURIComponent(result.version.agent_id)}/activate`, { versionKey: result.version.version_key, revision: active.revision });
    } catch (error) { throw new Error(`版本已发布，但启用失败：${error.message}。请在角色卡片的“版本维护”中启用，无需重新发布。`); }
    await load(); tab('roles'); status(`“${definition().name}”已发布并启用。下一步点击该角色的“配置到团队”，然后在新会话中选择团队。`);
  }));
  $('#agent-load-draft').addEventListener('click', () => { const row = data.drafts.find((d) => d.id === $('#agent-draft-list').value); if (row) edit(parsed(row), row); });
  $('#agent-search').addEventListener('click', () => action(async () => { await load(); status('能力发现已刷新'); }));
  $('#agent-version-list').addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.addTeam) {
      const version = data.versions.find((v) => v.version_key === button.dataset.addTeam);
      const slot = catalog.templates[parsed(version).templateId].slot;
      tab('teams');
      const select = $('#agent-team-slots').querySelector(`[data-slot="${slot}"]`);
      select.value = version.version_key;
      if (slot !== 'specialist') $('#agent-base-slots').open = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      status(`已选择“${parsed(version).name}”。点击“保存并用于新会话”完成配置。`);
      select.focus(); return;
    }
    if (button.dataset.clone) { const d = parsed(data.versions.find((v) => v.version_key === button.dataset.clone)); const parts = d.version.split('.').map(Number); do { parts[2]++; d.version = parts.join('.'); } while (data.versions.some((v) => v.version_key === `${d.id}@${d.version}`)); edit(d); return; }
    if (button.dataset.activate) action(async () => {
      const v = data.versions.find((r) => r.version_key === button.dataset.activate);
      const active = data.active.find((r) => r.agent_id === v.agent_id);
      await api(`/api/agents/${encodeURIComponent(v.agent_id)}/activate`, { versionKey: active.version_key === v.version_key ? null : v.version_key, revision: active.revision }); await load(); status('活动指针已更新，仅影响之后绑定');
    });
    if (button.dataset.state === 'retire') {
      if (!window.confirm('退役后不接新任务，旧任务仍可执行。确认继续？')) return;
      action(async () => { const v = data.versions.find((r) => r.version_key === button.dataset.key); await api(`/api/agents/${encodeURIComponent(v.agent_id)}/versions/${encodeURIComponent(v.version)}/retire`, {}); await load(); status('状态已更新'); });
    }
  });
  const teamFromForm = () => ({ id: $('#agent-team-id').value.trim(), version: $('#agent-team-version').value.trim(), slots: Object.fromEntries([...$('#agent-team-slots').querySelectorAll('select')].filter((el) => el.value).map((el) => [el.dataset.slot, el.value.startsWith('active:') ? { activeAgentId: el.value.slice(7) } : { agentId: el.value.split('@')[0], version: el.value.split('@')[1] }])) });
  $('#agent-team-slots').addEventListener('change', (event) => {
    if (event.target.matches('select[data-slot]')) $('#agent-team-json').value = JSON.stringify(teamFromForm(), null, 2);
  });
  $('#agent-team-save').addEventListener('click', () => action(async () => {
    const definition = teamFromForm();
    const existing = teams.find((t) => t.team_key === `${definition.id}@${definition.version}`);
    const unchanged = existing && ['coordinator', 'profiler', 'fetcher', 'parser', 'assessor', 'auditor', 'specialist'].every((slot) => JSON.stringify(parsed(existing).slots[slot]) === JSON.stringify(definition.slots[slot]));
    if (existing && !unchanged) {
      const parts = definition.version.split('.').map(Number);
      if (parts.length !== 3 || parts.some((p) => !Number.isSafeInteger(p))) throw new Error('团队版本格式应为 1.0.0');
      do { parts[2]++; definition.version = parts.join('.'); } while (teams.some((t) => t.team_key === `${definition.id}@${definition.version}`));
      $('#agent-team-version').value = definition.version;
    }
    $('#agent-team-json').value = JSON.stringify(definition, null, 2);
    await api('/api/agent-teams', { definition }); await load();
    $('#new-agent-team').value = `${definition.id}@${definition.version}`;
    $('#new-agent-team').dispatchEvent(new Event('change', { bubbles: true }));
    status('团队已保存，并已选为新会话团队。关闭设置后新建会话即可使用，已有会话不会改变。');
  }));
  $('#agent-team-use-json').addEventListener('click', () => action(async () => { await api('/api/agent-teams', { definition: JSON.parse($('#agent-team-json').value) }); await load(); status('团队版本已注册'); }));
  $('#agent-import-preview').addEventListener('click', () => action(async () => {
    const result = await api('/api/agents/import-preview');
    $('#agent-imports').innerHTML = result.previews.map((p, index) => `<details class="memory-item"><summary>${esc(p.slot)} · ${p.changed ? '存在差异' : '未变化'}</summary><pre class="approval-preview">${esc(JSON.stringify({ before: p.oldDefinition, after: p.definition }, null, 2))}</pre>${p.changed ? `<button class="btn ghost" data-import="${index}" type="button">载入为新版本草稿</button>` : ''}</details>`).join('');
    $('#agent-imports').querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => edit(result.previews[Number(b.dataset.import)].definition))); status('预览不改变已注册版本');
  }));
  load().catch((error) => status(`Agent 服务不可用：${error.message}；如刚更新，请重启服务。`));
})();
