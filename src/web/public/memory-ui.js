(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#memory-dialog');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let data = { families: [], versions: [], proposals: [] };
  let jobs = [];
  let sourceJobId;
  let baseline = null;
  let busy = false;
  const status = (text) => { $('#memory-status').textContent = text; };
  async function api(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '请求失败');
    return result;
  }
  async function action(operation) {
    if (busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    try { status('处理中…'); await operation(); }
    catch (error) { status(error.message); }
    finally { busy = false; dialog.removeAttribute('aria-busy'); }
  }
  function tab(name) {
    dialog.querySelectorAll('[data-memory-section]').forEach((el) => el.classList.toggle('hidden', el.dataset.memorySection !== name));
    dialog.querySelectorAll('[data-memory-tab]').forEach((el) => { el.classList.toggle('active', el.dataset.memoryTab === name); el.setAttribute('aria-pressed', String(el.dataset.memoryTab === name)); });
  }
  const familyId = () => $('#memory-family').value;
  function differences(proposal) {
    const next = JSON.parse(proposal.profile_json);
    const old = data.versions.find((v) => v.id === proposal.base_version_id);
    const before = old ? JSON.parse(old.profile_json).scorecard.dimensions : [];
    const keys = new Set([...before, ...next.scorecard.dimensions].map((d) => d.key));
    return [...keys].map((key) => {
      const a = before.find((d) => d.key === key);
      const b = next.scorecard.dimensions.find((d) => d.key === key);
      return `<li>${esc(b?.name || a?.name)}：${a ? esc(a.weight) + '%' : '新增'} → ${b ? esc(b.weight) + '%' : '移除'}</li>`;
    }).join('');
  }
  function render() {
    const family = familyId();
    const versions = data.versions.filter((v) => v.family_id === family);
    $('#memory-versions').innerHTML = versions.map((v) => `<article class="memory-item"><h3>v${v.version} · ${esc(JSON.parse(v.profile_json).jd.title)}</h3><p>${esc({ approved: '已批准', retired: '已退役', needs_review: '来源已删除，待复核' }[v.status])} · 批准人 ${esc(v.approved_by)} · ${esc(v.created_at)}</p><details><summary>查看标准</summary><pre class="approval-preview">${esc(JSON.stringify(JSON.parse(v.profile_json), null, 2))}</pre></details>${v.status === 'approved' ? `<button class="btn ghost" data-retire="${esc(v.id)}" type="button">停止供新任务使用</button>` : ''}</article>`).join('') || '<p class="muted">尚无版本。可从已有会话创建提案，批准后发布第一个版本。</p>';
    $('#memory-proposals').innerHTML = data.proposals.filter((p) => p.family_id === family).map((p) => `<article class="memory-item"><h3>${esc(p.rule)}</h3><p>${esc({ pending: '待审批', approved: '已发布', rejected: '已拒绝', withdrawn: '已撤回' }[p.status])} · 基线 ${esc(data.versions.find((v) => v.id === p.base_version_id)?.version ?? '无')}</p><p>为什么：${esc(p.why)}</p><p>如何应用：${esc(p.how_to_apply)}</p><p>有效期：${esc(p.valid_from)} 至 ${esc(p.valid_to || '长期')}。仅用于之后新建并显式选择此版本的任务。</p><ul>${differences(p)}</ul><details><summary>查看完整拟发布内容</summary><pre class="approval-preview">${esc(JSON.stringify(JSON.parse(p.profile_json), null, 2))}</pre></details>${p.status === 'pending' ? ['approve', 'reject', 'withdraw'].map((decision) => `<button type="button" class="btn ghost" data-proposal="${esc(p.id)}" data-decision="${decision}">${{ approve: '批准并发布新版本', reject: '拒绝', withdraw: '撤回' }[decision]}</button>`).join('') : ''}</article>`).join('') || '<p class="muted">暂无提案。</p>';
    const oldSource = $('#memory-source').value;
    $('#memory-source').innerHTML = '<option value="">选择来源会话或版本</option>' + versions.map((v) => `<option value="version:${esc(v.id)}">版本 v${v.version} · ${esc(JSON.parse(v.profile_json).jd.title)}</option>`).join('') + jobs.map((j) => `<option value="job:${esc(j.id)}">会话 · ${esc(j.title)}</option>`).join('');
    if ([...$('#memory-source').options].some((o) => o.value === oldSource)) $('#memory-source').value = oldSource;
    const selectedVersion = $('#new-policy-version').value;
    const now = new Date().toISOString();
    $('#new-policy-version').innerHTML = '<option value="">按本次需求生成</option>' + data.families.map((f) => `<optgroup label="${esc(f.name)}">${data.versions.filter((v) => v.family_id === f.id && v.status === 'approved' && v.valid_from <= now && (!v.valid_to || v.valid_to > now)).slice(0, 5).map((v) => `<option value="${esc(v.id)}">${esc(f.name)} · v${v.version}</option>`).join('')}</optgroup>`).join('');
    if ([...$('#new-policy-version').options].some((o) => o.value === selectedVersion)) $('#new-policy-version').value = selectedVersion;
  }
  async function load() {
    const previous = familyId();
    data = await api('/api/memory');
    jobs = (await api('/api/jobs')).jobs;
    $('#memory-family').innerHTML = data.families.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    if (data.families.some((f) => f.id === previous)) $('#memory-family').value = previous;
    render();
  }
  function setProfile(profile) {
    $('#memory-profile').value = JSON.stringify(profile, null, 2);
    $('#memory-dimensions').innerHTML = profile.scorecard.dimensions.map((d, i) => `<label class="memory-weight">${esc(d.name)}<input type="number" class="input" min="1" max="100" value="${d.weight}" data-weight="${i}">%</label>`).join('');
  }
  async function showJob() {
    const id = $('#chat-view').dataset.jobId;
    $('#memory-job-view').textContent = id ? JSON.stringify(await api(`/api/memory/jobs/${encodeURIComponent(id)}`), null, 2) : '先打开一个会话。';
    tab('job');
  }
  window.addEventListener('bole-settings-tab', (event) => { if (event.detail === 'memory') action(async () => { await load(); status(''); }); });
  dialog.querySelectorAll('[data-memory-tab]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.memoryTab === 'job') action(showJob); else tab(button.dataset.memoryTab);
  }));
  $('#memory-family').addEventListener('change', () => { baseline = null; sourceJobId = undefined; $('#memory-profile').value = ''; $('#memory-dimensions').innerHTML = ''; render(); });
  $('#memory-family-create').addEventListener('click', () => action(async () => {
    const result = await api('/api/memory/families', { name: $('#memory-family-name').value });
    baseline = null; sourceJobId = undefined;
    $('#memory-profile').value = ''; $('#memory-dimensions').innerHTML = '';
    $('#memory-family-name').value = ''; await load(); $('#memory-family').value = result.family.id; render(); status('岗位族已创建');
  }));
  $('#memory-load-source').addEventListener('click', () => action(async () => {
    if (!familyId()) throw new Error('请先创建或选择岗位族');
    const source = $('#memory-source').value;
    let profile;
    if (source.startsWith('version:')) {
      const version = data.versions.find((v) => v.id === source.slice(8));
      baseline = version.id; sourceJobId = undefined; profile = JSON.parse(version.profile_json);
    } else if (source.startsWith('job:')) {
      sourceJobId = source.slice(4);
      profile = (await api(`/api/memory/jobs/${encodeURIComponent(sourceJobId)}`)).profile;
      baseline = data.versions.find((v) => v.family_id === familyId())?.id ?? null;
    }
    if (!profile) throw new Error('请选择已完成岗位画像的会话或版本');
    setProfile(profile); $('#memory-baseline').textContent = `基于 ${baseline ? 'v' + data.versions.find((v) => v.id === baseline).version : '新岗位族首个版本'} 起草，不改变来源任务。`; status('参考已载入，可修改权重或完整内容');
  }));
  $('#memory-dimensions').addEventListener('change', (event) => {
    if (!event.target.matches('[data-weight]')) return;
    try { const profile = JSON.parse($('#memory-profile').value); profile.scorecard.dimensions[Number(event.target.dataset.weight)].weight = Number(event.target.value); $('#memory-profile').value = JSON.stringify(profile, null, 2); }
    catch { status('完整岗位内容格式错误，请先修正'); }
  });
  $('#memory-submit').addEventListener('click', () => action(async () => {
    await api('/api/memory/proposals', { familyId: familyId(), sourceJobId, baseVersionId: baseline,
      profile: JSON.parse($('#memory-profile').value), rule: $('#memory-rule').value, why: $('#memory-why').value,
      howToApply: $('#memory-how').value,
      validFrom: $('#memory-valid-from').value ? new Date($('#memory-valid-from').value).toISOString() : undefined,
      validTo: $('#memory-valid-to').value ? new Date($('#memory-valid-to').value).toISOString() : undefined });
    await load(); tab('proposals'); status('提案已提交，尚未生效，请审阅后批准');
  }));
  $('#memory-proposals').addEventListener('click', (event) => {
    const button = event.target.closest('[data-proposal]');
    if (!button) return;
    const proposal = data.proposals.find((p) => p.id === button.dataset.proposal);
    if (button.dataset.decision === 'approve' && !window.confirm(`批准「${proposal.rule}」并发布新版本？仅影响之后选择该版本的新任务。`)) return;
    action(async () => { await api(`/api/memory/proposals/${encodeURIComponent(proposal.id)}/decision`, { decision: button.dataset.decision, contentHash: proposal.content_hash }); await load(); status('决定已保存'); });
  });
  $('#memory-versions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-retire]');
    if (!button || !window.confirm('停止将此版本用于新任务？已有任务保持原快照。')) return;
    action(async () => { await api(`/api/memory/versions/${encodeURIComponent(button.dataset.retire)}/retire`, {}); await load(); status('版本已退役'); });
  });
  load().catch((error) => status(`记忆服务不可用：${error.message}。如刚升级，请重启服务。`));
})();
