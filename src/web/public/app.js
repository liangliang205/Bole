(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const SETTINGS_KEY = 'bole.web.settings';
  const KEY_KEY = 'bole.deepseekApiKey';
  const AGENT_NAMES = {
    coordinator: '伯乐',
    profiler: '画像师',
    fetcher: '探马',
    parser: '录事',
    assessor: '相马官',
    auditor: '监军',
    advisor: '谋士',
  };
  const STATUS_LABEL = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    idle: '未完成',
  };
  const RESUME_STATUS_LABEL = {
    queued: '待解析',
    parsing: '解析中',
    parsed: '已解析',
    evaluating: '评估中',
    evaluated: '已评估',
    verifying: '核查中',
    verified: '已核查',
    reported: '已上报',
    quarantine: '转人工',
    failed: '失败',
    duplicate: '重复',
  };

  const state = {
    jobId: '',
    jobs: [],
    run: null,
    snapshot: null,
    config: null,
    events: [],
    seen: new Set(),
    lastSeq: 0,
    timer: null,
    polling: false,
    tab: 'timeline',
    candidates: [],
    candidatesLoaded: false,
    candidateFilter: 'all',
    cost: null,
    complianceLoaded: false,
    hitlId: '',
    eventFilter: '',
    settings: loadSettings(),
    inspectorId: '',
  };

  function loadSettings() {
    const defaults = {
      llm: 'mock',
      seed: 'demo-2026',
      mcp: 'in-process',
      faults: 'on',
      key: localStorage.getItem(KEY_KEY) || '',
    };
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { ...defaults, ...raw, key: localStorage.getItem(KEY_KEY) || '' };
    } catch {
      return defaults;
    }
  }

  function persistSettings() {
    const { key, ...rest } = state.settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
    if (key) localStorage.setItem(KEY_KEY, key);
    else localStorage.removeItem(KEY_KEY);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function safeJson(value) {
    try {
      return JSON.parse(value || '{}');
    } catch {
      return {};
    }
  }

  function fmtTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(11, 19);
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtScore(value) {
    return value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(1);
  }

  function jobTitle(job) {
    const title = String(job.title || '').trim();
    if (title && title !== '待画像岗位') return title;
    const requirements = String(job.requirements || '').trim();
    return requirements ? requirements.slice(0, 30) : '未命名任务';
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
    el._timer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = { ok: false, error: `HTTP ${response.status}` };
    }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `请求失败（${response.status}）`);
    }
    return data;
  }

  // ---------------------------------------------------------------- jobs list

  function renderJobs() {
    const keyword = $('#job-search').value.trim().toLowerCase();
    const jobs = state.jobs.filter((job) => {
      if (!keyword) return true;
      return `${jobTitle(job)} ${job.requirements} ${job.id}`.toLowerCase().includes(keyword);
    });
    const list = $('#job-list');
    if (jobs.length === 0) {
      list.innerHTML = `<div class="empty-note">${state.jobs.length ? '没有匹配的任务' : '还没有任务，点击上方新建'}</div>`;
    } else {
      list.innerHTML = jobs.map((job) => {
        const status = job.activeStatus || 'idle';
        return `<button class="job-item ${job.id === state.jobId ? 'active' : ''}" data-job="${esc(job.id)}">
          <div class="job-line">
            <span class="dot ${esc(status)}"></span>
            <span class="job-name">${esc(jobTitle(job))}</span>
            <span class="job-time">${esc(fmtDateTime(job.createdTs))}</span>
          </div>
          <div class="job-meta">
            <span>${job.total} 份</span>
            <span class="ok-text">通过 ${job.verified}</span>
            <span>转人工 ${job.quarantine}</span>
            ${job.failed ? `<span class="danger-text">失败 ${job.failed}</span>` : ''}
          </div>
        </button>`;
      }).join('');
    }
    $('#job-count').textContent = state.jobs.length ? `${state.jobs.length} 个` : '';
    renderRecent();
  }

  function renderRecent() {
    const container = $('#recent-jobs');
    if (!state.jobs.length) {
      container.innerHTML = '<div class="empty-note">暂无任务，先在上方发起一次筛选</div>';
      return;
    }
    container.innerHTML = state.jobs.slice(0, 8).map((job) => {
      const status = job.activeStatus || 'idle';
      return `<button class="recent-card" data-job="${esc(job.id)}">
        <div class="rc-title">${esc(jobTitle(job))}</div>
        <div class="rc-meta">${esc(STATUS_LABEL[status] || status)} · ${job.total} 份 · 通过 ${job.verified} · ${esc(fmtDateTime(job.createdTs))}</div>
      </button>`;
    }).join('');
  }

  async function loadJobs() {
    try {
      const data = await api('/api/jobs');
      state.jobs = data.jobs || [];
      renderJobs();
      return state.jobs;
    } catch (error) {
      toast(`读取任务列表失败：${error.message}`, 'error');
      return [];
    }
  }

  // ---------------------------------------------------------------- run view

  function showNewView() {
    stopPolling();
    state.jobId = '';
    state.run = null;
    state.snapshot = null;
    state.events = [];
    state.seen.clear();
    state.lastSeq = 0;
    state.candidates = [];
    state.candidatesLoaded = false;
    state.cost = null;
    state.complianceLoaded = false;
    state.hitlId = '';
    history.replaceState(null, '', '#new');
    $('#empty-view').classList.remove('hidden');
    $('#run-view').classList.add('hidden');
    closeInspector();
    $('#job-title').textContent = 'BoLe 控制台';
    $('#job-sub').textContent = '新建任务，或从左侧选择历史任务';
    setStatusPill('idle');
    renderJobs();
    setTimeout(() => $('#new-requirements')?.focus(), 30);
  }

  function setStatusPill(status) {
    const el = $('#status-pill');
    el.className = `pill ${status}`;
    el.textContent = STATUS_LABEL[status] || status;
  }

  function showRunView() {
    $('#empty-view').classList.add('hidden');
    $('#run-view').classList.remove('hidden');
  }

  async function selectJob(jobId) {
    if (!jobId) {
      showNewView();
      return;
    }
    state.jobId = jobId;
    state.events = [];
    state.seen.clear();
    state.lastSeq = 0;
    state.candidates = [];
    state.candidatesLoaded = false;
    state.cost = null;
    state.complianceLoaded = false;
    state.hitlId = '';
    state.run = null;
    state.snapshot = null;
    history.replaceState(null, '', `#job=${encodeURIComponent(jobId)}`);
    showRunView();
    closeInspector();
    switchTab('timeline');
    renderJobs();
    await loadRun(true);
  }

  async function loadRun(resetEvents) {
    if (!state.jobId) return;
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}`);
      state.run = data.run;
      state.snapshot = data.snapshot;
      if (resetEvents) {
        state.events = [];
        state.seen.clear();
        state.lastSeq = 0;
        await loadEvents();
      } else {
        await loadEvents();
      }
      applyRun();
    } catch (error) {
      toast(`读取任务失败：${error.message}`, 'error');
      setStatusPill('failed');
    }
  }

  function applyRun() {
    if (!state.run || !state.snapshot) return;
    const run = state.run;
    const snapshot = state.snapshot;
    const job = snapshot.job || {};
    $('#job-title').textContent = jobTitle(job);
    const subParts = [
      `job=${run.jobId}`,
      run.runId ? `run=${run.runId}` : '',
      `provider=${run.provider || '—'}`,
      run.status === 'running' ? '执行中…' : '',
      run.error ? `错误：${run.error}` : '',
    ].filter(Boolean);
    $('#job-sub').textContent = subParts.join(' · ');
    setStatusPill(run.status);
    renderKpis(snapshot);
    renderPipeline(snapshot, run.status);
    renderHitl(run.pendingHitl);
    const reportBtn = $('#report-btn');
    reportBtn.disabled = !run.reportAvailable;
    reportBtn.title = run.reportAvailable ? '打开完整报告' : '报告尚未生成';
    $('#resume-btn').disabled = run.status === 'running';
    $('#live-dot').className = `live-dot ${run.status === 'running' ? '' : 'off'}`;
    if (run.status === 'running') startPolling();
    else stopPolling();
    if (state.tab === 'candidates' && state.candidatesLoaded) renderCandidates();
    if (state.tab === 'cost') loadCost();
  }

  function renderKpis(snapshot) {
    const counts = snapshot.resumeCounts || {};
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    const parsed = Number(snapshot.parseCounts?.committed || 0);
    const screen = Number(snapshot.evalPhaseCounts?.screen || 0);
    const deep = Number(snapshot.evalPhaseCounts?.deep || 0);
    const verified = Number(counts.verified || 0) + Number(counts.reported || 0);
    const quarantine = Number(counts.quarantine || 0);
    const failed = Number(counts.failed || 0);
    const duplicate = Number(counts.duplicate || 0);
    const cards = [
      ['简历', total, ''],
      ['解析完成', parsed, 'ok'],
      ['flash 初筛', screen, 'ok'],
      ['pro 深评', deep, ''],
      ['核查通过', verified, 'ok'],
      ['转人工', quarantine, quarantine ? 'warn' : ''],
      ['重复', duplicate, ''],
      ['失败', failed, failed ? 'danger' : ''],
    ];
    $('#kpis').innerHTML = cards.map(([label, value, tone]) =>
      `<div class="kpi ${tone}"><span>${esc(label)}</span><b>${value}</b></div>`).join('');
  }

  function renderPipeline(snapshot, status) {
    const counts = snapshot.resumeCounts || {};
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    const parsed = Number(snapshot.parseCounts?.committed || 0);
    const screen = Number(snapshot.evalPhaseCounts?.screen || 0);
    const deep = Number(snapshot.evalPhaseCounts?.deep || 0);
    const review = Number(snapshot.reviewTotal || 0);
    const verified = Number(counts.verified || 0) + Number(counts.reported || 0);
    const quarantine = Number(counts.quarantine || 0);
    const stages = [
      ['接入', total],
      ['解析', parsed],
      ['初筛', screen],
      ['深评', deep],
      ['核查', review],
      ['通过', verified],
      ['转人工', quarantine],
    ];
    let activeIndex = -1;
    if (status === 'running') {
      activeIndex = stages.findIndex(([, value]) => value === 0);
      if (activeIndex < 0) activeIndex = stages.length - 1;
    }
    $('#pipeline').innerHTML = stages.map(([name, value], index) => {
      const classes = [];
      if (value > 0) classes.push('done');
      if (index === activeIndex) classes.push('active');
      return `<div class="stage ${classes.join(' ')}"><div class="stage-name">${esc(name)}</div><div class="stage-count">${value}</div></div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- polling

  function startPolling() {
    stopPolling();
    state.timer = setInterval(pollOnce, 900);
  }

  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function pollOnce() {
    if (state.polling || !state.jobId) return;
    if (!state.run || state.run.status !== 'running') return;
    state.polling = true;
    try {
      await loadEvents();
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}`);
      state.run = data.run;
      state.snapshot = data.snapshot;
      applyRun();
      if (state.run.status !== 'running') {
        await loadEvents();
        await loadJobs();
        if (state.tab === 'candidates' && state.candidatesLoaded) await loadCandidates(true);
        if (state.tab === 'cost') await loadCost(true);
        if (state.tab === 'compliance') await loadCompliance(true);
        toast(`任务${state.run.status === 'completed' ? '已完成' : '已失败'}${state.run.error ? `：${state.run.error}` : ''}`, state.run.status === 'completed' ? 'ok' : 'error');
      }
    } catch (error) {
      // 轮询期间静默失败，下一轮重试
    } finally {
      state.polling = false;
    }
  }

  // ---------------------------------------------------------------- events

  async function loadEvents() {
    if (!state.jobId) return;
    let guard = 0;
    while (guard < 10) {
      guard += 1;
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/events?sinceSeq=${state.lastSeq}&limit=200`);
      const events = data.events || [];
      if (!events.length) break;
      for (const event of events) {
        const seq = Number(event.seq || 0);
        if (state.seen.has(seq)) continue;
        state.seen.add(seq);
        state.events.push(event);
        state.lastSeq = Math.max(state.lastSeq, seq);
      }
      if (events.length < 200) break;
    }
    if (state.events.length > 3000) state.events = state.events.slice(-3000);
    renderEvents();
  }

  function eventView(event) {
    const payload = event.payload || {};
    const label = payload.label ? String(payload.label) : '';
    const score = payload.totalScore !== undefined && payload.totalScore !== null
      ? Number(payload.totalScore).toFixed(1)
      : null;
    switch (event.type) {
      case 'run.created':
        return { icon: '▶', tone: 'info', title: '运行已创建', detail: `provider=${payload.provider} · seed=${payload.seed}` };
      case 'profiler.started':
        return { icon: '◇', tone: 'info', title: '需求画像开始', detail: `需求 ${payload.requirementsChars ?? '—'} 字符` };
      case 'hitl.question':
        return { icon: '?', tone: 'warn', title: 'HITL 反问', detail: String(payload.question || '') };
      case 'hitl.answered':
        return { icon: '✓', tone: 'ok', title: 'HITL 已确认', detail: `${payload.answer}（${payload.actor}）` };
      case 'jd.analyzed':
        return { icon: '◇', tone: 'ok', title: `JD 已结构化：${payload.title || ''}`, detail: `${payload.dimensions} 个评分维度 · 剥离受保护条件 ${payload.removedProtected} 项` };
      case 'mcp.connected':
        return { icon: '⇄', tone: 'info', title: 'MCP 已连接', detail: `transport=${payload.transport}` };
      case 'resume.fetched':
        return { icon: '↓', tone: 'ok', title: `${label} 简历接入`, detail: `${payload.format} · ${payload.chars} 字符` };
      case 'resume.duplicate':
        return { icon: '≋', tone: 'warn', title: `${label} 重复投递`, detail: `与 ${payload.duplicateOf} 的指纹一致` };
      case 'resume.fetch_failed':
        return { icon: '✕', tone: 'danger', title: `${label} 接入失败`, detail: String(payload.reason || '') };
      case 'fetch.completed':
        return { icon: '✓', tone: 'ok', title: '简历接入完成', detail: `成功 ${payload.pulled} · 重复 ${payload.duplicates} · 失败 ${payload.failed}` };
      case 'batch.started':
        return { icon: '▦', tone: 'info', title: `第 ${payload.batchId} 批进入流水线`, detail: `${payload.size} 份` };
      case 'parse.started':
        return { icon: '⌁', tone: 'info', title: `${label} 解析开始`, detail: String(payload.workerId || '') };
      case 'parse.committed':
        return { icon: '✓', tone: 'ok', title: `${label} 解析完成`, detail: `${payload.fields} 个字段` };
      case 'parse.failed':
        return { icon: '✕', tone: 'danger', title: `${label} 解析失败`, detail: String((payload.errors || [])[0] || '') };
      case 'batch.parsed':
        return { icon: '▦', tone: 'info', title: `第 ${payload.batchId} 批解析完成`, detail: `${payload.parsed} 成功 · ${payload.failed} 失败` };
      case 'batch.screened':
        return { icon: '▦', tone: 'info', title: `第 ${payload.batchId} 批初筛完成`, detail: `${payload.screened} 人进入评估` };
      case 'deep_eval.shortlist':
        return { icon: '◆', tone: 'warn', title: `第 ${payload.batchId} 批深评短名单`, detail: `${payload.count} 人 · Top ${payload.percent}% + 异常 · ${payload.tier}` };
      case 'eval.started':
        return { icon: '◈', tone: 'info', title: `${label} ${payload.phase === 'deep' ? 'pro 深评' : payload.phase === 'revise' ? '返工评估' : 'flash 初筛'}开始`, detail: `第 ${payload.loopIndex} 轮 · ${payload.workerId}` };
      case 'eval.committed':
        return { icon: '✓', tone: 'ok', title: `${label} 评估完成 ${score ? `${score} 分` : ''}`, detail: `${payload.conclusion} · ${payload.tier}/${payload.phase}` };
      case 'deep_eval.completed':
        return { icon: '◆', tone: 'ok', title: `${label} pro 深评完成`, detail: `${score} 分` };
      case 'deep_eval.failed':
        return { icon: '!', tone: 'warn', title: `${label} 深评失败`, detail: '回退 flash 结果' };
      case 'review.started':
        return { icon: '◇', tone: 'info', title: `${label} 证据核查开始`, detail: `第 ${payload.loopCount} 轮` };
      case 'review.verdict':
        return {
          icon: payload.verdict === 'pass' ? '✓' : '!',
          tone: payload.verdict === 'pass' ? 'ok' : payload.verdict === 'escalate_human' ? 'danger' : 'warn',
          title: `${label} 核查裁决 ${payload.verdict}`,
          detail: `支持 ${payload.supported} 条 · 未通过 ${payload.failed} 条 · 风险 ${payload.risk}`,
        };
      case 'selfloop.revise':
        return { icon: '↻', tone: 'warn', title: `${label} 验真环打回重评`, detail: `第 ${payload.loop} 轮 · 沿用 ${payload.workerId} · ${payload.tier}` };
      case 'worker.reused':
        return { icon: '↻', tone: 'info', title: `${label} 续用同一评估 Worker`, detail: String(payload.workerId || '') };
      case 'escalate.human':
        return { icon: '⇧', tone: 'danger', title: `${label} 转人工`, detail: String(payload.reason || '') };
      case 'candidate.processed':
        return {
          icon: payload.status === 'verified' ? '✓' : payload.status === 'escalated' ? '⇧' : '·',
          tone: payload.status === 'verified' ? 'ok' : payload.status === 'escalated' ? 'warn' : 'info',
          title: `${label} 批次处理结果：${payload.status}`,
          detail: `${payload.score !== null && payload.score !== undefined ? `${fmtScore(payload.score)} 分` : ''}${payload.tier ? ` · ${payload.tier}/${payload.phase}` : ''}`,
        };
      case 'batch.completed':
        return { icon: '▦', tone: 'info', title: `第 ${payload.batchId} 批完成`, detail: `评估 ${payload.evaluated} · 深评 ${payload.deep}` };
      case 'hitl.final_confirmation':
        return { icon: '✓', tone: 'warn', title: 'HITL 终稿确认', detail: String(payload.answer || '') };
      case 'report.generated':
        return { icon: '▤', tone: 'ok', title: `报告已生成（${payload.status}）`, detail: Array.isArray(payload.top) ? payload.top.join(' · ') : '' };
      case 'run.completed':
        return { icon: '★', tone: 'ok', title: '运行完成', detail: `耗时 ${payload.durationMs}ms · 成本 $${Number(payload.usage?.costUsd ?? 0).toFixed(4)}` };
      case 'run.failed':
        return { icon: '✕', tone: 'danger', title: '运行失败', detail: String(payload.error || '') };
      case 'recovery.resume_reset':
        return { icon: '↺', tone: 'warn', title: `检查点恢复：${label}`, detail: `${payload.from} → ${payload.to}` };
      case 'recovery.task_aborted':
        return { icon: '↺', tone: 'warn', title: '检查点恢复：中止未提交任务', detail: `${payload.kind}/${String(payload.taskId || '').slice(0, 20)}` };
      default:
        return { icon: '·', tone: 'info', title: event.type, detail: JSON.stringify(payload).slice(0, 180) };
    }
  }

  function renderEvents() {
    const container = $('#events');
    if (!container) return;
    const keyword = state.eventFilter.trim().toLowerCase();
    const events = state.events.filter((event) => {
      if (!keyword) return true;
      const view = eventView(event);
      return `${event.actor} ${event.type} ${view.title} ${view.detail}`.toLowerCase().includes(keyword);
    });
    if (events.length === 0) {
      container.innerHTML = `<div class="empty-note">${state.events.length ? '没有匹配的事件' : '等待事件…'}</div>`;
      return;
    }
    container.innerHTML = events.slice(-400).map((event) => {
      const view = eventView(event);
      return `<div class="event ${view.tone}">
        <div class="event-icon">${esc(view.icon)}</div>
        <div class="event-body">
          <div class="event-head">
            <span class="agent-badge">${esc(agentName(event.actor))}</span>
            <span class="event-title">${esc(view.title)}</span>
            <span class="event-time">${esc(fmtTime(event.ts))}</span>
          </div>
          ${view.detail ? `<div class="event-detail">${esc(view.detail)}</div>` : ''}
          <details class="event-raw"><summary>payload</summary><pre>${esc(JSON.stringify(event.payload || {}, null, 1))}</pre></details>
        </div>
      </div>`;
    }).join('');
    if ($('#autoscroll').checked) container.scrollTop = container.scrollHeight;
  }

  // ---------------------------------------------------------------- HITL

  function renderHitl(pending) {
    const host = $('#hitl-host');
    if (!pending) {
      host.innerHTML = '';
      state.hitlId = '';
      return;
    }
    if (state.hitlId === pending.id && host.querySelector('.hitl-card')) return;
    state.hitlId = pending.id;
    host.innerHTML = `<div class="hitl-card">
      <h3>需要你确认 · ${esc(pending.node || 'HITL')}</h3>
      <div class="hitl-question">${esc(pending.question)}</div>
      <div class="hitl-options">
        ${(pending.options || []).map((option, index) =>
          `<button class="hitl-option" data-hitl-index="${index}">${esc(option)}${option === pending.recommendedOption ? '（推荐）' : ''}</button>`).join('')}
      </div>
      <div class="hitl-custom">
        <input id="hitl-custom" class="input" placeholder="或输入自定义回答">
        <button class="btn primary" id="hitl-submit">提交</button>
      </div>
    </div>`;
    host.querySelectorAll('[data-hitl-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.getAttribute('data-hitl-index'));
        submitHitl(pending.options[index]);
      });
    });
    $('#hitl-submit').addEventListener('click', () => {
      const value = $('#hitl-custom').value.trim();
      if (!value) {
        toast('请输入自定义回答', 'error');
        return;
      }
      submitHitl(value);
    });
  }

  async function submitHitl(answer) {
    if (!state.jobId || !answer) return;
    try {
      await api(`/api/run/${encodeURIComponent(state.jobId)}/hitl`, {
        method: 'POST',
        body: JSON.stringify({ answer, actor: 'HR(web)' }),
      });
      state.hitlId = '';
      toast('已提交 HITL 回答', 'ok');
      await pollOnce();
      await loadRun(false);
    } catch (error) {
      toast(`提交失败：${error.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- candidates

  async function loadCandidates(force = false) {
    if (!state.jobId) return;
    if (state.candidatesLoaded && !force) return;
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/candidates`);
      state.candidates = data.candidates || [];
      state.candidatesLoaded = true;
      renderCandidates();
    } catch (error) {
      toast(`读取候选人失败：${error.message}`, 'error');
    }
  }

  function statusClass(status) {
    if (status === 'verified' || status === 'reported') return 'ok';
    if (status === 'quarantine' || status === 'failed') return 'danger';
    if (status === 'duplicate') return 'warn';
    return '';
  }

  function renderCandidates() {
    const container = $('#candidate-table');
    if (!state.candidates.length) {
      container.innerHTML = '<div class="empty-note">暂无候选人数据</div>';
      return;
    }
    const filter = state.candidateFilter;
    const rows = state.candidates.filter((candidate) => {
      if (filter === 'all') return true;
      if (filter === 'reported') return candidate.status === 'reported' || candidate.status === 'verified';
      return candidate.status === filter;
    });
    if (!rows.length) {
      container.innerHTML = '<div class="empty-note">没有符合筛选条件的候选人</div>';
      return;
    }
    container.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>候选人</th><th>格式</th><th>状态</th><th>得分</th><th>评估档位</th><th>核查</th><th>批次</th><th>说明</th></tr></thead>
      <tbody>${rows.map((candidate) => `<tr class="clickable" data-resume="${esc(candidate.resumeId)}">
        <td><b>${esc(candidate.label)}</b></td>
        <td>${esc(candidate.format)}</td>
        <td><span class="tag ${statusClass(candidate.status)}">${esc(RESUME_STATUS_LABEL[candidate.status] || candidate.status)}</span></td>
        <td>${esc(fmtScore(candidate.score))}</td>
        <td>${candidate.evalTier ? `<span class="tag ${candidate.evalTier === 'pro' ? 'deep' : ''}">${esc(candidate.evalTier)} / ${esc(candidate.evalPhase || '—')}</span>` : '—'}</td>
        <td>${candidate.reviewVerdict ? `<span class="tag ${candidate.reviewVerdict === 'pass' ? 'ok' : candidate.reviewVerdict === 're_eval' ? 'warn' : 'danger'}">${esc(candidate.reviewVerdict)}${candidate.loopCount ? ` · ${candidate.loopCount} 轮` : ''}</span>` : '—'}</td>
        <td>${candidate.batchId ?? '—'}</td>
        <td class="muted">${esc((candidate.reasons || []).slice(-1)[0] || '')}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
    container.querySelectorAll('tr[data-resume]').forEach((row) => {
      row.addEventListener('click', () => openCandidate(row.getAttribute('data-resume')));
    });
  }

  // ---------------------------------------------------------------- inspector

  function closeInspector() {
    $('#inspector').classList.add('hidden');
    $('#app').classList.remove('inspector-open');
    state.inspectorId = '';
  }

  async function openCandidate(resumeId) {
    if (!state.jobId) return;
    state.inspectorId = resumeId;
    $('#inspector').classList.remove('hidden');
    $('#app').classList.add('inspector-open');
    $('#inspector-title').textContent = '加载中…';
    $('#inspector-body').innerHTML = '<div class="empty-note">正在读取证据链…</div>';
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/candidates/${encodeURIComponent(resumeId)}`);
      renderInspector(data.candidate);
    } catch (error) {
      $('#inspector-body').innerHTML = `<div class="empty-note">读取失败：${esc(error.message)}</div>`;
    }
  }

  function renderInspector(detail) {
    $('#inspector-title').textContent = `${detail.resume.label} · ${RESUME_STATUS_LABEL[detail.resume.status] || detail.resume.status}`;
    const parts = [];
    parts.push(`<div class="kv">
      <dt>格式 / 批次</dt><dd>${esc(detail.resume.format)} · 第 ${detail.resume.batchId ?? '—'} 批</dd>
      <dt>候选人 ID</dt><dd>${esc(detail.resume.id)}</dd>
      ${(detail.resume.reasons || []).length ? `<dt>说明</dt><dd>${esc(detail.resume.reasons.join('；'))}</dd>` : ''}
    </div>`);

    parts.push('<h4>解析字段与证据</h4>');
    if (!detail.parse) {
      parts.push('<div class="empty-note">没有已提交的解析结果</div>');
    } else {
      parts.push((detail.parse.anomalies || []).length
        ? `<div class="hint">异常标记：${esc(detail.parse.anomalies.join('；'))}</div>`
        : '');
      parts.push(detail.parse.fields.map((field) => {
        const spans = field.spans.map((span) =>
          `<div class="evidence-quote">「${esc(span.quote)}」<div class="span-meta">${esc(span.charStart)}-${esc(span.charEnd)} · ${esc(span.field)}</div></div>`).join('');
        return `<div class="eval-card">
          <div class="eval-head"><b>${esc(field.key)}</b><span class="tag">conf ${esc(field.confidence)}</span></div>
          <div style="margin-top:4px">${esc(field.value)}</div>
          ${spans || '<div class="hint">无证据 span</div>'}
        </div>`;
      }).join(''));
    }

    parts.push('<h4>评估历史</h4>');
    if (!detail.evaluations.length) {
      parts.push('<div class="empty-note">没有评估结果</div>');
    } else {
      parts.push(detail.evaluations.map((evaluation) => {
        const dims = evaluation.dimensions.map((dim) =>
          `<tr><td>${esc(dim.name || dim.key)}</td><td>${esc(dim.weight)}%</td><td>${esc(fmtScore(dim.score))}</td><td>${esc(dim.rationale)}</td></tr>`).join('');
        const dimSpans = evaluation.dimensions.flatMap((dim) => dim.spans || []).slice(0, 8).map((span) =>
          `<div class="evidence-quote">「${esc(span.quote)}」<div class="span-meta">${esc(span.charStart)}-${esc(span.charEnd)}</div></div>`).join('');
        return `<div class="eval-card">
          <div class="eval-head">
            <span class="eval-score">${esc(fmtScore(evaluation.totalScore))}</span>
            <span class="tag ${evaluation.tier === 'pro' ? 'deep' : ''}">${esc(evaluation.tier || '—')} / ${esc(evaluation.phase || '—')}</span>
            <span class="tag ${evaluation.conclusion === 'strong_yes' || evaluation.conclusion === 'yes' ? 'ok' : ''}">${esc(evaluation.conclusion || '—')}</span>
            ${evaluation.revisionOf ? '<span class="tag warn">返工版本</span>' : ''}
          </div>
          ${dims ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>维度</th><th>权重</th><th>分</th><th>理由</th></tr></thead><tbody>${dims}</tbody></table></div>` : ''}
          ${dimSpans}
          ${(evaluation.uncertainties || []).length ? `<div class="hint">不确定：${esc(evaluation.uncertainties.join('；'))}</div>` : ''}
          ${(evaluation.revisionNotes || []).length ? `<div class="hint">修正记录：${esc(evaluation.revisionNotes.join('；'))}</div>` : ''}
        </div>`;
      }).join(''));
    }

    parts.push('<h4>核查记录</h4>');
    if (!detail.reviews.length) {
      parts.push('<div class="empty-note">没有核查记录</div>');
    } else {
      parts.push(detail.reviews.map((review) => {
        const checks = review.checks.map((check) => `<tr>
          <td><span class="tag ${check.verdict === 'supported' ? 'ok' : check.verdict === 'missing_evidence' ? 'warn' : 'danger'}">${esc(check.verdict)}</span></td>
          <td>${esc(check.claim)}</td><td>${esc(check.note)}</td>
        </tr>`).join('');
        return `<div class="eval-card">
          <div class="eval-head">
            <span class="tag ${review.verdict === 'pass' ? 'ok' : review.verdict === 're_eval' ? 'warn' : 'danger'}">${esc(review.verdict || '—')}</span>
            <span class="muted">第 ${review.loopCount} 轮</span>
            <span class="muted">合规风险 ${esc(review.compliance?.risk || 'none')}</span>
          </div>
          ${checks ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>裁决</th><th>结论</th><th>说明</th></tr></thead><tbody>${checks}</tbody></table></div>` : ''}
          ${(review.requiredFixes || []).length ? `<div class="hint">修正要求：${esc(review.requiredFixes.join('；'))}</div>` : ''}
          ${review.escalationReason ? `<div class="hint">转人工原因：${esc(review.escalationReason)}</div>` : ''}
        </div>`;
      }).join(''));
    }

    parts.push('<h4>证据表</h4>');
    if (!detail.evidence.length) {
      parts.push('<div class="empty-note">暂无证据记录</div>');
    } else {
      parts.push(`<div class="table-wrap"><table><thead><tr><th>字段</th><th>引用</th><th>区间</th><th>状态</th></tr></thead><tbody>
        ${detail.evidence.map((row) => `<tr>
          <td>${esc(row.field)}</td>
          <td>${esc(row.quote)}</td>
          <td class="span-meta">${esc(row.charStart)}-${esc(row.charEnd)}</td>
          <td><span class="tag ${row.verified ? 'ok' : 'warn'}">${esc(row.verdict)}</span></td>
        </tr>`).join('')}
      </tbody></table></div>`);
    }

    $('#inspector-body').innerHTML = parts.join('');
  }

  // ---------------------------------------------------------------- compliance

  async function loadCompliance(force = false) {
    if (!state.jobId) return;
    if (state.complianceLoaded && !force) return;
    await loadCandidates();
    await loadRun(false);
    const job = state.snapshot?.job || {};
    const fairness = safeJson(job.fairness_json);
    const removed = Array.isArray(fairness.removed) ? fairness.removed : [];
    const findings = Array.isArray(fairness.findings) ? fairness.findings : [];
    const counts = state.snapshot?.reviewCounts || {};
    const summary = state.snapshot?.resumeCounts || {};
    const totalReviews = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    const veto = totalReviews ? ((Number(counts.re_eval || 0) + Number(counts.escalate_human || 0)) / totalReviews) : 0;
    const duplicates = state.candidates.filter((candidate) => candidate.status === 'duplicate');
    const failed = state.candidates.filter((candidate) => candidate.status === 'failed');
    const decisions = state.snapshot?.decisionList || [];

    const fairnessHtml = removed.length
      ? `<div class="table-wrap"><table><thead><tr><th>原始条件</th><th>类别</th><th>处理</th></tr></thead><tbody>${removed.map((item) =>
          `<tr><td>${esc(item.text)}</td><td>${esc(item.category)}</td><td>${esc(item.action)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">需求中未发现受保护属性条件。</p>';

    $('#compliance').innerHTML = `<div class="card-grid">
      <div class="info-card">
        <h3>公平性（反歧视）</h3>
        ${fairnessHtml}
        ${findings.length ? `<ul>${findings.map((finding) => `<li>${esc(finding)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="info-card">
        <h3>核查统计</h3>
        <div class="stat-line"><span>核查总数</span><b>${totalReviews}</b></div>
        <div class="stat-line"><span>pass / re_eval / escalate</span><b>${counts.pass || 0} / ${counts.re_eval || 0} / ${counts.escalate_human || 0}</b></div>
        <div class="stat-line"><span>否决率</span><b>${(veto * 100).toFixed(1)}%</b></div>
        <div class="bar"><i style="width:${Math.min(100, veto * 100).toFixed(1)}%"></i></div>
        <p class="muted" style="margin-top:8px">验真环重评 ${state.snapshot?.selfLoop?.revisions || 0} 次；转人工 ${state.snapshot?.selfLoop?.escalations || 0} 人。</p>
      </div>
      <div class="info-card">
        <h3>数据与隐私</h3>
        <p class="muted">报告与日志中的姓名/手机号/邮箱/身份证号均已脱敏；台账只保存 PII 哈希；原文仅存于受控运行目录。</p>
        <div class="stat-line"><span>重复投递</span><b>${duplicates.length}</b></div>
        <div class="stat-line"><span>失败</span><b>${failed.length}</b></div>
      </div>
      <div class="info-card">
        <h3>重复投递</h3>
        ${duplicates.length ? `<ul>${duplicates.map((candidate) => `<li><b>${esc(candidate.label)}</b>：${esc((candidate.reasons || []).slice(-1)[0] || '重复')}</li>`).join('')}</ul>` : '<p class="muted">未发现重复投递。</p>'}
      </div>
      <div class="info-card">
        <h3>失败明细</h3>
        ${failed.length ? `<ul>${failed.map((candidate) => `<li><b>${esc(candidate.label)}</b>：${esc((candidate.reasons || []).slice(-1)[0] || '失败')}</li>`).join('')}</ul>` : '<p class="muted">没有失败项。</p>'}
      </div>
      <div class="info-card">
        <h3>HITL 决策记录</h3>
        ${decisions.length ? `<div class="table-wrap"><table><thead><tr><th>节点</th><th>回答</th><th>操作者</th></tr></thead><tbody>${decisions.map((decision) =>
          `<tr><td>${esc(decision.node)}</td><td>${esc(decision.answer)}</td><td>${esc(decision.actor)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">暂无 HITL 决策。</p>'}
      </div>
    </div>`;
    state.complianceLoaded = true;
  }

  // ---------------------------------------------------------------- cost

  async function loadCost(force = false) {
    if (!state.jobId) return;
    if (state.cost && !force) {
      renderCost();
      return;
    }
    try {
      const data = await api(`/api/run/${encodeURIComponent(state.jobId)}/cost`);
      state.cost = data;
      renderCost();
    } catch (error) {
      toast(`读取成本失败：${error.message}`, 'error');
    }
  }

  function renderCost() {
    const container = $('#cost');
    const data = state.cost;
    if (!data) {
      container.innerHTML = '<div class="empty-note">正在读取成本数据…</div>';
      return;
    }
    const totals = data.totals || {};
    const report = data.report || null;
    const cost = report?.cost || null;
    const usage = data.usage || [];
    const usageRows = usage.map((row) => `<tr>
      <td>${esc(row.agent)}</td><td>${esc(row.model)}</td><td>${esc(row.tier)}</td>
      <td>${esc(row.calls)}</td><td>${esc(row.promptTokens)}</td><td>${esc(row.completionTokens)}</td>
      <td>${esc(row.cachedTokens)}</td><td>${Number(row.costUsd || 0).toFixed(6)}</td>
    </tr>`).join('');
    const stageRows = cost?.byStage?.map((row) => `<tr><td>${esc(row.stage)}</td><td>${esc(row.calls)}</td><td>${esc(row.promptTokens)}</td><td>${esc(row.completionTokens)}</td><td>${Number(row.costUsd || 0).toFixed(6)}</td></tr>`).join('') || '';
    const poolRows = report?.pools?.map((pool) => `<tr><td>${esc(pool.name)}</td><td>${esc(pool.capacity)}</td><td>${esc(pool.peak)}</td><td>${esc(pool.acquired)}</td><td>${esc(pool.refused)}</td><td>${esc(pool.timeouts)}</td></tr>`).join('') || '';
    container.innerHTML = `
      <div class="cost-total">
        <div><span class="muted">模型调用</span><b>${totals.calls || 0}</b></div>
        <div><span class="muted">输入 tokens</span><b>${totals.promptTokens || 0}</b></div>
        <div><span class="muted">输出 tokens</span><b>${totals.completionTokens || 0}</b></div>
        <div><span class="muted">缓存命中</span><b>${totals.cachedTokens || 0}</b></div>
        <div><span class="muted">成本 USD</span><b>$${Number(totals.costUsd || 0).toFixed(6)}</b></div>
      </div>
      <div class="info-card">
        <h3>按 Agent 汇总</h3>
        ${usage.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>模型</th><th>档位</th><th>调用</th><th>输入</th><th>输出</th><th>缓存</th><th>成本</th></tr></thead><tbody>${usageRows}</tbody></table></div>` : '<p class="muted">暂无模型调用记录。</p>'}
      </div>
      ${cost ? `<div class="info-card" style="margin-top:12px">
        <h3>缓存前缀对齐（报告实测）</h3>
        <div class="stat-line"><span>输入 / 缓存 / 输出</span><b>${cost.promptTokens} / ${cost.cachedTokens} / ${cost.completionTokens}</b></div>
        <div class="stat-line"><span>命中率</span><b>${(Number(cost.cacheHitRate || 0) * 100).toFixed(1)}%</b></div>
        <div class="stat-line"><span>成本 / 无缓存基线 / 节省</span><b>$${Number(cost.costUsd || 0).toFixed(6)} / $${Number(cost.baselineCostUsd || 0).toFixed(6)} / $${Number(cost.cacheSavingsUsd || 0).toFixed(6)}</b></div>
        <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>阶段</th><th>调用</th><th>输入</th><th>输出</th><th>成本</th></tr></thead><tbody>${stageRows}</tbody></table></div>
        ${poolRows ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>容量池</th><th>容量</th><th>峰值</th><th>获取</th><th>拒绝</th><th>超时</th></tr></thead><tbody>${poolRows}</tbody></table></div>` : ''}
      </div>` : '<div class="info-card" style="margin-top:12px"><h3>详细报表</h3><p class="muted">运行完成后会生成 cost-report.md 与完整报告，可在此查看缓存与调度统计。</p></div>'}
      <p class="muted" style="margin-top:10px">说明：mock 模式下 token 与成本为确定性估算；真实模式取 API 返回的 usage 与缓存命中。mock 对档位不敏感，成本差异只反映路由与调用次数。</p>`;
  }

  // ---------------------------------------------------------------- actions

  async function startNewRun() {
    const requirements = $('#new-requirements').value.trim();
    if (requirements.length < 5) {
      showNewHint('请填写至少 5 个字符的招聘需求', true);
      return;
    }
    const button = $('#new-start');
    button.disabled = true;
    showNewHint('正在创建任务并启动流水线…');
    try {
      const llm = $('#new-llm').value;
      state.settings.llm = llm;
      persistSettings();
      updateEnvLine();
      const data = await api('/api/run', {
        method: 'POST',
        body: JSON.stringify({
          requirements,
          llm,
          deepseekApiKey: state.settings.key || '',
          seed: state.settings.seed || 'web-seed',
          mcpMode: state.settings.mcp,
          withFaults: state.settings.faults === 'on',
        }),
      });
      showNewHint('');
      state.jobId = data.jobId;
      await loadJobs();
      await selectJob(data.jobId);
      toast('任务已启动', 'ok');
    } catch (error) {
      showNewHint(`启动失败：${error.message}`, true);
      toast(`启动失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function showNewHint(message, isError = false) {
    const hint = $('#new-hint');
    hint.textContent = message;
    hint.className = `hint ${isError ? 'error' : ''}`;
  }

  async function resumeCurrent() {
    if (!state.jobId) return;
    if (state.run?.status === 'running') {
      toast('任务正在运行', 'error');
      return;
    }
    try {
      await api(`/api/run/${encodeURIComponent(state.jobId)}/resume`, {
        method: 'POST',
        body: JSON.stringify({
          llm: state.settings.llm,
          deepseekApiKey: state.settings.key || '',
          withFaults: state.settings.faults === 'on',
        }),
      });
      state.events = [];
      state.seen.clear();
      state.lastSeq = 0;
      state.hitlId = '';
      await loadJobs();
      await loadRun(true);
      toast('已从检查点续跑', 'ok');
    } catch (error) {
      toast(`续跑失败：${error.message}`, 'error');
    }
  }

  function openReport() {
    if (!state.jobId) return;
    if (!state.run?.reportAvailable) {
      toast('报告尚未生成', 'error');
      return;
    }
    window.open(`/api/run/${encodeURIComponent(state.jobId)}/report`, '_blank');
  }

  // ---------------------------------------------------------------- tabs

  function switchTab(tab) {
    state.tab = tab;
    $$('#tabs .tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    ['timeline', 'candidates', 'compliance', 'cost', 'tools'].forEach((name) => {
      $(`#tab-${name}`).classList.toggle('hidden', name !== tab);
    });
    if (tab === 'candidates') loadCandidates();
    if (tab === 'compliance') loadCompliance();
    if (tab === 'cost') loadCost();
  }

  // ---------------------------------------------------------------- tools

  async function runTool(tool) {
    const output = $('#tool-output');
    output.innerHTML = '<div class="empty-note">正在执行…</div>';
    try {
      if (tool === 'agents') {
        const data = await api('/api/agents');
        output.innerHTML = `<div class="info-card"><h3>Agent preset 注册表</h3>
          <p class="muted">version=${esc(data.version)} · fingerprint=${esc(data.fingerprint)}</p>
          <div class="table-wrap"><table><thead><tr><th>id</th><th>名称</th><th>档位</th><th>maxDepth</th><th>schema</th><th>工具</th></tr></thead><tbody>
          ${data.agents.map((agent) => `<tr><td>${esc(agent.id)}</td><td>${esc(agent.nameZh)}</td><td>${esc(agent.tier)}</td><td>${esc(agent.maxDepth)}</td><td>${esc(agent.outputSchema)}</td><td>${esc(agent.tools.join(', '))}</td></tr>`).join('')}
          </tbody></table></div></div>`;
      } else if (tool === 'doctor') {
        const data = await api('/api/doctor');
        output.innerHTML = `<div class="info-card"><h3>环境自检</h3><ul>${data.checks.map((check) =>
          `<li><span class="tag ${check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'danger'}">${esc(check.status)}</span> ${esc(check.name)} — ${esc(check.detail)}</li>`).join('')}</ul></div>`;
      } else if (tool === 'seed') {
        if (!window.confirm('重新生成 20 份黄金简历？会覆盖 data/inbox。')) return;
        const data = await api('/api/seed', { method: 'POST' });
        toast(`已生成 ${data.messages} 封邮件`, 'ok');
        output.innerHTML = `<div class="info-card"><h3>黄金简历集</h3><p>${esc(data.messages)} 封邮件 → ${esc(data.inboxDir)}</p></div>`;
        await loadJobs();
      } else if (tool === 'bench') {
        const data = await api('/api/bench', { method: 'POST', body: JSON.stringify({ items: 60, latency: 8 }) });
        output.innerHTML = `<div class="info-card"><h3>调度并发扫描</h3><p class="muted">items=${data.items} · 模拟时延=${data.latency}ms · 并发提升 ${data.speedup}×</p>
          <div class="table-wrap"><table><thead><tr><th>并发度</th><th>吞吐(项/秒)</th><th>总耗时(ms)</th><th>P50</th><th>P95</th><th>成功</th></tr></thead><tbody>
          ${data.rows.map((row) => `<tr><td>${row.concurrency}</td><td>${row.throughput}</td><td>${row.totalMs}</td><td>${row.p50Ms}</td><td>${row.p95Ms}</td><td>${row.success}/${row.items}</td></tr>`).join('')}
          </tbody></table></div></div>`;
      } else if (tool === 'reset') {
        const phrase = window.prompt('这会删除台账与全部运行产物。输入 RESET 确认：');
        if (phrase !== 'RESET') return;
        await api('/api/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
        state.jobs = [];
        state.candidates = [];
        state.candidatesLoaded = false;
        toast('已清空台账与运行产物', 'ok');
        showNewView();
        await loadJobs();
        output.innerHTML = '<div class="info-card"><h3>已清空</h3><p class="muted">台账与 runs 已删除。</p></div>';
      }
    } catch (error) {
      output.innerHTML = `<div class="info-card"><h3>执行失败</h3><p class="muted">${esc(error.message)}</p></div>`;
      toast(error.message, 'error');
    }
  }

  // ---------------------------------------------------------------- settings

  function openSettings() {
    $('#set-llm').value = state.settings.llm;
    $('#set-seed').value = state.settings.seed;
    $('#set-mcp').value = state.settings.mcp;
    $('#set-faults').value = state.settings.faults;
    $('#set-key').value = state.settings.key || '';
    const pipeline = state.config?.pipeline;
    $('#settings-hint').textContent = pipeline
      ? `当前流水线：batch=${pipeline.batchSize} · 在途批=${pipeline.maxBatchesInFlight} · 池=${pipeline.pools.parse}/${pipeline.pools.assess}/${pipeline.pools.review} · 深评 ${pipeline.deepEval.percent}%→${pipeline.deepEval.tier}`
      : '首次运行会使用 config/pipeline.json 的参数。';
    $('#settings-modal').classList.remove('hidden');
  }

  function closeSettings() {
    $('#settings-modal').classList.add('hidden');
  }

  function saveSettings() {
    state.settings = {
      llm: $('#set-llm').value,
      seed: $('#set-seed').value.trim() || 'web-seed',
      mcp: $('#set-mcp').value,
      faults: $('#set-faults').value,
      key: $('#set-key').value.trim(),
    };
    persistSettings();
    updateEnvLine();
    $('#new-llm').value = state.settings.llm;
    closeSettings();
    toast('设置已保存', 'ok');
  }

  function updateEnvLine() {
    const hasEnvKey = Boolean(state.config?.hasDeepseekKey);
    const keyState = state.settings.key ? '浏览器本地 Key 已保存' : hasEnvKey ? '环境变量 Key 已配置' : '未配置 Key';
    $('#env-line').textContent = `provider=${state.settings.llm} · ${keyState}`;
  }

  async function loadConfig() {
    try {
      const data = await api('/api/config');
      state.config = data;
      if (!$('#new-requirements').value.trim()) $('#new-requirements').value = data.demoRequirements || '';
      if (!state.settings.seed) state.settings.seed = data.demoSeed || 'demo-2026';
      if (state.settings.llm !== 'deepseek' && data.defaultLlm === 'deepseek') state.settings.llm = 'deepseek';
      $('#new-llm').value = state.settings.llm;
      updateEnvLine();
    } catch (error) {
      toast(`读取配置失败：${error.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- init

  function bindEvents() {
    $('#new-run-btn').addEventListener('click', () => {
      showNewView();
      $('#job-title').textContent = '新建筛选任务';
      $('#job-sub').textContent = '输入岗位需求，BoLe 会完成结构化、筛选与核查';
    });
    $('#new-start').addEventListener('click', startNewRun);
    $('#new-requirements').addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') startNewRun();
    });
    $('#job-search').addEventListener('input', renderJobs);
    $('#job-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-job]');
      if (button) selectJob(button.getAttribute('data-job'));
    });
    $('#recent-jobs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-job]');
      if (button) selectJob(button.getAttribute('data-job'));
    });
    $('#resume-btn').addEventListener('click', resumeCurrent);
    $('#report-btn').addEventListener('click', openReport);
    $('#refresh-btn').addEventListener('click', async () => {
      if (!state.jobId) {
        await loadJobs();
        return;
      }
      await loadRun(false);
      if (state.tab === 'candidates') await loadCandidates(true);
      if (state.tab === 'compliance') await loadCompliance(true);
      if (state.tab === 'cost') await loadCost(true);
      toast('已刷新', 'ok');
    });
    $('#tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tab]');
      if (button) switchTab(button.getAttribute('data-tab'));
    });
    $('#event-filter').addEventListener('input', () => {
      state.eventFilter = $('#event-filter').value;
      renderEvents();
    });
    $('#candidate-filter').addEventListener('change', () => {
      state.candidateFilter = $('#candidate-filter').value;
      renderCandidates();
    });
    $('#inspector-close').addEventListener('click', closeInspector);
    $('#open-settings').addEventListener('click', openSettings);
    $('#settings-close').addEventListener('click', closeSettings);
    $('#settings-cancel').addEventListener('click', closeSettings);
    $('#settings-save').addEventListener('click', saveSettings);
    $('#settings-clear').addEventListener('click', () => {
      state.settings.key = '';
      localStorage.removeItem(KEY_KEY);
      $('#set-key').value = '';
      updateEnvLine();
      toast('已清除浏览器本地 Key', 'ok');
    });
    $('#settings-modal').addEventListener('click', (event) => {
      if (event.target === $('#settings-modal')) closeSettings();
    });
    $('#tool-output').parentElement.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tool]');
      if (button) runTool(button.getAttribute('data-tool'));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSettings();
        closeInspector();
      }
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '')) {
        event.preventDefault();
        $('#job-search').focus();
      }
    });
  }

  async function init() {
    bindEvents();
    await loadConfig();
    const jobs = await loadJobs();
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const target = hash.get('job');
    if (target && jobs.some((job) => job.id === target)) {
      await selectJob(target);
    } else if (window.location.hash === '#new') {
      showNewView();
    } else if (jobs.length > 0) {
      await selectJob(jobs[0].id);
    } else {
      showNewView();
    }
    setInterval(() => {
      if (!state.jobId || state.run?.status !== 'running') loadJobs();
    }, 8000);
  }

  init().catch((error) => {
    console.error(error);
    toast(`初始化失败：${error.message}`, 'error');
  });
})();
