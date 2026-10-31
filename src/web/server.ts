import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { bootstrap, type Bootstrapped } from '../bootstrap.ts';
import { runPipeline, type RunSummary } from '../agents/coordinator.ts';
import { DEMO_FAULTS, DEMO_REQUIREMENTS, DEMO_SEED } from '../cli/demo-data.ts';
import type { HitlAnswer, HitlQuestion, HitlResponder } from '../agents/hitl.ts';
import { resolvePaths } from '../config.ts';
import { Ledger } from '../core/ledger.ts';
import type { EventRow, JobRow } from '../types.ts';

type RunStatus = 'running' | 'completed' | 'failed';

interface WebServerOptions {
  host?: string;
  port?: number;
}

interface ActiveRun {
  jobId: string;
  runId: string;
  provider: 'mock' | 'deepseek';
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  summary?: RunSummary;
  error?: string;
  boot: Bootstrapped;
  hitl: WebHitlResponder;
}

interface HitlPending {
  question: HitlQuestion;
  resolve: (answer: HitlAnswer) => void;
}

class WebHitlResponder implements HitlResponder {
  private pending: HitlPending | null = null;

  async ask(question: HitlQuestion): Promise<HitlAnswer> {
    if (this.pending) {
      throw new Error(`仍有未答复的 HITL 问题：${this.pending.question.id}`);
    }
    return await new Promise<HitlAnswer>((resolve) => {
      this.pending = { question, resolve };
    });
  }

  currentQuestion(): HitlQuestion | null {
    return this.pending?.question ?? null;
  }

  answer(answer: string, actor: string): void {
    if (!this.pending) throw new Error('当前没有等待回答的 HITL 问题');
    const pending = this.pending;
    this.pending = null;
    pending.resolve({ answer, actor });
  }
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function text(res: ServerResponse, code: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = code;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function parseEvent(row: EventRow): EventRow & { payload: Record<string, unknown> } {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = { parseError: true };
  }
  return { ...row, payload };
}

function findLatestReportByJob(jobId: string): string | null {
  const paths = resolvePaths();
  if (!existsSync(paths.runsDir)) return null;
  const dirs = readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(paths.runsDir, entry.name))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const file = path.join(dir, 'report.json');
    if (!existsSync(file)) continue;
    try {
      const report = JSON.parse(readFileSync(file, 'utf8')) as { job?: { id?: string } };
      if (report.job?.id === jobId) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

function openSnapshot(jobId: string): {
  job: JobRow | undefined;
  resumeCounts: Record<string, number>;
  reviewCounts: Record<string, number>;
  decisions: number;
  eventsCount: number;
} {
  const paths = resolvePaths();
  const ledger = new Ledger(paths.dbPath);
  try {
    const job = ledger.getJob(jobId);
    return {
      job,
      resumeCounts: job ? ledger.resumeCounts(jobId) : {},
      reviewCounts: job ? ledger.reviewVerdictCounts(jobId) : {},
      decisions: job ? ledger.listDecisions(jobId).length : 0,
      eventsCount: job ? ledger.countEvents(jobId) : 0,
    };
  } finally {
    ledger.close();
  }
}

function listEvents(jobId: string, sinceSeq: number, limit: number): (EventRow & { payload: Record<string, unknown> })[] {
  const paths = resolvePaths();
  const ledger = new Ledger(paths.dbPath);
  try {
    return ledger.listEvents({ jobId, sinceSeq, limit }).map(parseEvent);
  } finally {
    ledger.close();
  }
}

function getUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BoLe 交互前端</title>
<style>
:root{color-scheme:dark;--bg:#0b1220;--panel:#111b2e;--line:#273a5f;--text:#d8e4ff;--muted:#90a4c8;--acc:#4d8bff;--ok:#30c48d;--warn:#ffb020;--danger:#ff647c}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 500px at 30% -200px,#1f3a72 0%,var(--bg) 45%);color:var(--text);font-family:Inter,"Segoe UI","Noto Sans SC",sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:20px}
.grid{display:grid;grid-template-columns:420px 1fr;gap:14px}
.card{background:rgba(17,27,46,.92);border:1px solid var(--line);border-radius:14px;padding:14px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:0 0 10px}.muted{font-size:12px;color:var(--muted)}
label{display:block;font-size:12px;color:var(--muted);margin:10px 0 6px}
textarea,select,input{width:100%;border:1px solid #2a3f64;background:#0f1a31;color:var(--text);border-radius:10px;padding:10px;font:inherit}
textarea{min-height:120px;resize:vertical}
button{border:1px solid #3a5e96;background:#1a3360;color:#cce0ff;padding:9px 12px;border-radius:10px;cursor:pointer}
button:hover{background:#24457d}
button.secondary{background:#132644;border-color:#2a436d}
button.warn{background:#5a3b14;border-color:#8e5e22}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.kpi .item{border:1px solid var(--line);border-radius:10px;padding:10px;background:#0f1a31}
.kpi b{display:block;font-size:20px}
.status{display:inline-flex;padding:3px 10px;border-radius:999px;border:1px solid #3b5d90;background:#1a3157;font-size:12px}
.status.running{color:#ffd88e}.status.completed{color:#98f0c8}.status.failed{color:#ff90a1}
.hitl{border:1px solid #5f4a20;background:#2b2212;border-radius:10px;padding:10px;margin-top:10px}
.hitl h3{margin:0 0 6px;font-size:14px;color:#ffd88e}
.hitl .options{display:grid;gap:8px;margin-top:8px}
.events{height:420px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:#0f1a31;padding:10px;font-family:Consolas,monospace;font-size:12px;line-height:1.5}
.event{padding:4px 0;border-bottom:1px dashed #243a5f}
.ok{color:var(--ok)}.warnText{color:var(--warn)}.danger{color:var(--danger)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#173159;border:1px solid #345b94;font-size:11px}
.hidden{display:none}
@media(max-width:1080px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
  <div class="wrap">
    <h1>BoLe 交互前端</h1>
    <p class="muted">发起运行、实时查看事件、回答 HITL 问题、查看报告。默认使用 mock（无 API Key 也可运行）。</p>
    <div class="grid">
      <section class="card">
        <h2>发起运行</h2>
        <div id="key-status" class="muted">正在检查 API Key...</div>
        <label>招聘需求（JD）</label>
        <textarea id="requirements"></textarea>
        <div class="row">
          <div>
            <label>模型提供方</label>
            <select id="llm">
              <option value="mock">mock（离线可复现）</option>
              <option value="deepseek">deepseek（需要 API Key）</option>
            </select>
          </div>
          <div>
            <label>随机种子</label>
            <input id="seed" value="${DEMO_SEED}">
          </div>
        </div>
        <div class="row">
          <div>
            <label>DeepSeek API Key（保存在浏览器本地，不写入服务端）</label>
            <input id="deepseek-key" type="password" placeholder="sk-...（留空则尝试使用环境变量 DEEPSEEK_API_KEY）">
          </div>
          <div>
            <label style="visibility:hidden">保存</label>
            <button id="save-key" class="secondary">保存到浏览器本地</button>
          </div>
        </div>
        <div class="row">
          <div>
            <label>MCP 方式</label>
            <select id="mcp">
              <option value="in-process">in-process</option>
              <option value="stdio">stdio</option>
            </select>
          </div>
          <div>
            <label>故障注入（演示用）</label>
            <select id="faults">
              <option value="on">开启（R17 幻觉 / R20 偏见）</option>
              <option value="off">关闭</option>
            </select>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button id="start-btn">开始运行</button>
          <button id="load-latest" class="secondary">加载最近任务</button>
        </div>
        <p class="muted">运行期间若出现 HITL 问题，会在右侧实时弹出并阻塞等待答复。</p>
      </section>
      <section class="card">
        <h2>任务状态 <span id="run-status" class="status">idle</span></h2>
        <div id="run-meta" class="muted">尚未启动任务。</div>
        <div class="kpi" id="kpis" style="margin-top:10px"></div>
        <div id="hitl-box" class="hitl hidden"></div>
        <div style="margin-top:10px">
          <button id="open-report" class="secondary hidden">打开交互报告页</button>
        </div>
      </section>
    </div>
    <section class="card" style="margin-top:14px">
      <h2>实时事件流</h2>
      <div class="events" id="events"></div>
    </section>
  </div>

<script>
(() => {
  const requirementsEl = document.getElementById('requirements');
  const llmEl = document.getElementById('llm');
  const seedEl = document.getElementById('seed');
  const deepseekKeyEl = document.getElementById('deepseek-key');
  const saveKeyBtn = document.getElementById('save-key');
  const mcpEl = document.getElementById('mcp');
  const faultsEl = document.getElementById('faults');
  const keyStatusEl = document.getElementById('key-status');
  const startBtn = document.getElementById('start-btn');
  const loadLatestBtn = document.getElementById('load-latest');
  const statusEl = document.getElementById('run-status');
  const metaEl = document.getElementById('run-meta');
  const kpisEl = document.getElementById('kpis');
  const eventsEl = document.getElementById('events');
  const hitlEl = document.getElementById('hitl-box');
  const openReportBtn = document.getElementById('open-report');

  requirementsEl.value = ${JSON.stringify(DEMO_REQUIREMENTS)};
  deepseekKeyEl.value = localStorage.getItem('bole.deepseekApiKey') || '';

  let currentJobId = '';
  let poller = null;
  let lastSeq = 0;
  const knownEventSeq = new Set();

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[c]));
  const updateKeyUi = () => {
    const useDeepseek = llmEl.value === 'deepseek';
    deepseekKeyEl.disabled = !useDeepseek;
    saveKeyBtn.disabled = !useDeepseek;
    deepseekKeyEl.placeholder = useDeepseek
      ? 'sk-...（留空则尝试使用环境变量 DEEPSEEK_API_KEY）'
      : '当前使用 mock，可不填写';
  };
  const setStatus = (status, text) => {
    statusEl.className = 'status ' + status;
    statusEl.textContent = text || status;
  };
  const addEvent = (evt) => {
    if (knownEventSeq.has(evt.seq)) return;
    knownEventSeq.add(evt.seq);
    lastSeq = Math.max(lastSeq, Number(evt.seq || 0));
    const div = document.createElement('div');
    div.className = 'event';
    const t = String(evt.ts || '').slice(11, 19);
    div.innerHTML = '<span class="pill">' + esc(t) + '</span> ' + esc(evt.actor) + ' · <b>' + esc(evt.type) + '</b>' +
      (evt.payload ? '<div class="muted">' + esc(JSON.stringify(evt.payload)) + '</div>' : '');
    eventsEl.appendChild(div);
    eventsEl.scrollTop = eventsEl.scrollHeight;
  };
  const setKpis = (snapshot) => {
    const counts = snapshot.resumeCounts || {};
    const review = snapshot.reviewCounts || {};
    const cards = [
      ['queued', counts.queued || 0],
      ['parsed', counts.parsed || 0],
      ['verified', counts.verified || 0],
      ['reported', counts.reported || 0],
      ['quarantine', counts.quarantine || 0],
      ['review pass', review.pass || 0],
      ['review re_eval', review.re_eval || 0],
      ['review escalate', review.escalate_human || 0],
    ];
    kpisEl.innerHTML = cards.map(([k, v]) => '<div class="item"><span class="muted">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  };

  const renderHitl = (pending) => {
    if (!pending) {
      hitlEl.classList.add('hidden');
      hitlEl.innerHTML = '';
      return;
    }
    hitlEl.classList.remove('hidden');
    const optionButtons = (pending.options || []).map((option) =>
      '<button class="hitl-option" data-answer="' + esc(option) + '">' + esc(option) + (option === pending.recommendedOption ? '（推荐）' : '') + '</button>'
    ).join('');
    hitlEl.innerHTML = '<h3>等待 HITL 回答</h3><div>' + esc(pending.node) + '</div><p>' + esc(pending.question) + '</p>' +
      '<div class="options">' + optionButtons + '</div>' +
      '<label style="margin-top:8px">自定义回答</label><input id="hitl-custom" placeholder="可直接输入自定义文本">' +
      '<div class="row" style="margin-top:8px"><button id="hitl-submit" class="warn">提交回答</button></div>';

    hitlEl.querySelectorAll('.hitl-option').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const answer = btn.getAttribute('data-answer') || '';
        await submitHitl(answer);
      });
    });
    const submitBtn = document.getElementById('hitl-submit');
    submitBtn?.addEventListener('click', async () => {
      const custom = document.getElementById('hitl-custom');
      const value = custom && custom.value ? custom.value.trim() : '';
      if (!value) return;
      await submitHitl(value);
    });
  };

  const submitHitl = async (answer) => {
    if (!currentJobId) return;
    const resp = await fetch('/api/run/' + encodeURIComponent(currentJobId) + '/hitl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, actor: 'HR(web)' }),
    });
    const payload = await resp.json();
    if (!resp.ok || !payload.ok) {
      alert(payload.error || '提交 HITL 失败');
      return;
    }
    await refreshSnapshot();
  };

  const refreshEvents = async () => {
    if (!currentJobId) return;
    const resp = await fetch('/api/run/' + encodeURIComponent(currentJobId) + '/events?sinceSeq=' + String(lastSeq) + '&limit=120');
    const payload = await resp.json();
    if (!resp.ok || !payload.ok) return;
    (payload.events || []).forEach(addEvent);
  };

  const refreshSnapshot = async () => {
    if (!currentJobId) return;
    const resp = await fetch('/api/run/' + encodeURIComponent(currentJobId));
    const payload = await resp.json();
    if (!resp.ok || !payload.ok) {
      setStatus('failed', 'failed');
      metaEl.innerHTML = '<span class="danger">' + esc(payload.error || '读取任务失败') + '</span>';
      return;
    }
    const run = payload.run;
    const snapshot = payload.snapshot;
    setStatus(run?.status || 'running', run?.status || 'running');
    metaEl.innerHTML =
      'job=' + esc(run.jobId) + ' · run=' + esc(run.runId) + ' · provider=' + esc(run.provider) +
      (run.error ? ' · <span class="danger">' + esc(run.error) + '</span>' : '');
    setKpis(snapshot);
    renderHitl(run.pendingHitl);

    if (run.status === 'completed') {
      openReportBtn.classList.remove('hidden');
      openReportBtn.onclick = () => window.open('/api/run/' + encodeURIComponent(currentJobId) + '/report', '_blank');
      if (poller) clearInterval(poller);
      poller = null;
    } else if (run.status === 'failed') {
      if (poller) clearInterval(poller);
      poller = null;
    }
  };

  const startPolling = async () => {
    if (poller) clearInterval(poller);
    poller = setInterval(async () => {
      await refreshEvents();
      await refreshSnapshot();
    }, 900);
    await refreshEvents();
    await refreshSnapshot();
  };

  startBtn.addEventListener('click', async () => {
    const requirements = requirementsEl.value.trim();
    if (requirements.length < 5) {
      alert('请填写至少 5 个字符的招聘需求');
      return;
    }
    startBtn.disabled = true;
    try {
      const deepseekApiKey = deepseekKeyEl.value.trim();
      const resp = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirements,
          llm: llmEl.value,
          deepseekApiKey,
          seed: seedEl.value.trim() || 'web-seed',
          mcpMode: mcpEl.value,
          withFaults: faultsEl.value === 'on',
        }),
      });
      const payload = await resp.json();
      if (!resp.ok || !payload.ok) {
        alert(payload.error || '启动失败');
        return;
      }
      currentJobId = payload.jobId;
      lastSeq = 0;
      knownEventSeq.clear();
      eventsEl.innerHTML = '';
      openReportBtn.classList.add('hidden');
      await startPolling();
    } finally {
      startBtn.disabled = false;
    }
  });

  loadLatestBtn.addEventListener('click', async () => {
    const resp = await fetch('/api/latest');
    const payload = await resp.json();
    if (!resp.ok || !payload.ok || !payload.jobId) {
      alert(payload.error || '没有可加载的任务');
      return;
    }
    currentJobId = payload.jobId;
    lastSeq = 0;
    knownEventSeq.clear();
    eventsEl.innerHTML = '';
    await startPolling();
  });

  llmEl.addEventListener('change', updateKeyUi);
  saveKeyBtn.addEventListener('click', () => {
    localStorage.setItem('bole.deepseekApiKey', deepseekKeyEl.value.trim());
    alert('已保存到浏览器本地（localStorage）');
  });
  updateKeyUi();

  (async () => {
    const resp = await fetch('/api/config');
    const payload = await resp.json();
    if (!resp.ok || !payload.ok) {
      keyStatusEl.innerHTML = '<span class="danger">读取配置失败</span>';
      return;
    }
    const keyHint = payload.hasDeepseekKey
      ? '<span class="ok">环境变量已配置 DEEPSEEK_API_KEY；也可在页面输入临时 key</span>'
      : '<span class="warnText">环境变量未配置 DEEPSEEK_API_KEY；可在页面输入 key，或使用 mock 运行</span>';
    keyStatusEl.innerHTML = '当前环境：' + keyHint;
  })();
})();
</script>
</body>
</html>`;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const runs = new Map<string, ActiveRun>();
  const paths = resolvePaths();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        text(res, 400, 'Bad Request');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && pathname === '/') {
        text(res, 200, getUiHtml(), 'text/html; charset=utf-8');
        return;
      }

      if (method === 'GET' && pathname === '/api/config') {
        json(res, 200, {
          ok: true,
          hasDeepseekKey: Boolean(process.env.DEEPSEEK_API_KEY),
          acceptsInlineKey: true,
          defaultLlm: (process.env.BOLE_LLM as 'mock' | 'deepseek' | undefined) ?? 'mock',
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/latest') {
        const ledger = new Ledger(paths.dbPath);
        try {
          const latest = ledger.latestJob();
          json(res, 200, { ok: true, jobId: latest?.id ?? null });
        } finally {
          ledger.close();
        }
        return;
      }

      if (method === 'POST' && pathname === '/api/run') {
        const body = await readJsonBody(req);
        const requirements = String(body.requirements ?? '').trim();
        if (requirements.length < 5) {
          json(res, 400, { ok: false, error: 'requirements 至少 5 个字符' });
          return;
        }
        const llm = (String(body.llm ?? 'mock') === 'deepseek' ? 'deepseek' : 'mock') as 'mock' | 'deepseek';
        const deepseekApiKey = String(body.deepseekApiKey ?? '').trim();
        if (llm === 'deepseek' && !deepseekApiKey && !process.env.DEEPSEEK_API_KEY) {
          json(res, 400, { ok: false, error: '未提供 DeepSeek API Key：请在页面填写 key，或配置 DEEPSEEK_API_KEY。' });
          return;
        }
        const hitl = new WebHitlResponder();
        const boot = await bootstrap({
          requirements,
          seed: String(body.seed ?? DEMO_SEED),
          llm,
          deepseekApiKey: deepseekApiKey || undefined,
          faults: body.withFaults === false ? {} : DEMO_FAULTS,
        });

        const run: ActiveRun = {
          jobId: boot.job.id,
          runId: boot.deps.runId,
          provider: llm,
          status: 'running',
          startedAt: new Date().toISOString(),
          boot,
          hitl,
        };
        runs.set(run.jobId, run);

        void (async () => {
          try {
            const summary = await runPipeline(boot.deps, {
              requirements,
              hitl,
              inboxDir: String(body.inboxDir ?? paths.inboxDir),
              mcpMode: String(body.mcpMode ?? 'in-process') === 'stdio' ? 'stdio' : 'in-process',
            });
            run.status = 'completed';
            run.summary = summary;
            run.completedAt = new Date().toISOString();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            run.status = 'failed';
            run.error = message;
            run.completedAt = new Date().toISOString();
            try {
              boot.deps.ledger.setJobStatus(run.jobId, 'failed');
              boot.deps.events.emit(run.jobId, 'coordinator', 'run.failed', { error: message });
            } catch {
              // 避免二次故障掩盖原错误
            }
          } finally {
            boot.close();
          }
        })();

        json(res, 200, {
          ok: true,
          jobId: run.jobId,
          runId: run.runId,
          provider: run.provider,
          status: run.status,
        });
        return;
      }

      const runMatch = /^\/api\/run\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && runMatch) {
        const jobId = decodeURIComponent(runMatch[1]);
        const runtime = runs.get(jobId);
        const snapshot = openSnapshot(jobId);
        if (!snapshot.job) {
          json(res, 404, { ok: false, error: `任务不存在: ${jobId}` });
          return;
        }
        const reportDir = findLatestReportByJob(jobId);
        const inferredRunId = reportDir ? path.basename(reportDir) : '';
        json(res, 200, {
          ok: true,
          run: {
            jobId,
            runId: runtime?.runId ?? inferredRunId,
            provider: runtime?.provider ?? 'unknown',
            status: runtime?.status ?? (snapshot.job.status === 'completed' || snapshot.job.status === 'draft' ? 'completed' : 'failed'),
            startedAt: runtime?.startedAt ?? snapshot.job.created_ts,
            completedAt:
              runtime?.completedAt ??
              ((runtime?.status === 'completed' || runtime?.status === 'failed') ? snapshot.job.updated_ts : null),
            pendingHitl: runtime?.hitl.currentQuestion() ?? null,
            error: runtime?.error ?? null,
            reports: runtime?.summary?.reports ?? null,
          },
          snapshot,
        });
        return;
      }

      const eventsMatch = /^\/api\/run\/([^/]+)\/events$/.exec(pathname);
      if (method === 'GET' && eventsMatch) {
        const jobId = decodeURIComponent(eventsMatch[1]);
        const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0);
        const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit') ?? 120)));
        json(res, 200, {
          ok: true,
          events: listEvents(jobId, Number.isFinite(sinceSeq) ? sinceSeq : 0, limit),
        });
        return;
      }

      const hitlMatch = /^\/api\/run\/([^/]+)\/hitl$/.exec(pathname);
      if (method === 'POST' && hitlMatch) {
        const jobId = decodeURIComponent(hitlMatch[1]);
        const runtime = runs.get(jobId);
        if (!runtime) {
          json(res, 404, { ok: false, error: '该任务不在当前 Web 会话内（可用“加载最近任务”查看历史状态）' });
          return;
        }
        const body = await readJsonBody(req);
        const answer = String(body.answer ?? '').trim();
        if (!answer) {
          json(res, 400, { ok: false, error: 'answer 不能为空' });
          return;
        }
        const actor = String(body.actor ?? 'HR(web)');
        runtime.hitl.answer(answer, actor);
        json(res, 200, { ok: true });
        return;
      }

      const reportMatch = /^\/api\/run\/([^/]+)\/report$/.exec(pathname);
      if (method === 'GET' && reportMatch) {
        const jobId = decodeURIComponent(reportMatch[1]);
        const runtime = runs.get(jobId);
        const reportPath = runtime?.summary?.reports.html ?? (() => {
          const reportDir = findLatestReportByJob(jobId);
          return reportDir ? path.join(reportDir, 'report.html') : '';
        })();
        if (!reportPath || !existsSync(reportPath)) {
          text(res, 404, '报告尚未生成');
          return;
        }
        text(res, 200, readFileSync(reportPath, 'utf8'), 'text/html; charset=utf-8');
        return;
      }

      text(res, 404, 'Not Found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  process.stdout.write(`BoLe Web 已启动: http://${host}:${port}\n`);
  process.stdout.write(`提示: deepseek 可使用环境变量 DEEPSEEK_API_KEY，或在页面中输入临时 API Key。\n`);
}
