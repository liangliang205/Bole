(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const THEME_KEY = 'bole.theme';
  const PROVIDER_PROTOCOL_LABELS = {
    'openai-chat': 'OpenAI Chat Completions',
    'openai-responses': 'OpenAI Responses',
    'anthropic-messages': 'Anthropic Messages',
  };
  const AGENT_NAMES = {
    coordinator: '伯乐', profiler: '画像师', fetcher: '探马', parser: '录事',
    assessor: '相马官', auditor: '监军', advisor: '谋士',
  };
  const STATUS_LABEL = {
    running: '运行中', pausing: '暂停中', paused: '已暂停',
    completed: '已完成', failed: '失败', idle: '未完成',
  };
  const CONCLUSION_LABELS = {
    strong_yes: '强烈推荐', yes: '推荐', maybe: '待定',
    no: '不推荐', strong_no: '强烈不推荐', pending: '待评估',
  };
  const PHASE_LABELS = { screen: '初筛', deep: '深评', revise: '重评' };
  const RESUME_STATUS_LABEL = {
    queued: '待解析', parsing: '解析中', parsed: '已解析', evaluating: '评估中',
    evaluated: '已评估', verifying: '核查中', verified: '已核查', reported: '已上报',
    quarantine: '转人工', failed: '失败', duplicate: '重复',
  };

  const state = {
    jobId: '', jobs: [], run: null, snapshot: null, report: null, config: null,
    events: [], seen: new Set(), lastSeq: 0, streams: new Map(), hitlId: '',
    showArchived: false, menuJobId: '',
    attachments: [], uploadSeq: 0,
    eventSource: null, fallbackTimer: null, drawerTab: 'candidates', drawerCandidate: null,
    candidates: [], candidatesLoaded: false, cost: null, sending: false,
    providers: [], activeProviderId: null, editingProvider: null, editorModels: [],
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }
  function fmtTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value).slice(11, 19) : date.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function fmtDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtScore(value) {
    return value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(1);
  }
  function safeJson(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
  }
  function jobTitle(job) {
    const title = String(job?.title || '').trim();
    if (title && title !== '待画像岗位') return title;
    const requirements = String(job?.requirements || '').trim();
    return requirements ? requirements.slice(0, 32) : '未命名会话';
  }
  function agentName(actor) {
    const key = String(actor || '').split('#')[0];
    return AGENT_NAMES[key] || key || '系统';
  }
  function toast(message, tone = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${tone}`;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add('hidden'), 3600);
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, persist = true) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    if (persist) {
      try { localStorage.setItem(THEME_KEY, next); } catch { /* 隐私模式 */ }
    }
    const button = $('#theme-toggle');
    if (button) {
      button.textContent = next === 'dark' ? '☀ 日间' : '☾ 暗夜';
      button.title = next === 'dark' ? '切换日间模式' : '切换暗夜模式';
      button.setAttribute('aria-pressed', String(next === 'dark'));
    }
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let data;
    try { data = await response.json(); } catch { data = { ok: false, error: `HTTP ${response.status}` }; }
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  // ---------------------------------------------------------------- sessions

  function renderJobs() {
    const keyword = $('#job-search').value.trim().toLowerCase();
    const source = state.jobs.filter((job) => state.showArchived ? job.archived : !job.archived);
    const jobs = source.filter((job) => !keyword || `${jobTitle(job)} ${job.requirements}`.toLowerCase().includes(keyword));
    $('#job-list').innerHTML = jobs.length ? jobs.map((job) => {
      const status = job.activeStatus || 'idle';
      return `<div class="job-item ${job.id === state.jobId ? 'active' : ''} ${job.archived ? 'archived' : ''}" data-job="${esc(job.id)}" role="button" tabindex="0">
        <div class="job-line"><span class="dot ${esc(status)}"></span><span class="job-name">${esc(jobTitle(job))}</span><span class="job-time">${esc(fmtDateTime(job.createdTs))}</span><button class="job-more" type="button" data-job-menu="${esc(job.id)}" title="会话操作">⋯</button></div>
        <div class="job-meta"><span>${job.verified} 通过</span><span>${job.quarantine} 转人工</span>${job.failed ? `<span>${job.failed} 失败</span>` : ''}${job.pinned ? '<span class="job-flag">置顶</span>' : ''}${job.archived ? '<span class="job-flag">归档</span>' : ''}</div>
      </div>`;
    }).join('') : `<div class="empty-note">${state.showArchived ? '还没有归档会话' : state.jobs.length ? '没有匹配的会话' : '还没有会话，点击上方新建'}</div>`;
    $('#job-count').textContent = jobs.length ? `${jobs.length} 个` : '';
    const archivedToggle = $('#archived-toggle');
    archivedToggle.textContent = state.showArchived ? '返回' : '归档';
    archivedToggle.classList.toggle('active', state.showArchived);
    archivedToggle.title = state.showArchived ? '返回正常会话' : '显示归档会话';
    const recent = state.jobs.filter((job) => !job.archived);
    $('#recent-jobs').innerHTML = recent.length ? recent.slice(0, 8).map((job) => {
      const status = job.activeStatus || 'idle';
      return `<button class="recent-card" data-job="${esc(job.id)}">
        <div class="rc-title">${esc(jobTitle(job))}</div>
        <div class="rc-meta">${esc(STATUS_LABEL[status] || status)} · ${job.total} 份 · ${esc(fmtDateTime(job.createdTs))}</div>
      </button>`;
    }).join('') : '<div class="empty-note">暂无会话</div>';
  }

  async function loadJobs() {
    try {
      const data = await api('/api/jobs');
      state.jobs = data.jobs || [];
      renderJobs();
      return state.jobs;
    } catch (error) {
      toast(`读取会话失败：${error.message}`, 'error');
      return [];
    }
  }

  function closeJobMenu() {
    const menu = $('#session-menu');
    if (menu) menu.classList.add('hidden');
    state.menuJobId = '';
  }

  function openJobMenu(jobId, x, y) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) return;
    state.menuJobId = jobId;
    const menu = $('#session-menu');
    menu.innerHTML = `
      <button type="button" class="session-menu-item" data-session-action="pin"><span>${job.pinned ? '取消置顶' : '置顶会话'}</span><span class="menu-hint">${job.pinned ? '' : '置顶'}</span></button>
      <button type="button" class="session-menu-item" data-session-action="rename"><span>重命名</span><span class="menu-hint">Ctrl+Alt+G</span></button>
      <button type="button" class="session-menu-item" data-session-action="archive"><span>${job.archived ? '取消归档' : '归档会话'}</span><span class="menu-hint">Ctrl+Shift+A</span></button>
      <div class="session-menu-sep"></div>
      <button type="button" class="session-menu-item" data-session-action="copy"><span>复制会话 ID</span><span class="menu-hint">${esc(job.id.slice(0, 8))}…</span></button>
      <button type="button" class="session-menu-item danger" data-session-action="delete"><span>删除会话</span><span class="menu-hint">不可恢复</span></button>`;
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  async function handleJobAction(action) {
    const job = state.jobs.find((item) => item.id === state.menuJobId);
    closeJobMenu();
    if (!job) return;
    try {
      if (action === 'pin') {
        await api(`/api/jobs/${encodeURIComponent(job.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: !job.pinned }),
        });
        await loadJobs();
        toast(job.pinned ? '已取消置顶' : '已置顶会话', 'ok');
        return;
      }
      if (action === 'rename') {
        const title = window.prompt('重命名会话', jobTitle(job));
        if (title === null) return;
        const next = title.trim();
        if (!next) { toast('会话标题不能为空', 'error'); return; }
        await api(`/api/jobs/${encodeURIComponent(job.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: next }),
        });
        await loadJobs();
        if (state.jobId === job.id) await loadRun(false);
        toast('会话已重命名', 'ok');
        return;
      }
      if (action === 'archive') {
        const archived = !job.archived;
        await api(`/api/jobs/${encodeURIComponent(job.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ archived }),
        });
        if (archived && state.jobId === job.id) showNewView();
        await loadJobs();
        toast(archived ? '会话已归档' : '会话已取消归档', 'ok');
        return;
      }
      if (action === 'copy') {
        await navigator.clipboard.writeText(job.id);
        toast('会话 ID 已复制', 'ok');
        return;
      }
      if (action === 'delete') {
        if (!window.confirm(`确定删除会话「${jobTitle(job)}」？该操作不可恢复。`)) return;
        await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
        if (state.jobId === job.id) showNewView();
        await loadJobs();
        toast('会话已删除', 'ok');
      }
    } catch (error) {
      toast(`操作失败：${error.message}`, 'error');
    }
  }

  function showNewView() {
    disconnectStream();
    Object.assign(state, { jobId: '', run: null, snapshot: null, report: null, events: [], lastSeq: 0, hitlId: '', attachments: [] });
    state.seen.clear();
    state.streams.clear();
    renderAttachments();
    history.replaceState(null, '', '#new');
    $('#empty-view').classList.remove('hidden');
    $('#chat-view').classList.add('hidden');
    closeDrawer();
    document.title = '伯乐 BoLe · 对话式招聘筛选';
    setStatus('idle');
    $('#pause-btn').classList.add('hidden');
    $('#resume-btn').classList.remove('hidden');
    renderJobs();
    setTimeout(() => $('#new-requirements')?.focus(), 30);
  }

  function showChatView() {
    $('#empty-view').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
  }

  function setStatus(status) {
    const el = $('#status-pill');
    el.className = `pill ${status}`;
    el.textContent = STATUS_LABEL[status] || status;
  }

  async function selectJob(jobId) {
    if (!jobId) { showNewView(); return; }
    disconnectStream();
    Object.assign(state, {
      jobId, run: null, snapshot: null, report: null, events: [], lastSeq: 0, hitlId: '',
      candidates: [], candidatesLoaded: false, cost: null, drawerCandidate: null,
    });
    state.seen.clear();
    state.streams.clear();
    history.replaceState(null, '', `#job=${encodeURIComponent(jobId)}`);
    showChatView();
    closeDrawer();
    if (window.innerWidth > 1100) openDrawer('candidates', false);
    await loadRun(true);
  }

  // ---------------------------------------------------------------- run / events

  async function loadRun(resetEvents) {
    if (!state.jobId) return;
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}`);
      state.run = data.run;
      state.snapshot = data.snapshot;
      if (data.run.status === 'running') state.report = null;
      if (resetEvents) {
        state.events = [];
        state.seen.clear();
        state.lastSeq = 0;
      }
      await loadEvents();
      if (state.run.status === 'completed' || state.run.status === 'failed') {
        await loadReport();
        if (state.run.status === 'completed') await loadCandidates();
      }
      renderAll();
      if (state.run.status === 'running' || state.run.status === 'pausing') connectStream();
      else disconnectStream();
    } catch (error) {
      toast(`读取会话失败：${error.message}`, 'error');
      setStatus('failed');
    }
  }

  function renderAll() {
    if (!state.run || !state.snapshot) return;
    const job = state.snapshot.job || {};
    const run = state.run;
    document.title = `${jobTitle(job)} · 伯乐 BoLe`;
    setStatus(run.status);
    const active = run.status === 'running' || run.status === 'pausing';
    $('#pause-btn').classList.toggle('hidden', !active);
    $('#pause-btn').disabled = run.status === 'pausing';
    $('#resume-btn').classList.toggle('hidden', active);
    $('#resume-btn').disabled = active;
    $('#reply-send').disabled = !run.pendingHitl || state.sending;
    $('#reply-hint').textContent = run.pendingHitl
      ? '请回答上方 HITL 问题（可直接输入自定义回答）'
      : run.status === 'pausing' ? '正在当前批次结束时暂停…'
      : run.status === 'paused' ? '已暂停；点击顶部「续跑」从检查点继续'
      : run.status === 'running' ? '伯乐正在执行流水线…' : '当前没有待回答的问题';
    renderChat();
    renderHitl(run.pendingHitl);
    if (run.status !== 'running') state.streams.clear();
    renderStreams();
    if (!$('#drawer').classList.contains('hidden')) {
      if (state.drawerTab === 'candidates') renderCandidates();
      if (state.drawerTab === 'compliance') renderCompliance();
      if (state.drawerTab === 'cost') renderCost();
    }
  }

  async function loadEvents() {
    if (!state.jobId) return;
    let guard = 0;
    while (guard < 12) {
      guard += 1;
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/events?sinceSeq=${state.lastSeq}&limit=200`);
      const events = data.events || [];
      if (!events.length) break;
      for (const event of events) {
        if (state.seen.has(event.seq)) continue;
        state.seen.add(event.seq);
        state.events.push(event);
        state.lastSeq = Math.max(state.lastSeq, Number(event.seq));
      }
      if (events.length < 200) break;
    }
    if (state.events.length > 5000) state.events = state.events.slice(-5000);
  }

  function connectStream() {
    if (!state.jobId || state.eventSource) return;
    const source = new EventSource(`/api/run/${encodeURIComponent(state.jobId)}/stream?sinceSeq=${state.lastSeq}`);
    state.eventSource = source;
    source.addEventListener('status', (event) => {
      const info = JSON.parse(event.data);
      if (info) { state.run = info; renderAll(); }
    });
    source.addEventListener('snapshot', (event) => {
      state.snapshot = JSON.parse(event.data);
      renderAll();
    });
    source.addEventListener('log', (event) => {
      const row = JSON.parse(event.data);
      if (!state.seen.has(row.seq)) {
        state.seen.add(row.seq);
        state.events.push(row);
        state.lastSeq = Math.max(state.lastSeq, Number(row.seq));
        renderChat();
      }
    });
    source.addEventListener('token', (event) => {
      const chunk = JSON.parse(event.data);
      const key = `${chunk.taskId || chunk.agent}:${chunk.phase || ''}:${chunk.resumeId || ''}`;
      const current = state.streams.get(key) || { agent: chunk.agent, label: chunk.label, phase: chunk.phase, preview: null, updated: Date.now() };
      if (chunk.preview) current.preview = chunk.preview;
      current.updated = Date.now();
      state.streams.set(key, current);
      renderStreams();
    });
    source.addEventListener('done', async () => {
      disconnectStream();
      await loadRun(false);
    });
    source.onerror = () => {
      disconnectStream();
      startFallbackPoll();
    };
  }

  function disconnectStream() {
    if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  }

  function startFallbackPoll() {
    if (state.fallbackTimer) return;
    state.fallbackTimer = setInterval(async () => {
      if (!state.jobId) return;
      await loadEvents();
      try {
        const data = await api(`/api/run/${encodeURIComponent(state.jobId)}`);
        state.run = data.run;
        state.snapshot = data.snapshot;
        renderAll();
        if (state.run.status !== 'running') {
          clearInterval(state.fallbackTimer);
          state.fallbackTimer = null;
          await loadReport();
          await loadCandidates();
        }
      } catch {
        // 下一轮重试
      }
    }, 1500);
  }

  async function loadReport() {
    if (!state.jobId) return;
    try {
      const response = await fetch(`/api/run/${encodeURIComponent(state.jobId)}/report`);
      if (!response.ok) { state.report = null; return; }
      state.report = await response.json();
      renderChat();
    } catch {
      state.report = null;
    }
  }

  // ---------------------------------------------------------------- chat rendering

  const MILESTONES = new Set(['jd.analyzed', 'fetch.completed', 'hitl.question', 'hitl.answered', 'escalate.human', 'run.failed', 'report.generated', 'report.exported']);

  function eventLine(event) {
    const payload = event.payload || {};
    const label = payload.label ? `${payload.label} ` : '';
    const agent = agentName(event.actor);
    switch (event.type) {
      case 'run.created': return { title: '运行已创建', detail: `provider=${payload.provider}`, agent };
      case 'profiler.started': return { title: '开始结构化岗位需求', detail: '', agent };
      case 'jd.analyzed': return { title: `JD 已结构化：${payload.title}`, detail: `${payload.dimensions} 个评分维度`, agent };
      case 'hitl.question': return { title: '需要你确认', detail: String(payload.question || ''), agent };
      case 'hitl.answered': return { title: '你的回答', detail: String(payload.answer || ''), agent };
      case 'fetch.started': return { title: `开始接入 ${payload.files} 份简历`, detail: '', agent };
      case 'resume.fetched': return { title: `${label}接入成功`, detail: `${payload.filename} · ${payload.format} · ${payload.chars} 字符`, agent };
      case 'resume.ocr': return { title: `${label}Vision OCR 完成`, detail: `${payload.model} · ${payload.chars} 字符`, agent };
      case 'resume.ocr_failed': return { title: `${label}Vision OCR 失败`, detail: `已回退本地：${String(payload.error || '').slice(0, 80)}`, agent };
      case 'resume.duplicate': return { title: `${label}重复投递`, detail: `与 ${payload.duplicateOf} 一致`, agent };
      case 'resume.fetch_failed': return { title: `${label}接入失败`, detail: String(payload.reason || ''), agent };
      case 'fetch.completed': return { title: '简历接入完成', detail: `成功 ${payload.pulled} · 重复 ${payload.duplicates} · 失败 ${payload.failed}`, agent };
      case 'batch.started': return { title: `第 ${payload.batchId} 批进入流水线`, detail: `${payload.size} 份`, agent };
      case 'parse.started': return { title: `${label}开始解析`, detail: String(payload.workerId || ''), agent };
      case 'parse.committed': return { title: `${label}解析完成`, detail: `${payload.fields} 个字段`, agent };
      case 'parse.failed': return { title: `${label}解析失败`, detail: String((payload.errors || [])[0] || ''), agent };
      case 'batch.parsed': return { title: `第 ${payload.batchId} 批解析完成`, detail: `${payload.parsed} 成功 · ${payload.failed} 失败`, agent };
      case 'batch.screened': return { title: `第 ${payload.batchId} 批初筛完成`, detail: `${payload.screened} 人`, agent };
      case 'deep_eval.shortlist': return { title: `第 ${payload.batchId} 批深评短名单`, detail: `${payload.count} 人 · ${payload.tier}`, agent };
      case 'eval.started': return { title: `${label}${payload.phase === 'deep' ? '深评' : payload.phase === 'revise' ? '返工' : '初筛'}开始`, detail: `${payload.tier} · 第 ${payload.loopIndex} 轮`, agent };
      case 'eval.committed': return { title: `${label}评估完成`, detail: `${fmtScore(payload.totalScore)} 分 · ${payload.tier}/${payload.phase}`, agent };
      case 'deep_eval.completed': return { title: `${label}pro 深评完成`, detail: `${fmtScore(payload.totalScore)} 分`, agent };
      case 'deep_eval.failed': return { title: `${label}深评失败`, detail: '回退初筛结果', agent };
      case 'review.started': return { title: `${label}证据核查开始`, detail: `第 ${payload.loopCount} 轮`, agent };
      case 'review.verdict': return { title: `${label}核查裁决 ${payload.verdict}`, detail: `支持 ${payload.supported} · 未通过 ${payload.failed}`, agent };
      case 'selfloop.revise': return { title: `${label}验真环打回重评`, detail: `第 ${payload.loop} 轮 · ${payload.tier}`, agent };
      case 'worker.reused': return { title: `${label}续用原评估 Worker`, detail: String(payload.workerId || ''), agent };
      case 'escalate.human': return { title: `${label}转人工`, detail: String(payload.reason || ''), agent };
      case 'candidate.processed': return { title: `${label}处理完成：${payload.status}`, detail: payload.score ? `${fmtScore(payload.score)} 分` : '', agent };
      case 'batch.completed': return { title: `第 ${payload.batchId} 批完成`, detail: `评估 ${payload.evaluated} · 深评 ${payload.deep}`, agent };
      case 'report.generated': return { title: '报告已生成', detail: '', agent };
      case 'tool.called': return { title: `伯乐调用工具 ${payload.tool}`, detail: String(payload.arguments || ''), agent };
      case 'tool.completed': return { title: `工具 ${payload.tool} 完成`, detail: String(payload.message || ''), agent };
      case 'tool.error': return { title: `工具 ${payload.tool} 失败`, detail: String(payload.message || ''), agent };
      case 'tool.failed': return { title: '工具调用失败', detail: String((payload.errors || [])[0] || ''), agent };
      case 'tool.fallback': return { title: '已按需求默认导出', detail: String(payload.reason || ''), agent };
      case 'report.exported': return { title: '终稿文件已导出', detail: (payload.formats || []).join(' · '), agent };
      case 'run.completed': return { title: '运行完成', detail: `耗时 ${payload.durationMs}ms · 成本 $${Number(payload.usage?.costUsd || 0).toFixed(4)}`, agent };
      case 'run.failed': return { title: '运行失败', detail: String(payload.error || ''), agent };
      default: return { title: event.type, detail: JSON.stringify(payload).slice(0, 160), agent };
    }
  }

  function messageHtml(kind, name, time, body, extra = '') {
    const avatar = kind === 'user' ? '你' : kind === 'assistant' ? '伯' : '⚙';
    return `<div class="msg ${kind}">
      <div class="msg-avatar">${esc(avatar)}</div>
      <div class="msg-body">
        <div class="msg-head"><span class="msg-name">${esc(name)}</span><span class="msg-time">${esc(time)}</span></div>
        ${body}${extra}
      </div>
    </div>`;
  }

  function toolRowsHtml(events) {
    return events.map((event) => {
      const line = eventLine(event);
      return `<div class="tool-row"><span class="tool-agent">${esc(line.agent)}</span><span class="tool-title">${esc(line.title)}${line.detail ? `：${esc(line.detail)}` : ''}</span><span class="tool-time">${esc(fmtTime(event.ts))}</span></div>`;
    }).join('');
  }

  function fileCardsHtml(files) {
    const VISIBLE = 4;
    const cards = files.map((file) => {
      const name = String(file).split(/[\\/]/).pop();
      const isPdf = /\.pdf$/i.test(name);
      const label = isPdf ? 'PDF' : 'DOCX';
      const icon = isPdf ? 'PDF' : 'W';
      const desc = isPdf ? '只读文件，适合分发与归档' : '可编辑文档，适合修改与签字';
      const href = `/api/run/${encodeURIComponent(state.jobId)}/files/${encodeURIComponent(name)}`;
      return `<a class="file-card" href="${href}" download title="点击下载 ${esc(name)}">
        <span class="file-icon ${isPdf ? 'pdf' : 'word'}">${icon}</span>
        <span class="file-meta"><span class="file-name">${esc(name)}</span><span class="file-desc">${esc(desc)}</span></span>
      </a>`;
    });
    const visible = cards.slice(0, VISIBLE).join('');
    const hidden = cards.slice(VISIBLE).join('');
    const more = hidden
      ? `<details><summary class="file-more">全部 ${files.length} 个文件</summary><div class="file-grid" style="margin-top:6px">${hidden}</div></details>`
      : '';
    return `<div class="file-grid">${visible}</div>${more}`;
  }

  function renderChat() {
    if (!state.jobId || !state.snapshot) return;
    const job = state.snapshot.job || {};
    const events = state.events;
    const fileNames = [...new Set(events
      .filter((event) => event.type === 'resume.fetched' || event.type === 'resume.fetch_failed')
      .map((event) => event.payload?.filename)
      .filter(Boolean))];
    const parts = [];
    const attachments = fileNames.length
      ? `<div class="attach-chips">${fileNames.map((name) => `<span class="chip"><span class="name">${esc(name)}</span></span>`).join('')}</div>`
      : '';
    parts.push(messageHtml('user', 'HR', fmtTime(job.created_ts), `<div class="msg-text">${esc(job.requirements || '')}</div>`, attachments));

    let toolGroup = [];
    const flushTools = () => {
      if (!toolGroup.length) return;
      parts.push(messageHtml('tool', '执行轨迹', '', `<details class="msg-tools" ${state.run?.status === 'running' ? 'open' : ''}><summary>工具调用 · ${toolGroup.length} 条</summary>${toolRowsHtml(toolGroup)}</details>`));
      toolGroup = [];
    };

    for (const event of events) {
      if (MILESTONES.has(event.type)) {
        flushTools();
        if (event.type === 'jd.analyzed') {
          const payload = event.payload || {};
          parts.push(messageHtml('assistant', '画像师', fmtTime(event.ts), `<div class="msg-text">岗位已结构化：<strong>${esc(payload.title || '')}</strong>。${payload.dimensions || 0} 个评分维度，已剥离 ${payload.removedProtected || 0} 项受保护条件。</div>`));
        } else if (event.type === 'fetch.completed') {
          parts.push(messageHtml('assistant', '探马', fmtTime(event.ts), `<div class="msg-text">简历接入完成：成功 ${esc(event.payload?.pulled)} 份，重复 ${esc(event.payload?.duplicates)} 份，失败 ${esc(event.payload?.failed)} 份。</div>`));
        } else if (event.type === 'hitl.question') {
          parts.push(messageHtml('assistant', '伯乐', fmtTime(event.ts), `<div class="msg-text">${esc(event.payload?.question || '')}</div>`));
        } else if (event.type === 'hitl.answered') {
          parts.push(messageHtml('user', 'HR', fmtTime(event.ts), `<div class="msg-text">${esc(event.payload?.answer || '')}</div>`));
        } else if (event.type === 'escalate.human') {
          parts.push(messageHtml('assistant', '监军', fmtTime(event.ts), `<div class="msg-text"><strong>${esc(event.payload?.label || '')}</strong> 已转人工：${esc(event.payload?.reason || '')}</div>`));
        } else if (event.type === 'run.failed') {
          parts.push(messageHtml('assistant', '伯乐', fmtTime(event.ts), `<div class="msg-text">运行失败：${esc(event.payload?.error || '')}</div>`));
        } else if (event.type === 'report.exported') {
          const files = event.payload?.files || [];
          const summary = String(event.payload?.summary || '').trim();
          const text = summary || (files.length ? '终稿已生成，已按对话需求导出以下文件。' : '本次没有导出文件。');
          const extra = files.length ? fileCardsHtml(files) : '';
          parts.push(messageHtml('assistant', '伯乐', fmtTime(event.ts), `<div class="msg-text">${esc(text)}</div>`, extra));
        } else {
          toolGroup.push(event);
        }
      } else {
        toolGroup.push(event);
      }
    }
    flushTools();
    if (state.report) parts.push(finalReportHtml());
    else if (state.run?.status === 'completed') parts.push(messageHtml('assistant', '伯乐', '', `<div class="msg-text">运行完成，正在读取报告…</div>`));
    const scroll = $('#chat-scroll');
    scroll.innerHTML = parts.join('');
    scroll.scrollTop = scroll.scrollHeight;
  }

  function candidateReason(candidate) {
    const direct = String(candidate?.reason || '').trim();
    if (direct) return direct;
    const dimensions = Array.isArray(candidate?.dimensions) ? [...candidate.dimensions] : [];
    const derived = dimensions
      .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
      .slice(0, 2)
      .map((dimension) => `${dimension.name || dimension.key || '评估维度'}：${dimension.rationale || ''}`)
      .filter((line) => !line.endsWith('：'))
      .join('；');
    return derived || '暂无理由说明';
  }

  function finalReportHtml() {
    const report = state.report;
    const top = Array.isArray(report.top) ? report.top : [];
    const recommended = top.filter((candidate) => candidate.conclusion === 'yes' || candidate.conclusion === 'strong_yes').length;
    const intro = top.length
      ? `筛选完成。共 ${top.length} 位候选人通过证据核查${recommended ? `，其中 ${recommended} 位达到推荐标准` : '，但暂无达到推荐标准的人选'}。以下是结论与理由，全部结论都能回到简历原文。`
      : '筛选完成。本次没有候选人通过证据核查，以下是合规摘要。';
    const items = top.map((candidate, index) => {
      const phase = PHASE_LABELS[candidate.evalPhase] || '';
      const evalLabel = phase === '重评'
        ? '深度评估 · 重评'
        : (phase === '深评' || candidate.evalTier === 'pro' ? '深度评估' : '初筛评估');
      const conclusionTone = candidate.conclusion === 'strong_yes' || candidate.conclusion === 'yes'
        ? 'ok'
        : candidate.conclusion === 'strong_no' || candidate.conclusion === 'no' ? 'bad' : 'neutral';
      return `<article class="recommendation-item clickable" data-candidate="${esc(candidate.resumeId)}">
        <div class="recommendation-head">
          <span class="recommendation-rank">${index + 1}</span>
          <b class="recommendation-name">${esc(candidate.label)}</b>
          <span class="recommendation-score">${esc(fmtScore(candidate.totalScore))} 分</span>
          <span class="recommendation-conclusion ${conclusionTone}">${esc(CONCLUSION_LABELS[candidate.conclusion] || candidate.conclusion || '待评估')}</span>
        </div>
        <div class="recommendation-meta">${esc(evalLabel)}</div>
        <div class="recommendation-reason-label">理由说明</div>
        <p class="recommendation-reason">${esc(candidateReason(candidate))}</p>
      </article>`;
    }).join('');
    const compliance = report.compliance || {};
    const stats = compliance.reviewStats || {};
    return messageHtml('assistant', '伯乐', '', `<div class="msg-text">${intro}</div>
      <div class="msg-card">
        <h3>候选人结论</h3>
        ${top.length ? `<div class="recommendation-list">${items}</div>` : '<div class="empty-note">没有候选人通过证据核查</div>'}
        <div class="summary-grid" style="margin-top:10px">
          <div><b>${top.length}</b><span>候选人</span></div>
          ${recommended > 0 ? `<div><b>${recommended}</b><span>推荐</span></div>` : ''}
          <div><b>${(report.escalations || []).length}</b><span>转人工</span></div>
          <div><b>${(compliance.duplicates || []).length}</b><span>重复</span></div>
          <div><b>${(compliance.failed || []).length}</b><span>失败</span></div>
          <div><b>${((stats.vetoRate || 0) * 100).toFixed(0)}%</b><span>核查否决率</span></div>
        </div>
        <div class="report-actions">
          <button class="btn ghost" id="open-evidence">查看证据链</button>
          <button class="btn ghost" id="open-cost">查看成本</button>
        </div>
      </div>`);
  }

  // ---------------------------------------------------------------- streaming

  function renderStreams() {
    const host = $('#stream-host');
    if (!host) return;
    const now = Date.now();
    for (const [key, value] of state.streams) {
      if (now - value.updated > 90_000) state.streams.delete(key);
    }
    const streams = [...state.streams.entries()].slice(-3);
    host.innerHTML = streams.map(([, value]) => {
      const preview = value.preview;
      const title = preview?.title || [agentName(value.agent), value.label].filter(Boolean).join(' · ');
      const lines = Array.isArray(preview?.lines) ? preview.lines : [];
      return `<div class="stream-card">
        <div class="stream-head"><span class="stream-agent">${esc(title)}</span><span class="spacer"></span><span class="muted">生成中</span></div>
        <div class="stream-preview">${lines.length ? lines.map((line) => `<div class="stream-line"><span class="sl-label">${esc(line.label)}</span><span class="sl-value ${esc(line.tone || '')}">${esc(line.value)}</span></div>`).join('') : '<div class="stream-line"><span class="sl-label">状态</span><span class="sl-value muted">正在生成…</span></div>'}</div>
      </div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- HITL / composer

  function renderHitl(pending) {
    const host = $('#hitl-host');
    if (!pending) { host.innerHTML = ''; state.hitlId = ''; return; }
    if (state.hitlId === pending.id && host.querySelector('.hitl-card')) return;
    state.hitlId = pending.id;
    host.innerHTML = `<div class="hitl-card">
      <h3>需要你确认 · ${esc(pending.node || 'HITL')}</h3>
      <div class="hitl-question">${esc(pending.question)}</div>
      <div class="hitl-options">${(pending.options || []).map((option, index) => `<button class="hitl-option" data-hitl-index="${index}">${esc(option)}${option === pending.recommendedOption ? '（推荐）' : ''}</button>`).join('')}</div>
    </div>`;
    host.querySelectorAll('[data-hitl-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.getAttribute('data-hitl-index'));
        submitHitl(pending.options[index]);
      });
    });
  }

  async function submitHitl(answer) {
    if (!state.jobId || !answer || state.sending) return;
    state.sending = true;
    try {
      await api(`/api/run/${encodeURIComponent(state.jobId)}/hitl`, {
        method: 'POST',
        body: JSON.stringify({ answer, actor: 'HR(web)' }),
      });
      state.hitlId = '';
      toast('已提交回答', 'ok');
      await loadEvents();
      await loadRun(false);
    } catch (error) {
      toast(`提交失败：${error.message}`, 'error');
    } finally {
      state.sending = false;
      renderAll();
    }
  }

  async function sendReply() {
    if (!state.run?.pendingHitl) { toast('当前没有待回答的问题', 'error'); return; }
    const value = $('#reply-input').value.trim();
    if (!value) { toast('请输入回答', 'error'); return; }
    $('#reply-input').value = '';
    await submitHitl(value);
  }

  // ---------------------------------------------------------------- uploads / new run

  function renderAttachments() {
    const host = $('#new-attachments');
    host.innerHTML = state.attachments.map((file) => `<span class="chip ${file.status === 'error' ? 'error' : file.status === 'uploading' ? 'uploading' : ''}">
      <span class="name">${esc(file.filename)}</span>
      <span class="muted">${file.status === 'uploading' ? '上传中…' : file.status === 'error' ? '失败' : `${(file.size / 1024).toFixed(0)}KB`}</span>
      <button data-remove="${esc(file.id)}" title="移除">✕</button>
    </span>`).join('');
    host.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        state.attachments = state.attachments.filter((file) => file.id !== button.getAttribute('data-remove'));
        renderAttachments();
      });
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(files) {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { toast(`${file.name} 超过 25MB`, 'error'); continue; }
      state.uploadSeq += 1;
      const entry = { id: `local_${state.uploadSeq}`, filename: file.name, size: file.size, status: 'uploading', uploadId: '' };
      state.attachments.push(entry);
      renderAttachments();
      try {
        const contentBase64 = await fileToBase64(file);
        const data = await api('/api/uploads', { method: 'POST', body: JSON.stringify({ filename: file.name, contentBase64 }) });
        entry.uploadId = data.upload.uploadId;
        entry.status = 'uploaded';
      } catch (error) {
        entry.status = 'error';
        toast(`${file.name} 上传失败：${error.message}`, 'error');
      }
      renderAttachments();
    }
  }

  async function startRun() {
    const requirements = $('#new-requirements').value.trim();
    if (requirements.length < 5) { showHint('请填写至少 5 个字符的招聘需求', true); return; }
    const uploaded = state.attachments.filter((file) => file.status === 'uploaded');
    if (uploaded.length === 0) { showHint('请先上传至少一份简历', true); return; }
    if (!state.config?.providers?.length || !state.activeProviderId) {
      showHint('请先在设置中添加模型提供商并绑定 API Key', true);
      openSettings();
      return;
    }
    const activeProvider = state.providers.find((provider) => provider.id === state.activeProviderId);
    if (!activeProvider?.hasKey) {
      showHint('当前模型提供商未绑定 API Key，请先在设置中完成配置', true);
      openSettings();
      return;
    }
    const button = $('#new-start');
    button.disabled = true;
    showHint('正在创建会话并启动真实模型流水线…');
    try {
      const data = await api('/api/run', {
        method: 'POST',
        body: JSON.stringify({ requirements, uploadIds: uploaded.map((file) => file.uploadId) }),
      });
      state.attachments = [];
      renderAttachments();
      showHint('');
      await loadJobs();
      await selectJob(data.jobId);
      toast('已开始筛选', 'ok');
    } catch (error) {
      showHint(`启动失败：${error.message}`, true);
      toast(`启动失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function showHint(message, isError = false) {
    const hint = $('#new-hint');
    hint.textContent = message;
    hint.className = `hint ${isError ? 'error' : ''}`;
  }

  async function pauseCurrent() {
    if (!state.jobId) return;
    const status = state.run?.status;
    if (status !== 'running' && status !== 'pausing') return;
    if (state.run?.pendingHitl) {
      toast('当前正在等待人工回答，请先回答后再暂停', 'error');
      return;
    }
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/pause`, { method: 'POST' });
      if (state.run) state.run.status = data.status;
      renderAll();
      toast('已请求暂停，将在当前批次结束后生效', 'ok');
    } catch (error) {
      toast(`暂停失败：${error.message}`, 'error');
    }
  }

  async function resumeCurrent() {
    if (!state.jobId || state.run?.status === 'running' || state.run?.status === 'pausing') return;
    const activeProvider = state.providers.find((provider) => provider.id === state.activeProviderId);
    if (!activeProvider?.hasKey) { toast('请先配置可用的模型提供商', 'error'); openSettings(); return; }
    try {
      await api(`/api/run/${encodeURIComponent(state.jobId)}/resume`, { method: 'POST' });
      state.events = [];
      state.seen.clear();
      state.lastSeq = 0;
      state.streams.clear();
      toast('已从检查点续跑', 'ok');
      await loadRun(true);
    } catch (error) {
      toast(`续跑失败：${error.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- drawer

  function openDrawer(tab = 'candidates', load = true) {
    state.drawerTab = tab;
    $('#drawer').classList.remove('hidden');
    $$('#drawer-tabs .tab').forEach((button) => button.classList.toggle('active', button.dataset.drawerTab === tab));
    if (tab === 'candidates') { if (load) loadCandidates(); else renderCandidates(); }
    if (tab === 'compliance') { loadCandidates().then(renderCompliance); }
    if (tab === 'cost') loadCost();
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    state.drawerCandidate = null;
  }

  async function loadCandidates() {
    if (!state.jobId) return;
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/candidates`);
      state.candidates = data.candidates || [];
      state.candidatesLoaded = true;
      if (state.drawerTab === 'candidates') renderCandidates();
    } catch (error) {
      toast(`读取候选人失败：${error.message}`, 'error');
    }
  }

  function renderCandidates() {
    if (state.drawerTab !== 'candidates' || state.drawerCandidate) return;
    const body = $('#drawer-body');
    if (!state.candidates.length) { body.innerHTML = '<div class="empty-note">暂无候选人数据</div>'; return; }
    body.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>候选人</th><th>状态</th><th>分数</th><th>档位</th><th>核查</th></tr></thead>
      <tbody>${state.candidates.map((candidate) => `<tr class="clickable" data-candidate="${esc(candidate.resumeId)}">
        <td><b>${esc(candidate.label)}</b><div class="muted">${esc(candidate.format)}</div></td>
        <td><span class="tag ${candidate.status === 'reported' || candidate.status === 'verified' ? 'ok' : candidate.status === 'quarantine' || candidate.status === 'failed' ? 'danger' : candidate.status === 'duplicate' ? 'warn' : ''}">${esc(RESUME_STATUS_LABEL[candidate.status] || candidate.status)}</span></td>
        <td>${esc(fmtScore(candidate.score))}</td>
        <td>${candidate.evalTier ? `<span class="tag ${candidate.evalTier === 'pro' ? 'deep' : ''}">${esc(candidate.evalTier)}/${esc(candidate.evalPhase || '')}</span>` : '—'}</td>
        <td>${candidate.reviewVerdict ? `<span class="tag ${candidate.reviewVerdict === 'pass' ? 'ok' : candidate.reviewVerdict === 're_eval' ? 'warn' : 'danger'}">${esc(candidate.reviewVerdict)}</span>` : '—'}</td>
      </tr>`).join('')}</tbody></table></div>`;
    body.querySelectorAll('tr[data-candidate]').forEach((row) => {
      row.addEventListener('click', () => openCandidate(row.getAttribute('data-candidate')));
    });
  }

  async function openCandidate(resumeId) {
    if (!state.jobId) return;
    state.drawerCandidate = resumeId;
    if ($('#drawer').classList.contains('hidden')) openDrawer('candidates', false);
    const body = $('#drawer-body');
    body.innerHTML = '<div class="empty-note">正在读取证据链…</div>';
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/candidates/${encodeURIComponent(resumeId)}`);
      renderCandidateDetail(data.candidate);
    } catch (error) {
      body.innerHTML = `<div class="empty-note">读取失败：${esc(error.message)}</div>`;
    }
  }

  function renderCandidateDetail(detail) {
    const parts = ['<button class="btn ghost" id="candidate-back">← 返回列表</button>'];
    parts.push(`<h2 style="margin:10px 0 4px">${esc(detail.resume.label)}</h2>`);
    parts.push(`<div class="kv"><dt>状态</dt><dd>${esc(RESUME_STATUS_LABEL[detail.resume.status] || detail.resume.status)}</dd>
      <dt>格式 / 批次</dt><dd>${esc(detail.resume.format)} · 第 ${detail.resume.batchId ?? '—'} 批</dd>
      ${(detail.resume.reasons || []).length ? `<dt>说明</dt><dd>${esc(detail.resume.reasons.join('；'))}</dd>` : ''}</div>`);

    parts.push('<h3>解析字段与证据</h3>');
    if (!detail.parse) parts.push('<div class="empty-note">没有已提交的解析结果</div>');
    else {
      if ((detail.parse.anomalies || []).length) parts.push(`<div class="muted">异常：${esc(detail.parse.anomalies.join('；'))}</div>`);
      parts.push(detail.parse.fields.map((field) => `<div class="eval-card">
        <div class="eval-head"><b>${esc(field.key)}</b><span class="tag">conf ${esc(field.confidence)}</span></div>
        <div>${esc(field.value)}</div>
        ${(field.spans || []).map((span) => `<div class="evidence-quote">「${esc(span.quote)}」<div class="span-meta">${esc(span.charStart)}-${esc(span.charEnd)}</div></div>`).join('')}
      </div>`).join(''));
    }

    parts.push('<h3>评估历史</h3>');
    parts.push(detail.evaluations.length ? detail.evaluations.map((evaluation) => `<div class="eval-card">
      <div class="eval-head"><span class="eval-score">${esc(fmtScore(evaluation.totalScore))}</span>
        <span class="tag ${evaluation.tier === 'pro' ? 'deep' : ''}">${esc(evaluation.tier || '—')}/${esc(evaluation.phase || '—')}</span>
        <span class="tag">${esc(evaluation.conclusion || '')}</span>${evaluation.revisionOf ? '<span class="tag warn">返工</span>' : ''}</div>
      ${evaluation.dimensions.map((dim) => `<div class="muted" style="margin-top:6px"><b>${esc(dim.name || dim.key)}</b> ${esc(dim.score)} 分 · ${esc(dim.rationale)}</div>`).join('')}
      ${(evaluation.uncertainties || []).length ? `<div class="muted">不确定：${esc(evaluation.uncertainties.join('；'))}</div>` : ''}
    </div>`).join('') : '<div class="empty-note">没有评估结果</div>');

    parts.push('<h3>核查记录</h3>');
    parts.push(detail.reviews.length ? detail.reviews.map((review) => `<div class="eval-card">
      <div class="eval-head"><span class="tag ${review.verdict === 'pass' ? 'ok' : review.verdict === 're_eval' ? 'warn' : 'danger'}">${esc(review.verdict || '')}</span><span class="muted">第 ${review.loopCount} 轮</span></div>
      ${review.checks.map((check) => `<div class="muted">${check.verdict === 'supported' ? '✓' : '✗'} ${esc(check.claim)} — ${esc(check.note)}</div>`).join('')}
      ${review.escalationReason ? `<div class="muted">转人工：${esc(review.escalationReason)}</div>` : ''}
    </div>`).join('') : '<div class="empty-note">没有核查记录</div>');

    parts.push('<h3>证据表</h3>');
    parts.push(detail.evidence.length ? `<div class="table-wrap"><table><thead><tr><th>字段</th><th>引用</th><th>区间</th><th>状态</th></tr></thead><tbody>${detail.evidence.map((row) => `<tr><td>${esc(row.field)}</td><td>${esc(row.quote)}</td><td class="span-meta">${esc(row.charStart)}-${esc(row.charEnd)}</td><td><span class="tag ${row.verified ? 'ok' : 'warn'}">${esc(row.verdict)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-note">暂无证据</div>');

    $('#drawer-body').innerHTML = parts.join('');
    $('#candidate-back').addEventListener('click', () => { state.drawerCandidate = null; renderCandidates(); });
  }

  function renderCompliance() {
    if (state.drawerTab !== 'compliance') return;
    const job = state.snapshot?.job || {};
    const fairness = safeJson(job.fairness_json);
    const counts = state.snapshot?.reviewCounts || {};
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    const veto = total ? ((Number(counts.re_eval || 0) + Number(counts.escalate_human || 0)) / total) : 0;
    const duplicates = state.candidates.filter((candidate) => candidate.status === 'duplicate');
    const failed = state.candidates.filter((candidate) => candidate.status === 'failed');
    const decisions = state.snapshot?.decisionList || [];
    $('#drawer-body').innerHTML = `<div class="card-grid">
      <div class="info-card"><h3>公平性（反歧视）</h3>
        ${(fairness.removed || []).length ? `<div class="table-wrap"><table><thead><tr><th>原始条件</th><th>类别</th><th>处理</th></tr></thead><tbody>${fairness.removed.map((item) => `<tr><td>${esc(item.text)}</td><td>${esc(item.category)}</td><td>${esc(item.action)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">需求中未发现受保护属性条件。</p>'}
        ${(fairness.findings || []).length ? `<ul>${fairness.findings.map((finding) => `<li>${esc(finding)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="info-card"><h3>核查统计</h3>
        <div class="stat-line"><span>核查总数</span><b>${total}</b></div>
        <div class="stat-line"><span>pass / re_eval / escalate</span><b>${counts.pass || 0} / ${counts.re_eval || 0} / ${counts.escalate_human || 0}</b></div>
        <div class="stat-line"><span>否决率</span><b>${(veto * 100).toFixed(1)}%</b></div>
        <div class="bar"><i style="width:${Math.min(100, veto * 100)}%"></i></div>
        <p class="muted">验真环重评 ${state.snapshot?.selfLoop?.revisions || 0} 次；转人工 ${state.snapshot?.selfLoop?.escalations || 0} 人。</p>
      </div>
      <div class="info-card"><h3>重复投递</h3>${duplicates.length ? `<ul>${duplicates.map((candidate) => `<li><b>${esc(candidate.label)}</b>：${esc((candidate.reasons || []).slice(-1)[0] || '')}</li>`).join('')}</ul>` : '<p class="muted">无</p>'}</div>
      <div class="info-card"><h3>失败明细</h3>${failed.length ? `<ul>${failed.map((candidate) => `<li><b>${esc(candidate.label)}</b>：${esc((candidate.reasons || []).slice(-1)[0] || '')}</li>`).join('')}</ul>` : '<p class="muted">无</p>'}</div>
      <div class="info-card"><h3>HITL 决策记录</h3>${decisions.length ? `<div class="table-wrap"><table><thead><tr><th>节点</th><th>回答</th><th>操作者</th></tr></thead><tbody>${decisions.map((decision) => `<tr><td>${esc(decision.node)}</td><td>${esc(decision.answer)}</td><td>${esc(decision.actor)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">暂无</p>'}</div>
    </div>`;
  }

  async function loadCost() {
    if (!state.jobId) return;
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/cost`);
      state.cost = data;
      renderCost();
    } catch (error) {
      toast(`读取成本失败：${error.message}`, 'error');
    }
  }

  function renderCost() {
    if (state.drawerTab !== 'cost') return;
    const data = state.cost;
    if (!data) { $('#drawer-body').innerHTML = '<div class="empty-note">读取中…</div>'; return; }
    const totals = data.totals || {};
    const report = data.report || {};
    const cost = report.cost || null;
    const usageRows = (data.usage || []).map((row) => `<tr><td>${esc(row.agent)}</td><td>${esc(row.model)}</td><td>${esc(row.tier)}</td><td>${esc(row.calls)}</td><td>${esc(row.promptTokens)}</td><td>${esc(row.completionTokens)}</td><td>${esc(row.cachedTokens)}</td><td>${Number(row.costUsd || 0).toFixed(6)}</td></tr>`).join('');
    const stageRows = (cost?.byStage || []).map((row) => `<tr><td>${esc(row.stage)}</td><td>${esc(row.calls)}</td><td>${esc(row.promptTokens)}</td><td>${esc(row.completionTokens)}</td><td>${Number(row.costUsd || 0).toFixed(6)}</td></tr>`).join('');
    $('#drawer-body').innerHTML = `<div class="card-grid">
      <div class="info-card"><b>${totals.calls || 0}</b><div class="muted">模型调用</div></div>
      <div class="info-card"><b>$${Number(totals.costUsd || 0).toFixed(4)}</b><div class="muted">成本 USD</div></div>
      <div class="info-card"><b>${totals.promptTokens || 0}</b><div class="muted">输入 tokens</div></div>
      <div class="info-card"><b>${totals.cachedTokens || 0}</b><div class="muted">缓存命中</div></div>
    </div>
    <div class="info-card" style="margin-top:10px"><h3>按 Agent</h3>${usageRows ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>模型</th><th>档位</th><th>调用</th><th>输入</th><th>输出</th><th>缓存</th><th>成本</th></tr></thead><tbody>${usageRows}</tbody></table></div>` : '<p class="muted">暂无调用记录</p>'}</div>
    ${cost ? `<div class="info-card" style="margin-top:10px"><h3>缓存与阶段（报告实测）</h3><div class="stat-line"><span>缓存命中率</span><b>${(Number(cost.cacheHitRate || 0) * 100).toFixed(1)}%</b></div><div class="stat-line"><span>成本 / 无缓存基线</span><b>$${Number(cost.costUsd || 0).toFixed(6)} / $${Number(cost.baselineCostUsd || 0).toFixed(6)}</b></div>${stageRows ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>阶段</th><th>调用</th><th>输入</th><th>输出</th><th>成本</th></tr></thead><tbody>${stageRows}</tbody></table></div>` : ''}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- settings / tools

  function setProviderStatus(text, tone = '') {
    const el = $('#provider-status');
    el.textContent = text;
    el.className = `settings-status ${tone}`;
  }

  function syncProviders(data) {
    state.providers = data.providers || [];
    state.activeProviderId = data.activeId ?? null;
    state.config = { ...(state.config || {}), providers: state.providers, activeProviderId: state.activeProviderId };
    renderProviders();
  }

  async function loadConfig() {
    try {
      state.config = await api('/api/config');
      state.providers = state.config.providers || [];
      state.activeProviderId = state.config.activeProviderId ?? null;
      const deepseek = state.providers.find((provider) => provider.builtin);
      const anyKey = state.providers.some((provider) => provider.hasKey);
      if (!anyKey) {
        openSettings();
        if (deepseek) setTimeout(() => openProviderEditor(deepseek), 30);
      } else if (!state.providers.find((provider) => provider.id === state.activeProviderId)?.hasKey) {
        openSettings();
      }
    } catch (error) {
      toast(`读取配置失败：${error.message}`, 'error');
    }
  }

  async function loadProviders() {
    try {
      const data = await api('/api/providers');
      syncProviders(data);
    } catch (error) {
      toast(`读取模型提供商失败：${error.message}`, 'error');
    }
  }

  function renderProviders() {
    const list = $('#provider-list');
    const count = $('#provider-count');
    if (count) count.textContent = state.providers.length ? `${state.providers.length} 个提供商` : '尚未添加提供商';
    if (!list) return;
    if (!state.providers.length) {
      list.innerHTML = '<div class="provider-empty"><b>还没有模型提供商</b><span class="muted">添加 DeepSeek、OpenAI 兼容或自建网关后，选择当前使用的提供商。</span></div>';
      return;
    }
    list.innerHTML = state.providers.map((provider) => `<article class="provider-card ${provider.active ? 'active' : ''}">
      <div class="provider-main">
        <div class="provider-name">
          <span class="dot ${provider.hasKey ? 'completed' : 'idle'}"></span>
          <span>${esc(provider.name)}</span>
          ${provider.active ? '<span class="tag ok">当前使用</span>' : ''}
          ${provider.builtin ? '<span class="tag">内置</span>' : ''}
          ${!provider.hasKey ? '<span class="tag warn">未绑定 Key</span>' : ''}
        </div>
        <div class="provider-meta">${esc(provider.id)} · ${esc(provider.builtin ? 'DeepSeek' : (PROVIDER_PROTOCOL_LABELS[provider.api] || provider.api))} · ${esc(provider.baseUrl)}</div>
        <div class="provider-models"><span>Flash</span>${esc(provider.flashModel)}<span>Pro</span>${esc(provider.proModel)}</div>
        <div class="provider-key">${provider.maskedKey ? `Key ${esc(provider.maskedKey)}` : '未绑定 API Key'}</div>
      </div>
      <div class="provider-actions">
        ${!provider.active && provider.hasKey ? `<button class="btn ghost" data-provider-action="activate" data-provider-id="${esc(provider.id)}">设为当前</button>` : ''}
        <button class="btn ghost" data-provider-action="test" data-provider-id="${esc(provider.id)}">测试</button>
        <button class="btn ghost" data-provider-action="edit" data-provider-id="${esc(provider.id)}">编辑</button>
        ${provider.builtin ? '' : `<button class="btn ghost danger-text" data-provider-action="delete" data-provider-id="${esc(provider.id)}">删除</button>`}
      </div>
    </article>`).join('');
    list.querySelectorAll('[data-provider-action]').forEach((button) => {
      button.addEventListener('click', () => handleProviderAction(button.dataset.providerAction, button.dataset.providerId));
    });
  }

  function openSettings() {
    $('#settings-modal').classList.remove('hidden');
    $('#provider-editor').classList.add('hidden');
    state.editingProvider = null;
    renderProviders();
    loadProviders();
  }

  function closeSettings() {
    $('#settings-modal').classList.add('hidden');
    $('#provider-editor').classList.add('hidden');
    state.editingProvider = null;
  }

  function openProviderEditor(provider = null) {
    state.editingProvider = provider;
    const builtin = Boolean(provider?.builtin);
    $('#provider-editor').classList.remove('hidden');
    $('#provider-editor-title').textContent = provider ? (builtin ? '编辑 DeepSeek' : `编辑 ${provider.name}`) : '自定义模型 API';
    $('#provider-builtin-head').classList.toggle('hidden', !builtin);
    $('#provider-builtin-name').textContent = provider?.name ?? 'DeepSeek';
    $('#provider-builtin-id').textContent = provider?.id ?? 'deepseek';
    $('#provider-custom-fields').classList.toggle('hidden', builtin);
    $('#provider-model-section').classList.toggle('hidden', builtin);
    $('#provider-id').value = provider?.id ?? '';
    $('#provider-id').disabled = Boolean(provider);
    $('#provider-name').value = provider?.name ?? '';
    $('#provider-api').value = provider?.api ?? 'openai-chat';
    $('#provider-base').value = provider?.baseUrl ?? '';
    $('#provider-key').value = '';
    $('#provider-key').placeholder = provider?.hasKey ? '留空使用已保存凭据' : '输入 API 密钥';
    $('#provider-save').textContent = provider ? '保存' : '创建提供商';
    state.editorModels = builtin
      ? []
      : (provider?.models?.length
          ? provider.models.map((model) => ({ id: model.id, name: model.name || model.id }))
          : provider
            ? [{ id: provider.flashModel, name: provider.flashModel }, { id: provider.proModel, name: provider.proModel }]
            : []);
    renderModelDirectory(provider?.flashModel, provider?.proModel);
    setProviderStatus(
      builtin ? 'DeepSeek 是内置提供商，只需维护 API 密钥。' : provider ? '修改后保存；Key 留空则保留原密钥。' : '自定义模型 API：选择协议、获取模型，再为 Flash/Pro 选择档位模型。',
      builtin || provider?.hasKey ? 'ok' : 'warn',
    );
    $('#provider-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function modelHeuristics(ids) {
    const flash = ids.find((id) => /flash|mini|small|turbo|lite|haiku/i.test(id)) ?? ids[0] ?? '';
    const pro = ids.find((id) => /pro|max|large|opus|sonnet|gpt-4|reason/i.test(id)) ?? ids[ids.length - 1] ?? flash;
    return { flash, pro };
  }

  function refreshModelSelects(preferredFlash, preferredPro) {
    const ids = [...new Set(state.editorModels.map((model) => model.id.trim()).filter(Boolean))];
    const auto = modelHeuristics(ids);
    for (const [selector, preferred, fallback] of [
      ['#provider-flash-select', preferredFlash, auto.flash],
      ['#provider-pro-select', preferredPro, auto.pro],
    ]) {
      const select = $(selector);
      const current = select.value || preferred || fallback || '';
      select.innerHTML = `<option value="">请选择</option>${ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}`;
      select.value = ids.includes(current) ? current : (fallback && ids.includes(fallback) ? fallback : '');
    }
  }

  function renderModelDirectory(preferredFlash, preferredPro) {
    const list = $('#provider-model-list');
    if (!list) return;
    list.innerHTML = state.editorModels.length
      ? state.editorModels.map((model, index) => `<div class="model-row">
          <input class="input" data-model-id="${index}" value="${esc(model.id)}" placeholder="模型 ID">
          <input class="input" data-model-name="${index}" value="${esc(model.name)}" placeholder="显示名称（可选）">
          <button class="btn ghost danger-text" type="button" data-model-remove="${index}" title="删除">⌫</button>
        </div>`).join('')
      : '<div class="model-empty">还没有模型；点击「获取可用模型」或「添加模型」。</div>';
    list.querySelectorAll('[data-model-id]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number(input.dataset.modelId);
        const previousId = state.editorModels[index].id;
        const syncName = !state.editorModels[index].name || state.editorModels[index].name === previousId;
        state.editorModels[index].id = input.value;
        if (syncName) {
          state.editorModels[index].name = input.value;
          const nameInput = list.querySelector(`[data-model-name="${index}"]`);
          if (nameInput) nameInput.value = input.value;
        }
        refreshModelSelects($('#provider-flash-select').value, $('#provider-pro-select').value);
      });
    });
    list.querySelectorAll('[data-model-name]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number(input.dataset.modelName);
        state.editorModels[index].name = input.value;
      });
    });
    list.querySelectorAll('[data-model-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        state.editorModels.splice(Number(button.dataset.modelRemove), 1);
        renderModelDirectory($('#provider-flash-select').value, $('#provider-pro-select').value);
      });
    });
    const stateLabel = $('#provider-model-state');
    if (stateLabel) stateLabel.textContent = state.editorModels.length ? `已自定义模型目录（${state.editorModels.length}）` : '未添加模型，保存时自动发现';
    refreshModelSelects(preferredFlash, preferredPro);
  }

  async function fetchAvailableModels() {
    const baseUrl = $('#provider-base').value.trim();
    const api = $('#provider-api').value;
    const apiKey = $('#provider-key').value.trim();
    if (!baseUrl) { setProviderStatus('请先填写 API 地址', 'error'); return; }
    if (!apiKey && !state.editingProvider) { setProviderStatus('获取模型需要先填写 API 密钥', 'error'); return; }
    const button = $('#provider-model-fetch');
    button.disabled = true;
    setProviderStatus('正在获取模型…');
    try {
      const data = await api('/api/providers/discover-models', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl,
          api,
          apiKey: apiKey || undefined,
          providerId: state.editingProvider?.id,
        }),
      });
      state.editorModels = (data.models || []).map((model) => ({ id: model.id, name: model.name || model.id }));
      renderModelDirectory();
      if (data.warning) setProviderStatus(data.warning, 'warn');
      else setProviderStatus(`已获取 ${state.editorModels.length} 个模型`, 'ok');
    } catch (error) {
      setProviderStatus(`获取模型失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function resetEditorModels() {
    state.editorModels = [];
    renderModelDirectory();
    setProviderStatus('已清空模型目录；保存时将自动从网关发现模型。', 'warn');
  }

  function addEditorModel() {
    state.editorModels.push({ id: '', name: '' });
    renderModelDirectory($('#provider-flash-select').value, $('#provider-pro-select').value);
    const inputs = $('#provider-model-list').querySelectorAll('[data-model-id]');
    inputs[inputs.length - 1]?.focus();
  }

  async function handleProviderAction(action, id) {
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) return;
    if (action === 'edit') { openProviderEditor(provider); return; }
    if (action === 'activate') {
      try {
        const data = await api(`/api/providers/${encodeURIComponent(id)}/activate`, { method: 'POST' });
        syncProviders(data);
        toast(`已切换到 ${provider.name}`, 'ok');
      } catch (error) { toast(`切换失败：${error.message}`, 'error'); }
      return;
    }
    if (action === 'test') {
      try {
        const data = await api(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
        toast(data.warning ?? `${provider.name} 连接正常`, data.warning ? 'error' : 'ok');
      } catch (error) { toast(`连接失败：${error.message}`, 'error'); }
      return;
    }
    if (action === 'delete') {
      if (!window.confirm(`确定删除模型提供商「${provider.name}」？`)) return;
      try {
        const data = await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        syncProviders(data);
        toast(`已删除 ${provider.name}`, 'ok');
      } catch (error) { toast(`删除失败：${error.message}`, 'error'); }
    }
  }

  async function saveProvider() {
    const editing = state.editingProvider;
    const providerId = $('#provider-id').value.trim().toLowerCase();
    const apiKey = $('#provider-key').value.trim();
    const name = $('#provider-name').value.trim();
    const baseUrl = $('#provider-base').value.trim();
    if (!editing) {
      if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(providerId)) { setProviderStatus('Provider ID 只能使用小写字母、数字、- 或 _', 'error'); return; }
      if (!name || !baseUrl) { setProviderStatus('请填写显示名称与 API 地址', 'error'); return; }
      if (!apiKey) { setProviderStatus('新提供商必须填写 API 密钥', 'error'); return; }
    }
    const models = state.editorModels
      .map((model) => ({ id: model.id.trim(), name: (model.name || model.id).trim() }))
      .filter((model) => model.id);
    const flashModel = $('#provider-flash-select').value.trim();
    const proModel = $('#provider-pro-select').value.trim();
    const body = {
      ...(editing ? {} : { id: providerId }),
      name,
      baseUrl,
      api: $('#provider-api').value,
      ...(models.length ? { models } : {}),
      ...(flashModel ? { flashModel } : {}),
      ...(proModel ? { proModel } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    const button = $('#provider-save');
    button.disabled = true;
    setProviderStatus('正在验证并保存…');
    try {
      const data = await api(editing ? `/api/providers/${encodeURIComponent(editing.id)}` : '/api/providers', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      syncProviders(data);
      $('#provider-editor').classList.add('hidden');
      state.editingProvider = null;
      if (data.warning) toast(data.warning, 'error');
      else toast(editing ? '提供商已更新' : '提供商已创建', 'ok');
    } catch (error) {
      setProviderStatus(`保存失败：${error.message}`, 'error');
      toast(`保存失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function testEditingProvider() {
    if (!state.editingProvider) { setProviderStatus('先保存提供商，再测试连接', 'warn'); return; }
    setProviderStatus('正在测试连接…');
    try {
      const data = await api(`/api/providers/${encodeURIComponent(state.editingProvider.id)}/test`, { method: 'POST' });
      setProviderStatus(data.warning ?? '连接正常', data.warning ? 'warn' : 'ok');
    } catch (error) {
      setProviderStatus(`连接失败：${error.message}`, 'error');
    }
  }

  function openTools() { $('#tools-modal').classList.remove('hidden'); }
  function closeTools() { $('#tools-modal').classList.add('hidden'); }

  async function runTool(tool) {
    const output = $('#tool-output');
    output.innerHTML = '<div class="empty-note">执行中…</div>';
    try {
      if (tool === 'agents') {
        const data = await api('/api/agents');
        output.innerHTML = `<div class="info-card"><h3>Agent preset 注册表</h3><p class="muted">${esc(data.version)} · ${esc(data.fingerprint)}</p><div class="table-wrap"><table><thead><tr><th>id</th><th>名称</th><th>档位</th><th>深度</th><th>schema</th><th>工具</th></tr></thead><tbody>${data.agents.map((agent) => `<tr><td>${esc(agent.id)}</td><td>${esc(agent.nameZh)}</td><td>${esc(agent.tier)}</td><td>${esc(agent.maxDepth)}</td><td>${esc(agent.outputSchema)}</td><td>${esc(agent.tools.join(', '))}</td></tr>`).join('')}</tbody></table></div></div>`;
      } else if (tool === 'doctor') {
        const data = await api('/api/doctor');
        output.innerHTML = `<div class="info-card"><h3>环境自检</h3><ul>${data.checks.map((check) => `<li><span class="tag ${check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'danger'}">${esc(check.status)}</span> ${esc(check.name)} — ${esc(check.detail)}</li>`).join('')}</ul></div>`;
      } else if (tool === 'reset') {
        const phrase = window.prompt('这会删除台账、运行产物与上传缓存。输入 RESET 确认：');
        if (phrase !== 'RESET') return;
        await api('/api/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
        state.jobs = [];
        showNewView();
        await loadJobs();
        output.innerHTML = '<div class="info-card"><h3>已清空</h3><p class="muted">台账、运行产物与上传缓存已删除。</p></div>';
        toast('已清空', 'ok');
      }
    } catch (error) {
      output.innerHTML = `<div class="info-card"><p class="muted">${esc(error.message)}</p></div>`;
      toast(error.message, 'error');
    }
  }

  // ---------------------------------------------------------------- init

  function bind() {
    $('#new-run-btn').addEventListener('click', showNewView);
    $('#new-start').addEventListener('click', startRun);
    $('#attach-btn').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      await handleFiles(files);
    });
    $('#new-requirements').addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') startRun();
    });
    $('#job-search').addEventListener('input', renderJobs);
    $('#job-list').addEventListener('click', (event) => {
      const menuButton = event.target.closest('[data-job-menu]');
      if (menuButton) {
        event.stopPropagation();
        const rect = menuButton.getBoundingClientRect();
        openJobMenu(menuButton.getAttribute('data-job-menu'), rect.right - 8, rect.bottom + 6);
        return;
      }
      const item = event.target.closest('[data-job]');
      if (item) selectJob(item.getAttribute('data-job'));
    });
    $('#job-list').addEventListener('contextmenu', (event) => {
      const item = event.target.closest('[data-job]');
      if (!item) return;
      event.preventDefault();
      openJobMenu(item.getAttribute('data-job'), event.clientX, event.clientY);
    });
    $('#archived-toggle').addEventListener('click', () => {
      state.showArchived = !state.showArchived;
      closeJobMenu();
      renderJobs();
    });
    $('#session-menu').addEventListener('click', (event) => {
      const item = event.target.closest('[data-session-action]');
      if (item) handleJobAction(item.getAttribute('data-session-action'));
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#session-menu') && !event.target.closest('[data-job-menu]')) closeJobMenu();
    });
    document.addEventListener('scroll', closeJobMenu, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeJobMenu();
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === 'g' && state.jobId) {
        event.preventDefault();
        state.menuJobId = state.jobId;
        handleJobAction('rename');
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a' && state.jobId) {
        event.preventDefault();
        state.menuJobId = state.jobId;
        handleJobAction('archive');
      }
    });
    $('#recent-jobs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-job]');
      if (button) selectJob(button.getAttribute('data-job'));
    });
    $('#resume-btn').addEventListener('click', resumeCurrent);
    $('#pause-btn').addEventListener('click', pauseCurrent);
    $('#refresh-btn').addEventListener('click', async () => {
      if (!state.jobId) { await loadJobs(); return; }
      await loadRun(false);
      if (state.drawerTab === 'candidates') await loadCandidates();
      if (state.drawerTab === 'cost') await loadCost();
      toast('已刷新', 'ok');
    });
    $('#panel-btn').addEventListener('click', () => openDrawer(state.drawerTab || 'candidates'));
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#drawer-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-drawer-tab]');
      if (button) { state.drawerCandidate = null; openDrawer(button.dataset.drawerTab); }
    });
    $('#reply-send').addEventListener('click', sendReply);
    $('#reply-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendReply(); }
    });
    $('#open-settings').addEventListener('click', openSettings);
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#settings-close').addEventListener('click', closeSettings);
    $('#provider-add').addEventListener('click', () => openProviderEditor(null));
    $('#provider-save').addEventListener('click', saveProvider);
    $('#provider-cancel').addEventListener('click', () => {
      $('#provider-editor').classList.add('hidden');
      state.editingProvider = null;
    });
    $('#provider-test').addEventListener('click', testEditingProvider);
    $('#provider-model-fetch').addEventListener('click', fetchAvailableModels);
    $('#provider-model-reset').addEventListener('click', resetEditorModels);
    $('#provider-model-add').addEventListener('click', addEditorModel);
    $('#provider-id').addEventListener('input', (event) => {
      event.target.value = event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    });
    $('#provider-api').addEventListener('change', () => {
      const api = $('#provider-api').value;
      const base = $('#provider-base').value;
      const defaults = {
        'openai-chat': 'https://api.openai.com/v1',
        'openai-responses': 'https://api.openai.com/v1',
        'anthropic-messages': 'https://api.anthropic.com',
      };
      if (!base || base === 'https://api.openai.com/v1' || base === 'https://api.anthropic.com') {
        $('#provider-base').value = defaults[api] ?? '';
      }
    });
    $('#open-tools').addEventListener('click', openTools);
    $('#tools-close').addEventListener('click', closeTools);
    $('#tool-output').parentElement.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tool]');
      if (button) runTool(button.getAttribute('data-tool'));
    });
    $('#chat-scroll').addEventListener('click', (event) => {
      if (event.target.closest('#open-evidence')) openDrawer('candidates');
      if (event.target.closest('#open-cost')) openDrawer('cost');
      const row = event.target.closest('[data-candidate]');
      if (row) { openDrawer('candidates', false); openCandidate(row.getAttribute('data-candidate')); }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { closeSettings(); closeTools(); closeDrawer(); }
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '')) {
        event.preventDefault();
        $('#job-search').focus();
      }
    });
    window.addEventListener('hashchange', () => {
      const match = /^#job=(.+)$/.exec(window.location.hash);
      if (match) selectJob(decodeURIComponent(match[1]));
    });
  }

  async function init() {
    bind();
    applyTheme(currentTheme(), false);
    await loadConfig();
    const jobs = await loadJobs();
    const match = /^#job=(.+)$/.exec(window.location.hash);
    if (match && jobs.some((job) => job.id === decodeURIComponent(match[1]))) {
      await selectJob(decodeURIComponent(match[1]));
    } else if (window.location.hash === '#new' || jobs.length === 0) {
      showNewView();
    } else {
      await selectJob(jobs[0].id);
    }
    setInterval(() => {
      if (!state.jobId || state.run?.status !== 'running') loadJobs();
    }, 10_000);
  }

  init().catch((error) => {
    console.error(error);
    toast(`初始化失败：${error.message}`, 'error');
  });
})();
