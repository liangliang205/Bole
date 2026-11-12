(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const roles = { coordinator: '伯乐 · 主 Agent', profiler: '画像师', parser: '录事 · 解析', assessor: '相马官 · 评估', auditor: '监军 · 核查', specialist: '专职检查' };
  let skills = [];
  let editing = null;
  let busy = false;
  const status = (text) => { $('skill-status').textContent = text; };
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Skill 操作失败');
    return data;
  }
  function render() {
    $('skill-count').textContent = `${skills.filter((s) => s.enabled).length}/${skills.length} 启用`;
    $('skill-list').innerHTML = skills.map((s) => `<article class="plugin-row ${s.enabled ? '' : 'disabled'}"><label class="switch"><input type="checkbox" data-skill-toggle="${esc(s.id)}" ${s.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="启停 ${esc(s.name)}"><span></span></label><div class="plugin-row-main"><div class="plugin-row-title"><strong>${esc(s.name)}</strong><span class="tag">Skill</span><span class="tag">${esc(s.id)} · 修订 ${s.revision}</span></div><p>${esc(s.description)}</p><div class="plugin-row-meta">适用：${s.roles.map((r) => esc(roles[r] || r)).join('、')} · 新任务生效</div></div><div class="plugin-row-actions"><button class="btn ghost" data-skill-edit="${esc(s.id)}">查看 / 编辑</button><button class="btn ghost danger-text" data-skill-delete="${esc(s.id)}">删除</button></div></article>`).join('');
    window.dispatchEvent(new CustomEvent('bole-skills-updated', { detail: skills }));
  }
  async function load() { try { skills = (await api('/api/skills')).skills; render(); } catch (error) { status(error.message); } }
  function open(s = null) {
    editing = s;
    $('skill-editor').classList.remove('hidden');
    $('skill-editor-title').textContent = s ? `编辑 Skill：${s.name}` : '添加 Skill';
    for (const [id, value] of Object.entries({ 'skill-id': s?.id || '', 'skill-name': s?.name || '', 'skill-desc': s?.description || '', 'skill-content': s?.content || '', 'skill-path': s?.sourcePath || '', 'skill-file': '' })) $(id).value = value;
    $('skill-id').disabled = !!s;
    $('skill-enabled').checked = s?.enabled ?? true;
    $('skill-roles').innerHTML = Object.entries(roles).map(([id, name]) => `<label><input type="checkbox" value="${id}" ${(s?.roles || ['coordinator']).includes(id) ? 'checked' : ''}>${name}</label>`).join('');
    status('保存后用于新任务；已有任务继续使用创建时的技能快照。');
  }
  async function importSkill(body) {
    const { skill } = await api('/api/skills/preview', 'POST', body);
    if (!editing) { $('skill-id').value = skill.id || ''; $('skill-name').value = skill.name || ''; }
    $('skill-desc').value = skill.description || '';
    $('skill-content').value = skill.content;
    $('skill-path').value = skill.sourcePath || '';
    status('已读取技能内容，请核对名称、适用角色并保存。配套脚本与资源未自动导入。');
  }
  async function mutate(action) {
    if (busy) return;
    busy = true; $('skill-save').disabled = true; render();
    try { await action(); await load(); }
    catch (error) { status(error.message); }
    finally { busy = false; $('skill-save').disabled = false; render(); }
  }
  $('skill-add').addEventListener('click', () => open());
  window.addEventListener('bole-plugin-manual', (event) => { if (event.detail === 'skill') open(); });
  window.addEventListener('bole-plugins-refresh', () => { void load(); });
  $('plugin-refresh').addEventListener('click', load);
  window.addEventListener('bole-plugin-add', () => $('plugin-install-dialog').showModal());
  $('plugin-install-close').addEventListener('click', () => $('plugin-install-dialog').close());
  for (const [id, kind] of [['plugin-manual-mcp', 'mcp'], ['plugin-manual-skill', 'skill']]) $(id).addEventListener('click', () => { $('plugin-install-dialog').close(); window.dispatchEvent(new CustomEvent('bole-plugin-manual', { detail: kind })); });
  let installing = false;
  $('plugin-install-run').addEventListener('click', async () => {
    if (installing) return;
    const command = $('plugin-install-command').value.trim();
    if (!command) { $('plugin-install-status').textContent = '请先粘贴安装命令'; return; }
    installing = true;
    for (const id of ['plugin-install-run', 'plugin-install-command', 'plugin-manual-mcp', 'plugin-manual-skill']) $(id).disabled = true;
    $('plugin-install-status').textContent = 'Agent 正在识别插件、处理安装与连接，请稍候…';
    try {
      const result = await api('/api/plugins/install', 'POST', { command });
      $('plugin-install-status').textContent = `${result.message}\n${result.explanation || ''}`;
      window.dispatchEvent(new CustomEvent('bole-plugins-refresh'));
    } catch (error) { $('plugin-install-status').textContent = `安装未完成：${error.message}`; }
    finally { installing = false; for (const id of ['plugin-install-run', 'plugin-install-command', 'plugin-manual-mcp', 'plugin-manual-skill']) $(id).disabled = false; }
  });
  $('skill-refresh').addEventListener('click', load);
  $('skill-cancel').addEventListener('click', () => { $('skill-editor').classList.add('hidden'); editing = null; });
  $('skill-file').addEventListener('change', async () => {
    try { const file = $('skill-file').files[0]; if (!file) return; if (file.size > 65536) throw new Error('Skill 文件不能超过 64KB'); await importSkill({ content: await file.text() }); }
    catch (error) { status(error.message); }
  });
  $('skill-import-path').addEventListener('click', async () => {
    try { if (!$('skill-path').value.trim()) throw new Error('请填写本机技能路径'); await importSkill({ path: $('skill-path').value.trim() }); }
    catch (error) { status(error.message); }
  });
  $('skill-save').addEventListener('click', () => mutate(async () => {
    const body = { id: $('skill-id').value.trim(), name: $('skill-name').value.trim(), description: $('skill-desc').value.trim(), content: $('skill-content').value, enabled: $('skill-enabled').checked, roles: [...$('skill-roles').querySelectorAll('input:checked')].map((i) => i.value), ...($('skill-path').value.trim() ? { sourcePath: $('skill-path').value.trim() } : {}) };
    await api(editing ? `/api/skills/${encodeURIComponent(editing.id)}` : '/api/skills', editing ? 'PATCH' : 'POST', { ...body, ...(editing ? { revision: editing.revision } : {}) });
    $('skill-editor').classList.add('hidden'); editing = null; status('Skill 已保存，将在新任务中生效。');
  }));
  $('skill-list').addEventListener('click', (event) => {
    if (busy) return;
    const edit = event.target.closest('[data-skill-edit]');
    if (edit) { open(skills.find((s) => s.id === edit.dataset.skillEdit)); return; }
    const del = event.target.closest('[data-skill-delete]');
    if (del && window.confirm('删除此 Skill？已有任务的技能快照会保留。')) void mutate(async () => { await api(`/api/skills/${encodeURIComponent(del.dataset.skillDelete)}`, 'DELETE'); status('Skill 已删除。'); });
  });
  $('skill-list').addEventListener('change', (event) => {
    const input = event.target.closest('[data-skill-toggle]');
    const s = skills.find((item) => item.id === input?.dataset.skillToggle);
    if (s) void mutate(async () => { await api(`/api/skills/${encodeURIComponent(s.id)}`, 'PATCH', { enabled: input.checked, revision: s.revision }); status(input.checked ? 'Skill 已启用，新任务生效。' : 'Skill 已停用，已有任务快照保留。'); });
  });
  window.addEventListener('bole-settings-tab', (event) => { if (event.detail === 'plugins') void load(); });
  if (!$('settings-plugins').classList.contains('hidden')) void load();
})();
