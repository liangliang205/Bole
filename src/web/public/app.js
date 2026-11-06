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
  window.addEventListener('bole-agent-names', (event) => { Object.assign(AGENT_NAMES, event.detail); });
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
    chat: [], chatPending: false, chatAttachments: [], chatAttachSeq: 0,
    showArchived: false, menuJobId: '',
    knowledgeBases: [], knowledgeSettings: null, selectedKnowledgeBaseId: '', knowledgeDocs: [], knowledgeStats: null,
    attachments: [], uploadSeq: 0,
    eventSource: null, fallbackTimer: null, drawerTab: 'candidates', drawerCandidate: null,
    candidates: [], candidatesLoaded: false, cost: null, sending: false,
    providers: [], activeProviderId: null, activeModel: '', activeModelId: '', activeModelName: '', editingProvider: null, editorModels: [],
    settingsTab: 'models', plugins: [], skillPlugins: [], pluginStatus: null, pluginLoadError: '',
    editingPlugin: null, pluginBusy: false, pluginEnvDirty: false, pluginHeadersDirty: false,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  /** 安全的轻量 Markdown：先转义 HTML，再渲染常见块/行内语法。 */
  function renderChatMarkdown(source) {
    const blocks = [];
    let text = String(source ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code) => {
      const index = blocks.length;
      blocks.push(`<pre><code>${esc(String(code).replace(/\n$/, ''))}</code></pre>`);
      return `\n\u0002BLOCK${index}\u0002\n`;
    });

    const inline = (value) => {
      const codes = [];
      let result = esc(value);
      result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
        const index = codes.length;
        codes.push(`<code>${code}</code>`);
        return `\u0001CODE${index}\u0001`;
      });
      result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      result = result.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
      result = result.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      result = result.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      // eslint-disable-next-line no-control-regex -- 控制字符是代码块占位符，避免渲染顺序互相污染
      result = result.replace(/\u0001CODE(\d+)\u0001/g, (_match, index) => codes[Number(index)] ?? '');
      return result;
    };

    const html = [];
    let paragraph = [];
    let listType = '';
    let listItems = [];
    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      html.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!listType || listItems.length === 0) return;
      html.push(`<${listType}>${listItems.map((item) => `<li>${item}</li>`).join('')}</${listType}>`);
      listType = '';
      listItems = [];
    };
    const flush = () => {
      flushParagraph();
      flushList();
    };

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { flush(); continue; }
      // eslint-disable-next-line no-control-regex -- 同上：代码块占位符
      const block = /^\u0002BLOCK(\d+)\u0002$/.exec(trimmed);
      if (block) {
        flush();
        html.push(blocks[Number(block[1])] ?? '');
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        flush();
        html.push(`<h4>${inline(heading[2])}</h4>`);
        continue;
      }
      if (/^([-*_])\1{2,}$/.test(trimmed)) {
        flush();
        html.push('<hr>');
        continue;
      }
      const unordered = /^[-*•]\s+(.+)$/.exec(trimmed);
      if (unordered) {
        flushParagraph();
        if (listType && listType !== 'ul') flushList();
        listType = 'ul';
        listItems.push(inline(unordered[1]));
        continue;
      }
      const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
      if (ordered) {
        flushParagraph();
        if (listType && listType !== 'ol') flushList();
        listType = 'ol';
        listItems.push(inline(ordered[1]));
        continue;
      }
      const quote = /^>\s?(.*)$/.exec(trimmed);
      if (quote) {
        flush();
        html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }
      flushList();
      paragraph.push(inline(trimmed));
    }
    flush();
    return html.join('') || '<p></p>';
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

  const SIDEBAR_WIDTH_KEY = 'bole.sidebarWidth';
  const SIDEBAR_DEFAULT = 286;
  const CONTENT_WIDTH_KEY = 'bole.contentWidth';
  const CONTENT_DEFAULT = 900;

  function sidebarBounds() {
    return { min: 220, max: Math.max(260, Math.min(480, window.innerWidth - 560)) };
  }

  function applySidebarWidth(width, persist = true) {
    const { min, max } = sidebarBounds();
    const next = Math.max(min, Math.min(max, Math.round(width || SIDEBAR_DEFAULT)));
    $('#app').style.setProperty('--sidebar-width', `${next}px`);
    $('#sidebar-resizer').setAttribute('aria-valuenow', String(next));
    $('#sidebar-resizer').setAttribute('aria-valuemin', String(min));
    $('#sidebar-resizer').setAttribute('aria-valuemax', String(max));
    if (persist) {
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next)); } catch { /* 隐私模式 */ }
    }
  }

  function contentBounds() {
    const mainWidth = $('.main')?.clientWidth ?? window.innerWidth;
    return { min: 620, max: Math.max(620, Math.min(1400, mainWidth - 48)) };
  }

  function applyContentWidth(width, persist = true) {
    const { min, max } = contentBounds();
    const next = Math.max(min, Math.min(max, Math.round(width || CONTENT_DEFAULT)));
    $('#app').style.setProperty('--content-width', `${next}px`);
    for (const selector of ['#content-resizer', '#content-resizer-left']) {
      const item = $(selector);
      if (!item) continue;
      item.setAttribute('aria-valuenow', String(next));
      item.setAttribute('aria-valuemin', String(min));
      item.setAttribute('aria-valuemax', String(max));
    }
    if (persist) {
      try { localStorage.setItem(CONTENT_WIDTH_KEY, String(next)); } catch { /* 隐私模式 */ }
    }
  }

  function bindContentResize() {
    let saved = CONTENT_DEFAULT;
    try {
      const stored = Number(localStorage.getItem(CONTENT_WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) saved = stored;
    } catch {
      // 忽略隐私模式读取失败
    }
    applyContentWidth(saved, false);
    const bindHandle = (selector, side) => {
      const resizer = $(selector);
      if (!resizer) return;
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        $('.main').classList.remove('is-resizing-content');
        document.body.classList.remove('is-resizing-content');
        applyContentWidth(parseFloat(getComputedStyle($('#app')).getPropertyValue('--content-width')) || CONTENT_DEFAULT);
      };
      const move = (event) => {
        if (!dragging) return;
        const direction = side === 'left' ? startX - event.clientX : event.clientX - startX;
        applyContentWidth(startWidth + direction * 2, false);
      };
      resizer.addEventListener('pointerdown', (event) => {
        if (window.innerWidth <= 760) return;
        dragging = true;
        startX = event.clientX;
        startWidth = parseFloat(getComputedStyle($('#app')).getPropertyValue('--content-width')) || CONTENT_DEFAULT;
        try { resizer.setPointerCapture(event.pointerId); } catch { /* 窗口监听兜底 */ }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
        $('.main').classList.add('is-resizing-content');
        document.body.classList.add('is-resizing-content');
        event.preventDefault();
      });
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', stop);
      resizer.addEventListener('pointercancel', stop);
      resizer.addEventListener('lostpointercapture', stop);
      resizer.addEventListener('dblclick', () => applyContentWidth(CONTENT_DEFAULT));
      resizer.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
        event.preventDefault();
        if (event.key === 'Home') { applyContentWidth(CONTENT_DEFAULT); return; }
        const current = parseFloat(getComputedStyle($('#app')).getPropertyValue('--content-width')) || CONTENT_DEFAULT;
        applyContentWidth(current + (event.key === 'ArrowRight' ? 24 : -24));
      });
    };
    bindHandle('#content-resizer', 'right');
    bindHandle('#content-resizer-left', 'left');
  }

  function bindSidebarResize() {
    let saved = SIDEBAR_DEFAULT;
    try {
      const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) saved = stored;
    } catch {
      // 忽略隐私模式读取失败
    }
    applySidebarWidth(saved, false);

    const resizer = $('#sidebar-resizer');
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      $('#app').classList.remove('is-resizing');
      document.body.classList.remove('is-resizing');
      applySidebarWidth($('.sidebar').getBoundingClientRect().width);
      applyContentWidth(parseFloat(getComputedStyle($('#app')).getPropertyValue('--content-width')) || CONTENT_DEFAULT);
    };

    resizer.addEventListener('pointerdown', (event) => {
      if (window.innerWidth <= 760) return;
      dragging = true;
      startX = event.clientX;
      startWidth = $('.sidebar').getBoundingClientRect().width;
      resizer.setPointerCapture(event.pointerId);
      $('#app').classList.add('is-resizing');
      document.body.classList.add('is-resizing');
      event.preventDefault();
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      applySidebarWidth(startWidth + (event.clientX - startX), false);
    });
    resizer.addEventListener('pointerup', stop);
    resizer.addEventListener('pointercancel', stop);
    resizer.addEventListener('lostpointercapture', stop);
    resizer.addEventListener('dblclick', () => applySidebarWidth(SIDEBAR_DEFAULT));
    resizer.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
      event.preventDefault();
      if (event.key === 'Home') { applySidebarWidth(SIDEBAR_DEFAULT); return; }
      const current = $('.sidebar').getBoundingClientRect().width;
      applySidebarWidth(current + (event.key === 'ArrowRight' ? 16 : -16));
    });
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
    $('#chat-view').dataset.jobId = '';
    disconnectStream();
    Object.assign(state, { jobId: '', run: null, snapshot: null, report: null, events: [], lastSeq: 0, hitlId: '', attachments: [], chat: [], chatPending: false, chatAttachments: [] });
    state.seen.clear();
    state.streams.clear();
    renderAttachments();
    history.replaceState(null, '', '#new');
    $('#empty-view').classList.remove('hidden');
    $('#chat-view').classList.add('hidden');
    $('.main').classList.remove('chat-active');
    closeDrawer();
    document.title = '伯乐 BoLe · 对话式招聘筛选';
    renderJobs();
    setTimeout(() => $('#new-requirements')?.focus(), 30);
  }

  function showChatView() {
    $('#empty-view').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    $('.main').classList.add('chat-active');
  }


  async function selectJob(jobId) {
    $('#chat-view').dataset.jobId = jobId || '';
    if (!jobId) { showNewView(); return; }
    disconnectStream();
    Object.assign(state, {
      jobId, run: null, snapshot: null, report: null, events: [], lastSeq: 0, hitlId: '',
      candidates: [], candidatesLoaded: false, cost: null, drawerCandidate: null,
      chat: [], chatPending: false, chatAttachments: [],
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
      await loadChat();
      renderAll();
      if (state.run.status === 'running' || state.run.status === 'pausing') connectStream();
      else disconnectStream();
    } catch (error) {
      toast(`读取会话失败：${error.message}`, 'error');
    }
  }

  async function loadChat() {
    if (!state.jobId) return;
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/chat`);
      state.chat = data.messages || [];
    } catch {
      state.chat = [];
    }
  }

  function renderAll() {
    if (!state.run || !state.snapshot) return;
    const job = state.snapshot.job || {};
    const run = state.run;
    document.title = `${jobTitle(job)} · 伯乐 BoLe`;
    const canChat = ['completed', 'paused', 'failed', 'idle'].includes(run.status);
    const replyHint = run.pendingHitl ? '请回答上方 HITL 问题（可直接输入自定义回答）' : '';
    $('#reply-hint').textContent = replyHint;
    $('#reply-hint').classList.toggle('hidden', !replyHint);
    const activeProvider = state.providers.find((provider) => provider.id === state.activeProviderId);
    if (!state.activeModel && activeProvider) {
      const modelId = activeProvider.proModel || activeProvider.flashModel || '';
      const model = activeProvider.models?.find((item) => item.id === modelId);
      state.activeModelId = modelId;
      state.activeModelName = model?.name?.trim() || modelId;
      state.activeModel = activeProvider.name?.trim() || state.activeModelName;
    }
    renderReplyModel();
    $('#reply-send').classList.toggle('is-sending', state.sending);
    $('#reply-send').setAttribute('aria-busy', state.sending ? 'true' : 'false');
    const placeholder = run.pendingHitl
      ? '回答 HITL 问题，或点击上方选项…'
      : canChat ? '继续追问伯乐，例如：为什么 R08 不推荐？' : '筛选完成后可继续和伯乐对话…';
    $('#reply-input').setAttribute('data-placeholder', placeholder);
    $('#reply-input').setAttribute('aria-disabled', run.pendingHitl || canChat ? 'false' : 'true');
    renderChatAttachments();
    syncReplyComposerState();
    renderChat();
    renderHitl(run.pendingHitl);
    renderApprovals(run);
    if (run.status !== 'running') state.streams.clear();
    renderStreams();
    if (!$('#drawer').classList.contains('hidden')) {
      if (state.drawerTab === 'candidates') renderCandidates();
      if (state.drawerTab === 'compliance') renderCompliance();
      if (state.drawerTab === 'cost') renderCost();
      if (['memory', 'agents', 'workflow'].includes(state.drawerTab)) loadDrawerInspector();
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
      const icon = isPdf ? 'PDF' : 'W';
      const desc = isPdf ? '只读文件，适合分发与归档' : '可编辑文档，适合修改与签字';
      const href = `/api/run/${encodeURIComponent(state.jobId)}/files/${encodeURIComponent(name)}`;
      return `<div class="file-card" data-preview-file="${esc(name)}" role="button" tabindex="0" title="预览 ${esc(name)}">
        <span class="file-icon ${isPdf ? 'pdf' : 'word'}">${icon}</span>
        <span class="file-meta"><span class="file-name">${esc(name)}</span><span class="file-desc">${esc(desc)}</span></span>
        <a class="file-download" href="${href}" download title="下载 ${esc(name)}">↓</a>
      </div>`;
    });
    const visible = cards.slice(0, VISIBLE).join('');
    const hidden = cards.slice(VISIBLE).join('');
    const more = hidden
      ? `<details><summary class="file-more">全部 ${files.length} 个文件</summary><div class="file-grid" style="margin-top:6px">${hidden}</div></details>`
      : '';
    return `<div class="file-grid">${visible}</div>${more}`;
  }

  let pdfjsPromise = null;
  let previewRenderVersion = 0;

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((module) => {
        module.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return module;
      });
    }
    return pdfjsPromise;
  }

  async function renderPdfPreview(url, version) {
    const pages = $('#file-preview-pages');
    pages.replaceChildren();
    const loading = $('#file-preview-loading');
    loading.textContent = '正在生成预览…';
    loading.classList.remove('hidden');
    try {
      const pdfjs = await loadPdfjs();
      const pdf = await pdfjs.getDocument({ url }).promise;
      if (version !== previewRenderVersion) return;
      const width = Math.max(320, pages.clientWidth - 32);
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (version !== previewRenderVersion) return;
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const scale = Math.min(2.2, width / base.width);
        const viewport = page.getViewport({ scale: scale * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = '100%';
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器无法创建画布');
        await page.render({ canvasContext: context, viewport }).promise;
        if (version !== previewRenderVersion) return;
        pages.appendChild(canvas);
        loading.classList.add('hidden');
      }
    } catch (error) {
      if (version !== previewRenderVersion) return;
      loading.classList.add('hidden');
      const message = document.createElement('div');
      message.className = 'file-preview-error';
      message.textContent = `预览失败：${error.message || String(error)}。可点击右上角下载原文件。`;
      pages.replaceChildren(message);
    }
  }

  function openFilePreview(name) {
    if (!state.jobId) return;
    closeDrawer();
    const pane = $('#preview-pane');
    const href = `/api/run/${encodeURIComponent(state.jobId)}/files/${encodeURIComponent(name)}`;
    $('#file-preview-title').textContent = name;
    $('#file-preview-sub').textContent = /\.pdf$/i.test(name)
      ? 'PDF 预览'
      : 'DOCX 已转换为 PDF 预览；版式可能与应用软件略有差异';
    $('#file-preview-download').setAttribute('href', href);
    pane.classList.remove('hidden');
    $('#app').classList.add('preview-open');
    previewRenderVersion += 1;
    renderPdfPreview(`${href}/preview?t=${Date.now()}`, previewRenderVersion);
  }

  function closeFilePreview() {
    previewRenderVersion += 1;
    $('#preview-pane').classList.add('hidden');
    $('#app').classList.remove('preview-open');
    $('#file-preview-pages').replaceChildren();
    $('#file-preview-loading').classList.add('hidden');
  }

  const PREVIEW_WIDTH_KEY = 'bole.previewWidth';
  function previewBounds() {
    return { min: 360, max: Math.max(420, Math.min(window.innerWidth * .75, 1100)) };
  }
  function applyPreviewWidth(width) {
    const { min, max } = previewBounds();
    const next = Math.max(min, Math.min(max, Math.round(width || window.innerWidth * .48)));
    $('#app').style.setProperty('--preview-width', `${next}px`);
  }
  function bindPreviewResize() {
    let saved = 0;
    try { saved = Number(localStorage.getItem(PREVIEW_WIDTH_KEY)); } catch { /* 隐私模式 */ }
    applyPreviewWidth(Number.isFinite(saved) && saved > 0 ? saved : window.innerWidth * .48);
    const resizer = $('#preview-resizer');
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-resizing-preview');
      try {
        localStorage.setItem(PREVIEW_WIDTH_KEY, String($('#preview-pane').getBoundingClientRect().width));
      } catch { /* 隐私模式 */ }
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (window.innerWidth <= 900) return;
      dragging = true;
      startX = event.clientX;
      startWidth = $('#preview-pane').getBoundingClientRect().width;
      try { resizer.setPointerCapture(event.pointerId); } catch { /* 窗口监听兜底 */ }
      document.body.classList.add('is-resizing-preview');
      event.preventDefault();
    });
    window.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      applyPreviewWidth(startWidth + (startX - event.clientX));
    });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  const DRAWER_WIDTH_KEY = 'bole.drawerWidth';
  function drawerBounds() {
    return { min: 340, max: Math.max(420, Math.min(900, window.innerWidth * .7)) };
  }
  function applyDrawerWidth(width) {
    const { min, max } = drawerBounds();
    const next = Math.max(min, Math.min(max, Math.round(width || 520)));
    $('#app').style.setProperty('--drawer-width', `${next}px`);
  }
  function bindDrawerResize() {
    let saved = 0;
    try { saved = Number(localStorage.getItem(DRAWER_WIDTH_KEY)); } catch { /* 隐私模式 */ }
    applyDrawerWidth(Number.isFinite(saved) && saved > 0 ? saved : 520);
    const resizer = $('#drawer-resizer');
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-resizing-drawer');
      try {
        localStorage.setItem(DRAWER_WIDTH_KEY, String($('#drawer').getBoundingClientRect().width));
      } catch { /* 隐私模式 */ }
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (window.innerWidth <= 900) return;
      dragging = true;
      startX = event.clientX;
      startWidth = $('#drawer').getBoundingClientRect().width;
      try { resizer.setPointerCapture(event.pointerId); } catch { /* 窗口监听兜底 */ }
      document.body.classList.add('is-resizing-drawer');
      event.preventDefault();
    });
    window.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      applyDrawerWidth(startWidth + (startX - event.clientX));
    });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
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
      // Detailed workflow paths and node checkpoints live in the task panel.
      if (event.type.startsWith('workflow.')) continue;
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
    for (const message of state.chat) {
      const files = Array.isArray(message.files) ? message.files : [];
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      const attachmentChips = attachments.length
        ? `<div class="msg-attachments">${attachments.map((attachment) => `<span class="chat-attachment"><span class="name">${esc(attachment.name)}</span></span>`).join('')}</div>`
        : '';
      parts.push(messageHtml(
        message.role === 'user' ? 'user' : 'assistant',
        message.role === 'user' ? 'HR' : '伯乐',
        fmtTime(message.created_ts),
        `<div class="msg-text chat-markdown">${renderChatMarkdown(message.content)}</div>${attachmentChips}${files.length ? fileCardsHtml(files) : ''}`,
      ));
    }
    if (state.sending && state.run?.status === 'completed' && !state.run?.pendingHitl) {
      parts.push(messageHtml('assistant', '伯乐', '', '<div class="msg-text muted">正在思考…</div>'));
    }
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
    const counts = state.snapshot?.resumeCounts || {};
    const unfinished = ['queued', 'parsing', 'parsed', 'evaluating', 'evaluated', 'verifying'].reduce((n, key) => n + (counts[key] || 0), 0);
    if (unfinished || state.run?.status !== 'completed' && report.run?.status !== 'draft') {
      return messageHtml('assistant', '伯乐', '', `<div class="msg-text">筛选尚未完成${unfinished ? `，还有 ${unfinished} 份材料未完成处理` : ''}。当前不展示最终候选人结论，请在任务面板查看执行状态。</div>`);
    }
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

  function renderApprovals(run) {
    const host = $('#approval-host');
    const approvals = run.approvals || [];
    const signature = JSON.stringify([run.jobId, approvals]);
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    const titles = { 'screening-plan': '批准筛选计划', 'publish-report': '审阅并发布报告', tool: '批准工具操作', workflow: '工作流人工审批', 'memory-policy-change': '长期规则修订', 'recruitment-mail': '确认候选人与招聘邮件' };
    host.innerHTML = (run.executionMode === 'strict' ? '<div class="muted">严格模式 · 计划、工具与发布需审批</div>' : '') +
      approvals.filter((item) => item.status === 'pending' && item.kind !== 'memory-policy-change').map((item) => {
        const payload = JSON.parse(item.payload_json);
        const preview = item.kind === 'tool' ? { tool: payload.name, arguments: payload.arguments } : payload;
        let summary = '';
        if (item.kind === 'screening-plan') {
          const plan = payload.plan;
          summary = `<p>岗位：${esc(payload.jd?.title || '')}。材料 ${payload.materials?.length || 0} 份。</p>
            <p>每批 ${esc(plan.batchSize)} 份，同时处理 ${esc(plan.maxBatchesInFlight)} 批；总并发上限 ${esc(plan.maxActiveAgents)}。
            ${plan.deepEval.enabled ? `初筛后深评前 ${esc(plan.deepEval.percent)}% 及异常项。` : '本轮不启用深评。'}核查打回最多修正 ${esc(payload.revisionBudget.maxLoops)} 次。</p>
            <p>${esc(plan.reason)}</p>`;
        } else if (item.kind === 'recruitment-mail') {
          summary = `<p>选定候选人：<strong>${esc(payload.candidate)}</strong></p><p>发件邮箱：${esc(payload.mailbox)}<br>收件地址（投递邮件发件人）：${esc(payload.to)}</p><p>主题：${esc(payload.subject)}</p><pre class="approval-preview">${esc(payload.body)}</pre><p>批准后发送此邮件；请核对收件地址是否为候选人本人。</p>`;
        } else if (item.kind === 'publish-report') {
          summary = (payload.report.top || []).map((candidate) => `<p><strong>${esc(candidate.label)}</strong> · ${esc(candidate.totalScore)} 分<br>${esc(candidate.reason || '')}</p>`).join('') || '<p>暂无推荐候选人，请查看完整报告中的失败及转人工明细。</p>';
        } else {
          summary = `<p>工具：${esc(payload.name)}</p><pre class="approval-preview">${esc(payload.arguments)}</pre>`;
        }
        return `<div class="hitl-card"><h3>${esc(titles[item.kind] || item.kind)}</h3>
          <p>批准仅适用于下列具体内容。拒绝后不会继续执行；需要修改时请重新发起。</p>
          ${summary}<details><summary>查看完整审批内容与证据</summary><pre class="approval-preview">${esc(JSON.stringify(preview, null, 2))}</pre></details>
          <div class="hitl-options"><button class="hitl-option" data-approval="${esc(item.id)}" data-decision="approve">批准${item.kind === 'tool' ? '并执行' : '并继续'}</button>
          <button class="hitl-option" data-approval="${esc(item.id)}" data-decision="reject">拒绝</button></div></div>`;
      }).join('') + approvals.filter((item) => ['executing', 'rejected', 'failed'].includes(item.status))
        .map((item) => `<div class="muted">${esc(titles[item.kind] || item.kind)}：${esc({ executing: '执行中（若服务已重启，请人工核对结果，不会自动重放）', rejected: '已拒绝，未执行', failed: '执行失败，可重新发起' }[item.status])}</div>`).join('');
    host.querySelectorAll('[data-approval]').forEach((button) => button.addEventListener('click', async () => {
      if (state.sending) return;
      state.sending = true;
      host.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      try {
        const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/approvals/${encodeURIComponent(button.dataset.approval)}`, {
          method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }),
        });
        await loadRun(false);
        if (data.resumeRequired) await resumeCurrent();
        if (state.run?.status === 'completed') await loadChat();
      } catch (error) { toast(`审批处理失败：${error.message}`, 'error'); }
      finally { state.sending = false; host.dataset.signature = ''; await loadRun(false); }
    }));
  }

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

  function replyValue() {
    return ($('#reply-input').innerText || '').replace(/\u00a0/g, ' ').trim();
  }

  function syncReplyComposerState() {
    const run = state.run;
    if (!run) return;
    const canSubmit = run.pendingHitl || ['completed', 'paused', 'failed', 'idle'].includes(run.status);
    const pending = state.chatAttachments.some((item) => item.status === 'uploading');
    const empty = replyValue() === '' && state.chatAttachments.filter((item) => item.status !== 'error').length === 0;
    const button = $('#reply-send');
    const approvalBlocked = (run.approvals || []).some((item) => ['screening-plan', 'publish-report', 'workflow'].includes(item.kind) && ['pending', 'rejected'].includes(item.status));
    const action = run.pendingHitl ? 'send' : run.status === 'pausing' ? 'waiting' : run.status === 'running' ? 'pause'
      : ['paused', 'failed', 'idle'].includes(run.status) && empty ? 'resume' : 'send';
    const label = { send: '发送', pause: '暂停筛选', resume: approvalBlocked ? '请先处理审批；拒绝后需新建会话' : '从检查点续跑', waiting: '正在安全暂停…' }[action];
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.action = action;
    const paths = { send: '<path d="M8 13V3m-4 4 4-4 4 4"/>', pause: '<path d="M5 3v10M11 3v10"/>', resume: '<path d="m5 3 8 5-8 5Z"/>', waiting: '<circle cx="8" cy="8" r="5"/><path d="M8 5v3l2 1"/>' };
    button.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[action]}</svg>`;
    button.disabled = state.sending || state.controlPending || action === 'waiting' || (action === 'resume' && approvalBlocked)
      || (action === 'send' && (pending || empty || !canSubmit));
    $('#chat-attach-btn').disabled = state.sending || !canSubmit;
  }

  function renderChatAttachments() {
    const host = $('#chat-attachments');
    if (!host) return;
    host.innerHTML = state.chatAttachments.map((file) => `
      <span class="chat-attachment ${file.status === 'error' ? 'error' : file.status === 'uploading' ? 'uploading' : ''}">
        <span class="name" title="${esc(file.filename)}">${esc(file.filename)}</span>
        <span>${file.status === 'uploading' ? '上传中…' : file.status === 'error' ? '失败' : ''}</span>
        <button type="button" data-chat-attachment-remove="${esc(file.id)}" title="移除">×</button>
      </span>`).join('');
    host.querySelectorAll('[data-chat-attachment-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        state.chatAttachments = state.chatAttachments.filter((item) => item.id !== button.getAttribute('data-chat-attachment-remove'));
        renderChatAttachments();
        syncReplyComposerState();
      });
    });
  }

  async function uploadChatFiles(files) {
    if (!files.length) return;
    const room = Math.max(0, 5 - state.chatAttachments.length);
    if (room === 0) { toast('最多上传 5 个附件', 'error'); return; }
    for (const file of files.slice(0, room)) {
      if (file.size > 25 * 1024 * 1024) { toast(`${file.name} 超过 25MB`, 'error'); continue; }
      state.chatAttachSeq += 1;
      const entry = {
        id: `chat_file_${state.chatAttachSeq}`,
        filename: file.name,
        size: file.size,
        status: 'uploading',
        uploadId: '',
      };
      state.chatAttachments.push(entry);
      renderChatAttachments();
      syncReplyComposerState();
      try {
        const contentBase64 = await fileToBase64(file);
        const data = await api('/api/uploads', {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, contentBase64 }),
        });
        entry.uploadId = data.upload.uploadId;
        entry.status = 'ready';
      } catch (error) {
        entry.status = 'error';
        toast(`${file.name} 上传失败：${error.message}`, 'error');
      }
      renderChatAttachments();
      syncReplyComposerState();
    }
  }

  function clearChatAttachments() {
    state.chatAttachments = [];
    renderChatAttachments();
  }

  function clearReplyInput() {
    $('#reply-input').innerHTML = '';
  }

  async function sendChat() {
    if (!state.jobId || !['completed', 'paused', 'failed', 'idle'].includes(state.run?.status)) return;
    const value = replyValue();
    const ready = state.chatAttachments.filter((item) => item.status === 'ready' && item.uploadId);
    if (state.chatAttachments.some((item) => item.status === 'uploading')) { toast('附件还在上传，请稍候', 'error'); return; }
    if (!value && ready.length === 0) { toast('请输入内容或添加附件', 'error'); return; }
    clearReplyInput();
    state.sending = true;
    state.chat.push({
      id: `local_${Date.now()}`,
      role: 'user',
      content: value || '请查看附件。',
      attachments: ready.map((item) => ({ name: item.filename, text: '' })),
      created_ts: new Date().toISOString(),
    });
    renderAll();
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          message: value,
          uploadIds: ready.map((item) => item.uploadId),
        }),
      });
      state.chat = data.messages || state.chat;
      clearChatAttachments();
      await loadRun(false);
    } catch (error) {
      await loadChat();
      $('#reply-input').textContent = value;
      toast(`对话失败：${error.message}`, 'error');
    } finally {
      state.sending = false;
      renderAll();
    }
  }

  async function sendReply() {
    if (state.run?.pendingHitl) {
      const value = replyValue();
      if (!value) { toast('请输入回答', 'error'); return; }
      clearReplyInput();
      await submitHitl(value);
      return;
    }
    if (['completed', 'paused', 'failed', 'idle'].includes(state.run?.status)) {
      await sendChat();
      return;
    }
    toast('当前没有待回答的问题；筛选完成后可以继续和伯乐对话', 'error');
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
    const useMailbox = $('#new-mail-enabled').checked;
    if (uploaded.length === 0 && !useMailbox) { showHint('请上传简历或选择从招聘邮箱收取', true); return; }
    const mailbox = useMailbox ? { query: $('#new-mail-query').value.trim(), maxMessages: Number($('#new-mail-limit').value), ...($('#new-mail-after').value ? { after: new Date(`${$('#new-mail-after').value}T00:00:00`).toISOString() } : {}) } : undefined;
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
        body: JSON.stringify({ requirements, mailbox, uploadIds: uploaded.map((file) => file.uploadId), executionMode: $('#new-execution-mode').value, policyVersionId: $('#new-policy-version').value || undefined, agentTeamKey: $('#new-agent-team').value }),
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
    if (!$('#preview-pane').classList.contains('hidden')) closeFilePreview();
    state.drawerTab = tab;
    $('#drawer').classList.remove('hidden');
    $('#app').classList.add('drawer-open');
    $$('#drawer-tabs .tab').forEach((button) => button.classList.toggle('active', button.dataset.drawerTab === tab));
    if (tab === 'candidates') { if (load) loadCandidates(); else renderCandidates(); }
    if (tab === 'compliance') { loadCandidates().then(renderCompliance); }
    if (tab === 'cost') loadCost();
    if (['memory', 'agents', 'workflow'].includes(tab)) loadDrawerInspector(true);
  }

  let inspectorKey = '';
  let inspectorRequest = 0;
  async function loadDrawerInspector(force = false) {
    const jobId = state.jobId;
    const tab = state.drawerTab;
    if (!['memory', 'agents', 'workflow'].includes(tab)) return;
    const key = JSON.stringify([jobId, tab, state.run?.status, state.snapshot?.eventsCount]);
    if (!force && inspectorKey === key) return;
    inspectorKey = key;
    const request = ++inspectorRequest;
    const current = () => request === inspectorRequest && state.jobId === jobId && state.drawerTab === tab;
    const body = $('#drawer-body');
    if (!jobId) { body.innerHTML = '<div class="empty-note">选择会话后查看任务详情</div>'; return; }
    body.innerHTML = '<div class="empty-note">读取中…</div>';
    try {
      const data = await api(tab === 'memory' ? `/api/memory/jobs/${encodeURIComponent(jobId)}` : `/api/run/${encodeURIComponent(jobId)}/${tab === 'workflow' ? 'workflow' : 'agent-manifest'}`);
      if (!current()) return;
      if (tab === 'workflow') {
        const statuses = { pending: '待执行', running: '执行中', waiting_approval: '等待审批', waiting_confirmation: '结果待确认', paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
        const kinds = { task: '任务', sequence: '顺序', parallel: '并行', condition: '条件', loop: '循环', subworkflow: '子流程', approval: '人工审批' };
        body.innerHTML = '<h3>工作流执行</h3><p class="muted">查看流程版本、父子运行、分支及每轮核查修正。</p>' + ((data.runs || []).map((run) => `<section class="eval-card"><div class="eval-head"><b>${esc(run.workflow_key)}</b><span class="tag ${run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'danger' : ''}">${esc(statuses[run.status] || run.status)}</span></div><small class="muted">运行 ${esc(run.id)}${run.parent_run_id ? `<br>父运行 ${esc(run.parent_run_id)} · ${esc(run.parent_node_path)}` : ' · 根流程'}</small>${run.error ? `<p class="muted">${esc(run.error)}</p>` : ''}
          ${(data.nodes || []).filter((n) => n.run_id === run.id).map((n) => `<details class="workflow-node"><summary><span class="tag">${esc(statuses[n.status] || n.status)}</span> ${esc(n.node_id)} <small class="muted">${esc(kinds[n.kind] || n.kind)}</small></summary><p class="muted">${esc(n.path)} · 执行 ${esc(n.attempt)} 次</p>${n.error ? `<p>${esc(n.error)}</p>` : ''}<pre class="approval-preview">${esc(JSON.stringify({ input: JSON.parse(n.input_json), output: n.output_json ? JSON.parse(n.output_json) : null, control: n.control_json ? JSON.parse(n.control_json) : null }, null, 2))}</pre>${n.status === 'waiting_confirmation' && n.kind === 'task' ? `<p class="muted">先核对外部操作结果，再选择重试或录入符合该节点契约的结果。</p><div class="row"><button class="btn ghost" data-workflow-confirm="retry" data-run="${esc(run.id)}" data-path="${esc(n.path)}">确认可以重试</button><button class="btn ghost" data-workflow-confirm="complete" data-run="${esc(run.id)}" data-path="${esc(n.path)}">录入已完成结果</button></div>` : ''}</details>`).join('')}</section>`).join('') || '<div class="empty-note">暂无工作流记录；历史任务首次续跑时会建立兼容运行。</div>');
        if ((data.queue || []).length) {
          const queueStates = { queued: '等待执行', running: '执行中', succeeded: '已完成', stopped: '已停止', interrupted: '等待恢复' };
          body.insertAdjacentHTML('beforeend', `<details class="eval-card"><summary>执行队列（${data.queue.length}）</summary><p class="muted">固定 Agent 绑定；依赖由工作流推进，容量不足时等待，不自动跳过材料。</p>${data.queue.map((q) => `<div class="workflow-node"><b>${esc(q.label)}</b> <span class="tag">${esc(queueStates[q.state] || q.state)}</span><p class="muted">${esc(q.reason || '执行次数：' + q.attempts)}</p></div>`).join('')}</details>`);
        }
        body.querySelectorAll('[data-workflow-confirm]').forEach((button) => button.addEventListener('click', async () => {
          try {
            const action = button.dataset.workflowConfirm;
            let output;
            if (action === 'complete') { const value = window.prompt('请输入该节点已完成的输出（JSON）'); if (value === null) return; output = JSON.parse(value); }
            else if (!window.confirm('已核对外部系统，确认重复执行不会造成重复操作？')) return;
            await api(`/api/run/${encodeURIComponent(jobId)}/workflow/confirm`, { method: 'POST', body: JSON.stringify({ runId: button.dataset.run, path: button.dataset.path, action, ...(action === 'complete' ? { output } : {}) }) });
            toast('已记录确认，可使用发送按钮续跑', 'ok'); await loadDrawerInspector(true);
          } catch (error) { toast(`确认失败：${error.message}`, 'error'); }
        }));
      } else if (tab === 'memory') {
        const view = data.view || {};
        const binding = view.binding;
        const profile = data.profile;
        body.innerHTML = `<h3>当前任务记忆</h3><p class="muted">当前会话的确认条件、评分标准与历史摘要。</p>
          <div class="eval-card"><b>${esc(profile?.jd?.title || '岗位尚未完成画像')}</b><p class="muted">${binding ? `评分标准已冻结 · ${binding.version_id ? '复用已批准版本' : '按本次需求生成'}` : '尚未绑定评分标准'}</p>
          ${(profile?.scorecard?.dimensions || []).map((d) => `<div class="muted">${esc(d.name)} · ${esc(d.weight)}%</div>`).join('')}</div>
          <h3>人工确认记录</h3>${(view.decisions || []).map((d) => `<div class="eval-card"><div>${esc(d.question)}</div><p>${esc(d.answer)}</p><small class="muted">${esc(d.actor)}</small></div>`).join('') || '<div class="empty-note">暂无确认记录</div>'}
          <h3>对话摘要</h3>${(view.summaries || []).map((s) => `<div class="eval-card">覆盖消息 ${esc(s.from_seq)}–${esc(s.through_seq)}<p class="muted">生成于 ${esc(fmtDateTime(s.created_at))}</p></div>`).join('') || '<p class="muted">尚无历史摘要；上下文超过预算时按需生成。</p>'}
          <details><summary>查看版本与来源详情</summary><pre class="approval-preview">${esc(JSON.stringify(data, null, 2))}</pre></details>`;
      } else {
        const manifest = data.manifest;
        if (!manifest) { body.innerHTML = '<div class="empty-note">该历史会话暂无 Agent 版本绑定。首次续跑时会建立迁移清单。</div>'; return; }
        body.innerHTML = `<h3>Agent 版本与执行记录</h3><p class="muted">团队 ${esc(manifest.teamKey)}${manifest.migration ? ' · 迁移时绑定' : ''}</p>
          ${Object.entries(manifest.bindings || {}).map(([slot, b]) => `<div class="eval-card"><b>${esc(b.definition.name)}</b><p>${esc(b.key)}</p><small class="muted">${esc(slot)} · ${esc(b.reason)}</small></div>`).join('')}
          <h3>调用记录</h3>${(data.invocations || []).map((i) => `<div class="eval-card"><b>${esc(i.version_key)}</b><p>${esc({ running: '执行中', completed: '调用完成', failed: '调用失败' }[i.state] || i.state)} · ${esc(fmtDateTime(i.started_at))}</p>${i.error ? `<p class="muted">${esc(i.error)}</p>` : ''}</div>`).join('') || '<div class="empty-note">暂无调用记录</div>'}
          <details><summary>查看完整绑定与调用详情</summary><pre class="approval-preview">${esc(JSON.stringify(data, null, 2))}</pre></details>`;
      }
    } catch (error) { if (current()) { inspectorKey = ''; body.innerHTML = `<div class="empty-note">读取失败：${esc(error.message)}</div>`; } }
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    $('#app').classList.remove('drawer-open');
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
      const fieldLabels = { name: '姓名', contact: '联系方式', education: '教育背景', major: '所学专业', skills: '专业技能', projects: '项目经历', work_history: '工作经历', years_experience: '工作年限', expected_salary: '期望薪资' };
      const order = Object.keys(fieldLabels);
      const experienceOptional = /经验\s*(不限|不做要求|无要求)|应届/.test(state.snapshot?.job?.requirements || '');
      const hints = (detail.parse.anomalies || []).flatMap((a) => a.split(/[；;]/)).filter((a) => !(/缺少|缺失|未填写/.test(a) && (/expected_salary|期望薪资/.test(a) || experienceOptional && /work_history|years_experience|工作经历|工作年限/.test(a))));
      if (hints.length) parts.push(`<details class="resume-parse-notes"><summary>解析提示（${hints.length}）</summary><p class="muted">以下为提取结果提示，不代表候选人能力结论；排版问题请以原文件为准。</p><ul>${hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></details>`);
      const fields = [...detail.parse.fields].sort((a, b) => (order.includes(a.key) ? order.indexOf(a.key) : 99) - (order.includes(b.key) ? order.indexOf(b.key) : 99));
      parts.push(fields.filter((f) => String(f.value || '').trim()).map((field) => `<section class="eval-card resume-field">
        <div class="eval-head"><b>${esc(fieldLabels[field.key] || field.key)}</b><small class="muted">提取置信度 ${Math.round(Number(field.confidence || 0) * 100)}%</small></div>
        <div class="resume-field-value">${esc(String(field.value).replace(/；/g, '；\n'))}</div>
        ${(field.spans || []).length ? `<details class="resume-evidence"><summary>原文引用（${field.spans.length}）</summary>${field.spans.map((span) => `<blockquote class="evidence-quote">${esc(span.quote)}<small class="span-meta">文本位置 ${esc(span.charStart)}–${esc(span.charEnd)}</small></blockquote>`).join('')}</details>` : ''}
      </section>`).join(''));
      const missing = fields.filter((f) => !String(f.value || '').trim());
      if (missing.length) parts.push(`<details class="resume-parse-notes"><summary>未填写的信息（${missing.length}）</summary><p class="muted">未填写不等于不满足岗位要求，不自动扣分。</p>${missing.map((f) => `<span class="tag">${esc(fieldLabels[f.key] || f.key)}</span>`).join(' ')}</details>`);
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

    parts.push('<details class="resume-evidence"><summary>完整证据记录</summary>');
    parts.push(detail.evidence.length ? `<div class="table-wrap"><table><thead><tr><th>字段</th><th>引用</th><th>区间</th><th>状态</th></tr></thead><tbody>${detail.evidence.map((row) => `<tr><td>${esc(row.field)}</td><td>${esc(row.quote)}</td><td class="span-meta">${esc(row.charStart)}-${esc(row.charEnd)}</td><td><span class="tag ${row.verified ? 'ok' : 'warn'}">${esc(row.verdict)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-note">暂无证据</div>');
    parts.push('</details>');

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

  function refreshActiveModel() {
    const provider = state.providers.find((item) => item.id === state.activeProviderId);
    const modelId = provider?.proModel || provider?.flashModel || '';
    const model = provider?.models?.find((item) => item.id === modelId);
    state.activeModelId = modelId;
    state.activeModelName = model?.name?.trim() || modelId;
    // 输入区展示当前模型服务的名称（例如「千问」），而不是内部模型 ID。
    state.activeModel = provider?.name?.trim() || state.activeModelName;
    renderReplyModel();
  }

  function renderReplyModel() {
    const el = $('#reply-model');
    if (!el) return;
    const label = state.activeModel || '未选择模型';
    el.textContent = label;
    const detail = [state.activeModelName, state.activeModelId].filter((value, index, values) => value && values.indexOf(value) === index).join(' · ');
    el.title = detail ? `当前模型：${label} · ${detail}` : `当前模型：${label}`;
  }

  function syncProviders(data) {
    state.providers = data.providers || [];
    state.activeProviderId = data.activeId ?? null;
    state.config = { ...(state.config || {}), providers: state.providers, activeProviderId: state.activeProviderId };
    refreshActiveModel();
    renderProviders();
  }

  async function loadConfig() {
    try {
      state.config = await api('/api/config');
      state.providers = state.config.providers || [];
      state.activeProviderId = state.config.activeProviderId ?? null;
      refreshActiveModel();
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

  function openSettings(tab = 'models') {
    $('#settings-modal').classList.remove('hidden');
    $('#provider-editor').classList.add('hidden');
    closePluginEditor();
    state.editingProvider = null;
    switchSettingsTab(tab);
  }

  function closeSettings() {
    $('#settings-modal').classList.add('hidden');
    $('#provider-editor').classList.add('hidden');
    closePluginEditor();
    state.editingProvider = null;
  }

  // ---------------------------------------------------------------- plugins (MCP)

  const PLUGIN_STATE = {
    ready: { label: '运行中', dot: 'completed' },
    starting: { label: '连接中', dot: 'running' },
    failed: { label: '失败', dot: 'failed' },
    stopped: { label: '已停止', dot: 'idle' },
    disabled: { label: '已停用', dot: 'idle' },
  };

  const SETTINGS_TABS = ['models', 'plugins', 'agents', 'memory'];

  function switchSettingsTab(tab) {
    state.settingsTab = SETTINGS_TABS.includes(tab) ? tab : 'models';
    $$('.settings-nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.settingsTab === state.settingsTab);
    });
    $('#settings-models').classList.toggle('hidden', state.settingsTab !== 'models');
    $('#settings-plugins').classList.toggle('hidden', state.settingsTab !== 'plugins');
    $('#agent-dialog').classList.toggle('hidden', state.settingsTab !== 'agents');
    $('#memory-dialog').classList.toggle('hidden', state.settingsTab !== 'memory');
    window.dispatchEvent(new CustomEvent('bole-settings-tab', { detail: state.settingsTab }));
    if (state.settingsTab === 'models') {
      renderProviders();
      loadProviders();
    } else if (state.settingsTab === 'plugins') {
      loadPlugins();
    }
  }

  function setPluginStatus(text, tone = '') {
    const el = $('#plugin-status');
    if (!el) return;
    el.textContent = text;
    el.className = `settings-status ${tone}`;
  }

  function pluginRuntime(plugin) {
    const server = (state.pluginStatus?.servers || []).find((item) => item.id === plugin.id);
    const stateName = !plugin.enabled ? 'disabled' : (server?.state || 'starting');
    const meta = PLUGIN_STATE[stateName] || PLUGIN_STATE.starting;
    return {
      state: stateName,
      label: meta.label,
      dot: meta.dot,
      tools: server?.tools || 0,
      error: server?.error || plugin.credentialError || '',
    };
  }

  function renderPlugins() {
    const list = $('#plugin-list');
    if (!list) return;
    const plugins = state.plugins || [];
    const enabled = [...plugins, ...state.skillPlugins].filter((plugin) => plugin.enabled).length;
    if ($('#plugin-summary')) {
      $('#plugin-summary').textContent = `${enabled}/${plugins.length + state.skillPlugins.length} 启用 · ${state.pluginStatus?.tools || 0} 个工具可用${state.pluginLoadError ? ' · 插件库异常' : ''}`;
    }
    if ($('#plugin-count')) $('#plugin-count').textContent = plugins.length ? `${plugins.length} 个` : '';

    if (state.pluginLoadError) {
      list.innerHTML = `<div class="empty-note">${esc(state.pluginLoadError)}</div>`;
    } else if (!plugins.length) {
      list.innerHTML = state.skillPlugins.length ? '' : '<div class="empty-note">还没有安装插件。点击「＋ 添加插件」，粘贴安装命令交给 Agent 处理。</div>';
    } else {
      list.innerHTML = plugins.map((plugin) => {
        const runtime = pluginRuntime(plugin);
        const target = plugin.transport === 'stdio'
          ? `${plugin.command || ''} ${(plugin.args || []).join(' ')}`.trim()
          : (plugin.url || '');
        return `<article class="plugin-row ${plugin.enabled ? '' : 'disabled'}" data-plugin-row="${esc(plugin.id)}">
          <label class="switch" title="${plugin.enabled ? '停用插件' : '启用插件'}">
            <input type="checkbox" data-plugin-toggle="${esc(plugin.id)}" ${plugin.enabled ? 'checked' : ''} ${state.pluginBusy ? 'disabled' : ''}>
            <span></span>
          </label>
          <div class="plugin-row-main">
            <div class="plugin-row-title">
              <span>${esc(plugin.name)}</span>
              <span class="tag">${esc(plugin.id)}</span>
              <span class="tag ${runtime.state === 'ready' ? 'ok' : runtime.state === 'failed' ? 'danger' : ''}">${esc(runtime.label)}${runtime.state === 'ready' ? ` · ${runtime.tools} 工具` : ''}</span>
              ${plugin.source === 'imported' ? '<span class="tag">导入</span>' : ''}
              ${plugin.hasCredentials ? '<span class="tag">已存凭据</span>' : ''}
            </div>
            <div class="plugin-row-meta" title="${esc(target)}">${esc(plugin.transport)} · ${esc(target || '—')} · 白名单 ${esc((plugin.allowTools || []).join(', ') || '*')}</div>
            ${runtime.error ? `<div class="plugin-row-error">${esc(runtime.error)}</div>` : ''}
          </div>
          <div class="plugin-row-actions">
            <button class="btn ghost" data-plugin-action="test" data-plugin-id="${esc(plugin.id)}" ${plugin.enabled ? '' : 'disabled'}>测试</button>
            <button class="btn ghost" data-plugin-action="edit" data-plugin-id="${esc(plugin.id)}">编辑</button>
            <button class="btn ghost danger-text" data-plugin-action="delete" data-plugin-id="${esc(plugin.id)}">删除</button>
          </div>
        </article>`;
      }).join('');
    }
  }

  function applyPlugins(data) {
    state.plugins = data.plugins || [];
    state.pluginStatus = data.status || null;
    state.pluginLoadError = data.loadError || '';
    renderPlugins();
  }

  async function loadPlugins() {
    try {
      applyPlugins(await api('/api/mcp/plugins'));
    } catch (error) {
      state.pluginLoadError = `读取插件失败：${error.message}`;
      renderPlugins();
      toast(`读取插件失败：${error.message}`, 'error');
    }
  }

  async function togglePlugin(id, enabled) {
    if (state.pluginBusy) return;
    state.pluginBusy = true;
    renderPlugins();
    try {
      applyPlugins(await api(`/api/mcp/plugins/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }));
      toast(enabled ? '插件已启用' : '插件已停用', 'ok');
    } catch (error) {
      toast(`切换失败：${error.message}`, 'error');
      await loadPlugins();
    } finally {
      state.pluginBusy = false;
      renderPlugins();
    }
  }

  async function handlePluginAction(action, id) {
    const plugin = (state.plugins || []).find((item) => item.id === id);
    if (!plugin) return;
    if (action === 'edit') { openPluginEditor(plugin); return; }
    if (action === 'delete') {
      if (!window.confirm(`确定删除插件「${plugin.name}」？其凭据会一并删除。`)) return;
      try {
        applyPlugins(await api(`/api/mcp/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }));
        toast('插件已删除', 'ok');
      } catch (error) {
        toast(`删除失败：${error.message}`, 'error');
      }
      return;
    }
    if (action === 'test') {
      try {
        const data = await api(`/api/mcp/plugins/${encodeURIComponent(id)}/test`, { method: 'POST' });
        applyPlugins(data);
        const result = data.result || {};
        toast(result.ok ? `连接成功：${(result.tools || []).length} 个工具（${result.latencyMs}ms）` : `连接失败：${result.error || result.state}`, result.ok ? 'ok' : 'error');
      } catch (error) {
        toast(`测试失败：${error.message}`, 'error');
      }
    }
  }

  function renderPluginEditorTransport() {
    const transport = $('#plugin-transport').value;
    $('#plugin-stdio-fields').classList.toggle('hidden', transport !== 'stdio');
    $('#plugin-http-fields').classList.toggle('hidden', transport !== 'http');
    $('#plugin-env-label').classList.toggle('hidden', transport !== 'stdio');
    $('#plugin-headers-label').classList.toggle('hidden', transport !== 'http');
  }

  function parseLines(text) {
    return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  }

  function parseList(text) {
    return String(text || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  function parseKeyValues(text) {
    const map = {};
    for (const line of parseLines(text)) {
      const index = line.indexOf('=');
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (!key || !value) continue;
      map[key] = value;
    }
    return map;
  }

  function openPluginEditor(plugin = null) {
    state.editingPlugin = plugin;
    state.pluginEnvDirty = false;
    state.pluginHeadersDirty = false;
    $('#plugin-editor').classList.remove('hidden');
    $('#plugin-editor-title').textContent = plugin ? `编辑插件 ${plugin.name}` : '添加 MCP 插件';
    $('#plugin-id').value = plugin?.id || '';
    $('#plugin-id').disabled = Boolean(plugin);
    $('#plugin-name').value = plugin?.name || '';
    $('#plugin-desc').value = plugin?.description || '';
    $('#plugin-transport').value = plugin?.transport || 'stdio';
    $('#plugin-enabled').checked = plugin ? plugin.enabled : true;
    $('#plugin-command').value = plugin?.command || '';
    $('#plugin-args').value = (plugin?.args || []).join('\n');
    $('#plugin-cwd').value = plugin?.cwd || '';
    $('#plugin-url').value = plugin?.url || '';
    $('#plugin-quiet').checked = Boolean(plugin?.quiet);
    $('#plugin-allow').value = (plugin?.allowTools || ['*']).join(', ');
    $('#plugin-deny').value = (plugin?.denyTools || []).join(', ');
    $('#plugin-start-timeout').value = plugin?.startTimeoutMs || 20000;
    $('#plugin-call-timeout').value = plugin?.callTimeoutMs || 60000;
    const envKeys = plugin ? (plugin.envKeys || []) : [];
    const headerKeys = plugin ? (plugin.headerKeys || []) : [];
    $('#plugin-env').value = envKeys.map((key) => `${key}=${plugin ? '***' : ''}`).join('\n');
    $('#plugin-headers').value = headerKeys.map((key) => `${key}=${plugin ? '***' : ''}`).join('\n');
    renderPluginEditorTransport();
    setPluginStatus(
      plugin ? '保存后立即生效；凭据保持 *** 或留空表示不修改。' : '保存后会立即尝试连接；失败只影响这个插件。',
      plugin ? 'ok' : 'warn',
    );
    $('#plugin-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closePluginEditor() {
    $('#plugin-editor').classList.add('hidden');
    state.editingPlugin = null;
    state.pluginEnvDirty = false;
    state.pluginHeadersDirty = false;
  }

  async function savePlugin() {
    const editing = state.editingPlugin;
    const transport = $('#plugin-transport').value;
    const body = {
      name: $('#plugin-name').value.trim(),
      description: $('#plugin-desc').value.trim(),
      transport,
      enabled: $('#plugin-enabled').checked,
      command: transport === 'stdio' ? $('#plugin-command').value.trim() : null,
      args: transport === 'stdio' ? parseLines($('#plugin-args').value) : [],
      cwd: $('#plugin-cwd').value.trim() || null,
      url: transport === 'http' ? $('#plugin-url').value.trim() : null,
      quiet: $('#plugin-quiet').checked,
      allowTools: parseList($('#plugin-allow').value),
      denyTools: parseList($('#plugin-deny').value),
      startTimeoutMs: Number($('#plugin-start-timeout').value) || 20000,
      callTimeoutMs: Number($('#plugin-call-timeout').value) || 60000,
    };
    if (!editing) body.id = $('#plugin-id').value.trim();
    if (transport === 'stdio' && (state.pluginEnvDirty || !editing)) body.env = parseKeyValues($('#plugin-env').value);
    if (transport === 'http' && (state.pluginHeadersDirty || !editing)) body.headers = parseKeyValues($('#plugin-headers').value);
    setPluginStatus('正在保存…');
    try {
      const data = editing
        ? await api(`/api/mcp/plugins/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/mcp/plugins', { method: 'POST', body: JSON.stringify(body) });
      applyPlugins(data);
      closePluginEditor();
      toast(editing ? '插件已保存' : '插件已安装', 'ok');
    } catch (error) {
      setPluginStatus(`保存失败：${error.message}`, 'error');
    }
  }

  async function testEditingPlugin() {
    const editing = state.editingPlugin;
    if (!editing) {
      setPluginStatus('先保存插件，再测试连接。', 'warn');
      return;
    }
    setPluginStatus('正在连接…');
    try {
      const data = await api(`/api/mcp/plugins/${encodeURIComponent(editing.id)}/test`, { method: 'POST' });
      applyPlugins(data);
      const result = data.result || {};
      setPluginStatus(
        result.ok ? `连接成功：${(result.tools || []).length} 个工具（${result.latencyMs}ms）` : `连接失败：${result.error || result.state}`,
        result.ok ? 'ok' : 'error',
      );
    } catch (error) {
      setPluginStatus(`测试失败：${error.message}`, 'error');
    }
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

  // ---------------------------------------------------------------- knowledge

  function setKnowledgeStatus(target, message, tone = '') {
    const el = $(target);
    if (!el) return;
    el.textContent = message || '';
    el.className = `settings-status ${tone}`;
  }

  async function openKnowledge() {
    $('#knowledge-modal').classList.remove('hidden');
    await loadKnowledge();
  }

  function closeKnowledge() {
    $('#knowledge-modal').classList.add('hidden');
  }

  async function loadKnowledge() {
    try {
      const data = await api('/api/knowledge');
      state.knowledgeBases = data.bases || [];
      state.knowledgeSettings = data.settings || null;
      if (!state.knowledgeBases.some((base) => base.id === state.selectedKnowledgeBaseId)) {
        state.selectedKnowledgeBaseId = state.knowledgeBases[0]?.id ?? '';
      }
      renderKnowledge();
      if (state.selectedKnowledgeBaseId) await loadKnowledgeDocuments(state.selectedKnowledgeBaseId);
    } catch (error) {
      toast(`读取知识库失败：${error.message}`, 'error');
    }
  }

  function formatKnowledgeSize(chars) {
    const value = Number(chars) || 0;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} 字符`;
  }

  function formatKnowledgeRelative(value) {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return '—';
    const diff = Math.max(0, Date.now() - time);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    return `${Math.floor(diff / day)} 天前`;
  }

  function renderKnowledgeTags(base) {
    if (!base) return;
    const formats = [...new Set(state.knowledgeDocs.map((document) => String(document.format || '').toUpperCase()).filter(Boolean))];
    const tags = [
      base.enabled ? '自动检索' : '未启用',
      ...formats,
      `${base.documentCount ?? state.knowledgeDocs.length} 份文档`,
    ];
    $('#kb-tags').innerHTML = tags.map((tag) => `<span class="knowledge-tag">${esc(tag)}</span>`).join('');
  }

  function renderKnowledgeStats(stats) {
    const value = stats || {};
    const cards = [
      [value.sources ?? 0, '来源项'],
      [value.parsedDocuments ?? 0, '已解析文档'],
      [value.chunks ?? 0, '分块'],
      [Number(value.tokens ?? 0).toLocaleString(), '≈ Token'],
      [formatKnowledgeSize(value.chars ?? 0), '字符'],
      [value.embeddedChunks ? '✓' : '0', '已向量化'],
      [value.embeddingDimensions ? `${value.embeddingDimensions}d` : '—', '向量维度'],
    ];
    $('#kb-stats').innerHTML = cards.map(([number, label]) => `
      <div class="knowledge-stat"><b>${esc(number)}</b><span>${esc(label)}</span></div>`).join('');
  }

  function renderKnowledge() {
    const bases = state.knowledgeBases;
    $('#knowledge-base-list').innerHTML = bases.length ? bases.map((base) => `
      <div class="knowledge-base-item ${base.id === state.selectedKnowledgeBaseId ? 'active' : ''}" data-kb-id="${esc(base.id)}">
        <div class="kb-name"><span class="dot ${base.enabled ? 'enabled' : ''}"></span>${esc(base.name)}</div>
        <div class="kb-meta">${base.enabled ? '已启用 · ' : '未启用 · '}${base.documentCount} 份文档 · ${base.chunkCount} 块</div>
      </div>`).join('') : '<div class="empty-note">还没有知识库</div>';
    const selected = bases.find((base) => base.id === state.selectedKnowledgeBaseId);
    $('#knowledge-empty').classList.toggle('hidden', Boolean(selected));
    $('#knowledge-detail').classList.toggle('hidden', !selected);
    if (selected) {
      $('#kb-title').textContent = selected.name || '知识库';
      $('#kb-name').value = selected.name;
      $('#kb-description').value = selected.description;
      $('#kb-enabled').checked = selected.enabled;
      const roles = { coordinator: '伯乐 · 主 Agent', profiler: '画像师', parser: '录事 · 解析', assessor: '相马官 · 评估', auditor: '监军 · 核查' };
      $('#kb-agent-roles').innerHTML = Object.entries(roles).map(([id, name]) => `<label><input type="checkbox" value="${id}" ${(selected.agentRoles || ['assessor']).includes(id) ? 'checked' : ''}>${name}</label>`).join('');
      renderKnowledgeTags(selected);
      renderKnowledgeStats(state.knowledgeStats || {
        sources: selected.documentCount,
        parsedDocuments: selected.documentCount,
        chunks: selected.chunkCount,
        chars: 0,
        tokens: 0,
        embeddedChunks: 0,
        embeddingDimensions: 0,
      });
    }
    if (state.knowledgeSettings) {
      const settings = state.knowledgeSettings;
      $('#kb-embedding-provider').value = settings.embeddingProvider || 'none';
      $('#kb-embedding-model').value = settings.embeddingModel || '';
      $('#kb-embedding-url').value = settings.embeddingBaseUrl || '';
      $('#kb-embedding-key').value = '';
      $('#kb-embedding-key').placeholder = settings.hasEmbeddingKey ? '留空使用已保存凭据' : '输入 API Key（可选）';
      $('#kb-rerank-model').value = settings.rerankModel || '';
      $('#kb-rerank-url').value = settings.rerankBaseUrl || '';
      $('#kb-rerank-key').value = '';
      $('#kb-rerank-key').placeholder = settings.hasRerankKey ? '留空使用已保存凭据' : '输入 API Key（可选）';
      $('#kb-top-k').value = settings.topK;
      $('#kb-chunk-size').value = settings.chunkSize;
      $('#kb-chunk-overlap').value = settings.chunkOverlap;
      $('#kb-max-context').value = settings.maxContextChars;
      $('#kb-auto-recall').checked = settings.autoRecall;
      $('#kb-smart-chunk').checked = settings.smartChunk;
      $('#knowledge-embedding-notice').classList.toggle('hidden', settings.embeddingProvider !== 'none');
    }
  }

  async function loadKnowledgeDocuments(baseId) {
    try {
      const data = await api(`/api/knowledge/bases/${encodeURIComponent(baseId)}/documents`);
      state.knowledgeDocs = data.documents || [];
      state.knowledgeStats = data.stats || null;
      const base = state.knowledgeBases.find((item) => item.id === baseId);
      renderKnowledgeTags(base);
      renderKnowledgeStats(state.knowledgeStats);
      const latest = state.knowledgeDocs.reduce((value, document) => (
        !value || String(document.createdAt) > String(value) ? document.createdAt : value
      ), '');
      $('#kb-updated').textContent = latest ? `更新于 ${formatKnowledgeRelative(latest)}` : '上传后会立即解析并索引';
      $('#kb-documents').innerHTML = state.knowledgeDocs.length ? state.knowledgeDocs.map((document) => {
        const status = document.status === 'active' ? '就绪' : document.status || '处理中';
        const tone = document.status === 'active' ? 'ok' : document.warning ? 'warn' : '';
        return `<tr>
          <td>
            <div class="knowledge-doc-name" title="${esc(document.filename)}">${esc(document.title)}</div>
            <div class="knowledge-doc-sub">${document.chars.toLocaleString()} 字符</div>
          </td>
          <td><span class="knowledge-type">${esc(String(document.format || '文件').toUpperCase())}</span></td>
          <td><span class="knowledge-status ${tone}"><i></i>${esc(status)}</span></td>
          <td class="knowledge-time">${esc(formatKnowledgeRelative(document.createdAt))}</td>
          <td><button class="knowledge-row-action" type="button" title="删除文档" data-kb-delete-doc="${esc(document.id)}">⋯</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="5" class="knowledge-table-empty">还没有文档；上传后才会被检索。</td></tr>';
    } catch (error) {
      setKnowledgeStatus('#kb-doc-status', `读取文档失败：${error.message}`, 'error');
    }
  }

  async function createKnowledgeBase() {
    const input = $('#kb-new-name');
    const name = input.value.trim();
    if (!name) {
      toast('请先填写知识库名称', 'error');
      input.focus();
      return;
    }
    try {
      const data = await api('/api/knowledge/bases', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      state.selectedKnowledgeBaseId = data.base?.id ?? '';
      input.value = '';
      $('#knowledge-create-form').classList.add('hidden');
      await loadKnowledge();
      toast(data.warning ?? '知识库已创建；启用后才会参与自动检索', data.warning ? 'warn' : 'ok');
    } catch (error) {
      toast(`创建失败：${error.message}`, 'error');
    }
  }

  async function saveKnowledgeBase(enabledOverride) {
    const base = state.knowledgeBases.find((item) => item.id === state.selectedKnowledgeBaseId);
    if (!base) return;
    const agentRoles = [...$('#kb-agent-roles').querySelectorAll('input:checked')].map((input) => input.value);
    try {
      const data = await api(`/api/knowledge/bases/${encodeURIComponent(base.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#kb-name').value.trim(),
          description: $('#kb-description').value.trim(),
          enabled: enabledOverride ?? $('#kb-enabled').checked,
          agentRoles,
        }),
      });
      if (!Array.isArray(data.base?.agentRoles)) throw new Error('当前后端不支持角色配置，请重启伯乐服务后重试');
      if (JSON.stringify([...data.base.agentRoles].sort()) !== JSON.stringify([...agentRoles].sort())) {
        throw new Error('角色配置未保存成功，请重试');
      }
      await loadKnowledge();
      setKnowledgeStatus('#kb-status', data.base?.enabled ? '已保存：仅适用 Agent 自动检索' : '已保存（未启用，不参与检索）', 'ok');
    } catch (error) {
      setKnowledgeStatus('#kb-status', `保存失败：${error.message}`, 'error');
    }
  }

  async function deleteKnowledgeBase() {
    const base = state.knowledgeBases.find((item) => item.id === state.selectedKnowledgeBaseId);
    if (!base || !window.confirm(`确定删除知识库「${base.name}」及其全部文档？`)) return;
    try {
      await api(`/api/knowledge/bases/${encodeURIComponent(base.id)}`, { method: 'DELETE' });
      state.selectedKnowledgeBaseId = '';
      await loadKnowledge();
      toast('知识库已删除', 'ok');
    } catch (error) {
      toast(`删除失败：${error.message}`, 'error');
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadKnowledgeDocuments(files) {
    const base = state.knowledgeBases.find((item) => item.id === state.selectedKnowledgeBaseId);
    if (!base) { toast('请先选择知识库', 'error'); return; }
    if (!files.length) return;
    let uploaded = 0;
    for (const file of files) {
      setKnowledgeStatus('#kb-doc-status', `正在处理 ${file.name}…`);
      try {
        await api(`/api/knowledge/bases/${encodeURIComponent(base.id)}/documents`, {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            contentBase64: await fileToBase64(file),
          }),
        });
        uploaded += 1;
      } catch (error) {
        setKnowledgeStatus('#kb-doc-status', `${file.name} 失败：${error.message}`, 'error');
      }
    }
    await loadKnowledge();
    if (uploaded) {
      setKnowledgeStatus('#kb-doc-status', `已索引 ${uploaded} 份文档`, 'ok');
      toast(`已上传 ${uploaded} 份知识库文档`, 'ok');
    }
  }

  async function saveKnowledgeSettings() {
    try {
      const body = {
        embeddingProvider: $('#kb-embedding-provider').value,
        embeddingModel: $('#kb-embedding-model').value.trim(),
        embeddingBaseUrl: $('#kb-embedding-url').value.trim(),
        rerankModel: $('#kb-rerank-model').value.trim(),
        rerankBaseUrl: $('#kb-rerank-url').value.trim(),
        topK: Number($('#kb-top-k').value),
        chunkSize: Number($('#kb-chunk-size').value),
        chunkOverlap: Number($('#kb-chunk-overlap').value),
        maxContextChars: Number($('#kb-max-context').value),
        autoRecall: $('#kb-auto-recall').checked,
        smartChunk: $('#kb-smart-chunk').checked,
      };
      const embeddingKey = $('#kb-embedding-key').value.trim();
      const rerankKey = $('#kb-rerank-key').value.trim();
      if (embeddingKey) body.embeddingApiKey = embeddingKey;
      if (rerankKey) body.rerankApiKey = rerankKey;
      const data = await api('/api/knowledge/settings', { method: 'PATCH', body: JSON.stringify(body) });
      state.knowledgeSettings = data.settings;
      renderKnowledge();
      setKnowledgeStatus('#kb-settings-status', '设置已保存；分块设置只影响新上传文档', 'ok');
      return true;
    } catch (error) {
      setKnowledgeStatus('#kb-settings-status', `保存失败：${error.message}`, 'error');
      return false;
    }
  }

  async function testKnowledgeEmbedding() {
    if (!(await saveKnowledgeSettings())) return;
    setKnowledgeStatus('#kb-settings-status', '正在测试嵌入连接…');
    try {
      const data = await api('/api/knowledge/test-embedding', { method: 'POST' });
      const result = data.result || {};
      setKnowledgeStatus('#kb-settings-status', result.ok ? `连接正常：${result.model}（${result.dimensions} 维）` : `失败：${result.error || '未知错误'}`, result.ok ? 'ok' : 'error');
    } catch (error) {
      const message = error.message || '';
      setKnowledgeStatus('#kb-settings-status', /未知接口|Not Found|404/.test(message) ? '服务端还是旧版本：请重启 pnpm web 后刷新页面' : `测试失败：${message}`, 'error');
    }
  }

  async function loadEmbeddingModels() {
    if (!(await saveKnowledgeSettings())) return;
    setKnowledgeStatus('#kb-settings-status', '正在获取模型列表…');
    try {
      const data = await api('/api/knowledge/embedding-models');
      const models = data.models || [];
      $('#kb-embedding-models').innerHTML = models.map((model) => `<option value="${esc(model)}"></option>`).join('');
      const current = $('#kb-embedding-model').value.trim();
      if (models.length && (!current || !models.includes(current))) {
        $('#kb-embedding-model').value = models[0];
        setKnowledgeStatus('#kb-settings-status', `发现 ${models.length} 个模型，已选择 ${models[0]}；可测试或修改`, 'ok');
        return;
      }
      setKnowledgeStatus('#kb-settings-status', models.length ? `发现 ${models.length} 个嵌入模型` : '没有获取到模型，请检查服务地址/Key', models.length ? 'ok' : 'warn');
    } catch (error) {
      const message = error.message || '';
      setKnowledgeStatus('#kb-settings-status', /未知接口|Not Found|404/.test(message) ? '服务端还是旧版本：请重启 pnpm web 后刷新页面' : `获取模型失败：${message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- init

  function bind() {
    bindSidebarResize();
    bindContentResize();
    bindPreviewResize();
    bindDrawerResize();
    $('#chat-scroll').addEventListener('click', (event) => {
      const card = event.target.closest('[data-preview-file]');
      if (!card || event.target.closest('.file-download')) return;
      openFilePreview(card.getAttribute('data-preview-file'));
    });
    $('#chat-scroll').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-preview-file]');
      if (!card) return;
      event.preventDefault();
      openFilePreview(card.getAttribute('data-preview-file'));
    });
    $('#file-preview-close').addEventListener('click', closeFilePreview);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#preview-pane').classList.contains('hidden')) closeFilePreview();
    });
    $('#new-run-btn').addEventListener('click', showNewView);
    $('#mail-test').addEventListener('click', async () => {
      $('#mail-status').textContent = '正在检查…';
      try { const data = await api('/api/mail/status'); $('#mail-status').textContent = data.mailbox || data.error || '尚未授权'; }
      catch (error) { $('#mail-status').textContent = error.message; }
    });
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
    const modeTrigger = $('#mode-trigger');
    $$('.composer-picker').forEach((picker) => {
      const select = picker.querySelector('select');
      const trigger = picker.querySelector('button');
      const menu = picker.querySelector('[role="menu"]');
      const close = () => { menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); };
      const refresh = () => {
        const selected = select.selectedOptions[0];
        const text = selected?.textContent || picker.dataset.pickerLabel;
        trigger.querySelector('.picker-label').textContent = select.id === 'new-policy-version' && !select.value ? '评分标准' : text;
        trigger.title = `${picker.dataset.pickerLabel}：${text}`;
        trigger.setAttribute('aria-label', trigger.title);
        menu.replaceChildren();
        for (const option of select.options) {
          const group = option.parentElement;
          if (group.tagName === 'OPTGROUP' && group.firstElementChild === option) {
            const heading = document.createElement('div'); heading.className = 'picker-group'; heading.textContent = group.label; menu.append(heading);
          }
          const button = document.createElement('button'); button.type = 'button';
          button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(option.selected)); button.disabled = option.disabled;
          const label = document.createElement('span'); label.textContent = option.textContent;
          const check = document.createElement('span'); check.className = 'mode-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
          button.append(label, check); menu.append(button);
          button.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); close(); trigger.focus(); });
        }
      };
      const open = () => {
        refresh(); menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true');
        menu.style.left = '0'; menu.style.right = 'auto';
        if (menu.getBoundingClientRect().right > window.innerWidth - 12) { menu.style.left = 'auto'; menu.style.right = '0'; }
        menu.querySelector('[aria-checked="true"]')?.focus();
      };
      trigger.addEventListener('click', () => { if (menu.classList.contains('hidden')) open(); else close(); });
      select.addEventListener('change', refresh);
      new MutationObserver(refresh).observe(select, { childList: true, subtree: true });
      document.addEventListener('click', (event) => { if (!picker.contains(event.target)) close(); });
      document.addEventListener('focusin', (event) => { if (!picker.contains(event.target)) close(); });
      picker.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (menu.classList.contains('hidden')) { open(); return; }
        const options = [...menu.querySelectorAll('button:not(:disabled)')];
        if (!options.length) return;
        const index = options.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      });
      refresh();
    });
    const modeMenu = $('#mode-menu');
    const modeItems = [...modeMenu.querySelectorAll('[data-mode]')];
    const setModeMenu = (open, focus = false) => {
      modeMenu.classList.toggle('hidden', !open);
      modeTrigger.setAttribute('aria-expanded', String(open));
      if (open && focus) modeItems.find((item) => item.getAttribute('aria-checked') === 'true').focus();
    };
    modeTrigger.addEventListener('click', () => setModeMenu(modeMenu.classList.contains('hidden'), true));
    modeItems.forEach((item) => item.addEventListener('click', () => {
      $('#new-execution-mode').value = item.dataset.mode;
      $('#mode-label').textContent = item.dataset.mode === 'strict' ? '严格模式' : '默认模式';
      modeItems.forEach((option) => option.setAttribute('aria-checked', String(option === item)));
      setModeMenu(false);
      modeTrigger.focus();
    }));
    document.addEventListener('click', (event) => { if (!event.target.closest('.mode-picker')) setModeMenu(false); });
    document.addEventListener('focusin', (event) => { if (!event.target.closest('.mode-picker')) setModeMenu(false); });
    modeTrigger.parentElement.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { setModeMenu(false); modeTrigger.focus(); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (modeMenu.classList.contains('hidden')) { setModeMenu(true, true); return; }
        const index = modeItems.indexOf(document.activeElement);
        modeItems[(index + (event.key === 'ArrowDown' ? 1 : -1) + modeItems.length) % modeItems.length].focus();
      }
    });
    const help = $('#help-dialog');
    window.addEventListener('bole-help-open', (event) => {
      if (!help.open) help.showModal();
      const button = [...help.querySelectorAll('[data-help]')].find((item) => item.dataset.help === event.detail);
      button?.click();
    });
    $('#help-open').addEventListener('click', () => help.showModal());
    $('#help-close').addEventListener('click', () => help.close());
    help.addEventListener('click', (event) => {
      const rect = help.getBoundingClientRect();
      if (event.target === help && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) help.close();
    });
    help.querySelectorAll('[data-help]').forEach((button) => button.addEventListener('click', () => {
      help.querySelectorAll('[data-help]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
      help.querySelectorAll('[data-help-section]').forEach((section) => section.classList.toggle('hidden', section.dataset.helpSection !== button.dataset.help));
    }));
    $('#panel-btn').addEventListener('click', () => openDrawer(state.drawerTab || 'candidates'));
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#drawer-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-drawer-tab]');
      if (button) { state.drawerCandidate = null; openDrawer(button.dataset.drawerTab); }
    });
    $('#reply-send').addEventListener('click', async () => {
      const button = $('#reply-send');
      if (button.disabled) return;
      state.controlPending = true;
      button.disabled = true;
      try {
        if (button.dataset.action === 'pause') await pauseCurrent();
        else if (button.dataset.action === 'resume') await resumeCurrent();
        else if (button.dataset.action === 'send') await sendReply();
      } finally { state.controlPending = false; syncReplyComposerState(); }
    });
    $('#chat-attach-btn').addEventListener('click', () => $('#chat-file-input').click());
    $('#chat-file-input').addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      await uploadChatFiles(files);
    });
    $('#reply-input').addEventListener('input', syncReplyComposerState);
    $('#reply-input').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.shiftKey) {
        document.execCommand('insertLineBreak');
        return;
      }
      sendReply();
    });
    $('#reply-input').addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    });
    $('#open-settings').addEventListener('click', openSettings);
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#settings-close').addEventListener('click', closeSettings);
    $('#agent-close').addEventListener('click', closeSettings);
    $('#memory-close').addEventListener('click', closeSettings);
    $('#provider-add').addEventListener('click', () => openProviderEditor(null));
    $$('.settings-nav-item').forEach((button) => {
      button.addEventListener('click', () => switchSettingsTab(button.dataset.settingsTab));
    });
    $('#plugins-close').addEventListener('click', closeSettings);
    $('#plugin-add').addEventListener('click', () => window.dispatchEvent(new CustomEvent('bole-plugin-add')));
    window.addEventListener('bole-plugin-manual', (event) => { if (event.detail === 'mcp') openPluginEditor(null); });
    window.addEventListener('bole-plugins-refresh', () => { void loadPlugins(); });
    window.addEventListener('bole-skills-updated', (event) => { state.skillPlugins = event.detail; renderPlugins(); });
    $('#plugin-refresh').addEventListener('click', loadPlugins);
    $('#plugin-save').addEventListener('click', savePlugin);
    $('#plugin-cancel').addEventListener('click', closePluginEditor);
    $('#plugin-test').addEventListener('click', testEditingPlugin);
    $('#plugin-transport').addEventListener('change', renderPluginEditorTransport);
    $('#plugin-env').addEventListener('input', () => { state.pluginEnvDirty = true; });
    $('#plugin-headers').addEventListener('input', () => { state.pluginHeadersDirty = true; });
    $('#plugin-id').addEventListener('input', (event) => {
      event.target.value = event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    });
    $('#plugin-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-plugin-action]');
      if (button) handlePluginAction(button.dataset.pluginAction, button.dataset.pluginId);
    });
    $('#plugin-list').addEventListener('change', (event) => {
      const input = event.target.closest('[data-plugin-toggle]');
      if (input) togglePlugin(input.dataset.pluginToggle, input.checked);
    });
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
    $('#open-knowledge').addEventListener('click', openKnowledge);
    $('#knowledge-close').addEventListener('click', closeKnowledge);
    $('#knowledge-new').addEventListener('click', () => {
      $('#knowledge-create-form').classList.remove('hidden');
      $('#kb-new-name').focus();
    });
    $('#kb-new-create').addEventListener('click', createKnowledgeBase);
    $('#kb-new-cancel').addEventListener('click', () => {
      $('#knowledge-create-form').classList.add('hidden');
      $('#kb-new-name').value = '';
    });
    $('#kb-new-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); createKnowledgeBase(); }
    });
    $('#kb-save').addEventListener('click', () => saveKnowledgeBase());
    $('#kb-delete').addEventListener('click', deleteKnowledgeBase);
    $('#kb-upload').addEventListener('click', () => $('#knowledge-file').click());
    $('#knowledge-file').addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      await uploadKnowledgeDocuments(files);
    });
    $('#kb-enabled').addEventListener('change', (event) => saveKnowledgeBase(event.target.checked));
    $('#knowledge-base-list').addEventListener('click', (event) => {
      const item = event.target.closest('[data-kb-id]');
      if (!item) return;
      state.selectedKnowledgeBaseId = item.getAttribute('data-kb-id');
      renderKnowledge();
      loadKnowledgeDocuments(state.selectedKnowledgeBaseId);
    });
    $('#kb-documents').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-kb-delete-doc]');
      if (!button) return;
      const id = button.getAttribute('data-kb-delete-doc');
      if (!window.confirm('确定删除这份知识库文档？')) return;
      try {
        await api(`/api/knowledge/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadKnowledge();
        toast('文档已删除', 'ok');
      } catch (error) {
        setKnowledgeStatus('#kb-doc-status', `删除失败：${error.message}`, 'error');
      }
    });
    $('#kb-settings-save').addEventListener('click', saveKnowledgeSettings);
    $('#kb-model-refresh').addEventListener('click', loadEmbeddingModels);
    $('#kb-test-embedding').addEventListener('click', testKnowledgeEmbedding);
    $('#kb-embedding-provider').addEventListener('change', (event) => {
      const url = $('#kb-embedding-url');
      const current = url.value.trim();
      if (!current || current === 'http://127.0.0.1:11434' || current === 'https://api.openai.com/v1') {
        url.value = event.target.value === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11434';
      }
    });
    $('#chat-scroll').addEventListener('click', (event) => {
      const row = event.target.closest('[data-candidate]');
      if (row) { openDrawer('candidates', false); openCandidate(row.getAttribute('data-candidate')); }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#help-dialog').open) { closeSettings(); closeKnowledge(); closeDrawer(); }
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
    await loadKnowledge();
    if (window.location.hash === '#plugins') {
      openSettings('plugins');
      return;
    }
    if (window.location.hash === '#knowledge') {
      await openKnowledge();
      return;
    }
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
