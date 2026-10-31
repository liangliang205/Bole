import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrap, type Bootstrapped } from '../bootstrap.ts';
import { runPipeline, type RunSummary } from '../agents/coordinator.ts';
import type { HitlAnswer, HitlQuestion, HitlResponder } from '../agents/hitl.ts';
import { loadPipelineConfig, resolvePaths } from '../config.ts';
import { loadUpload } from '../ingest/uploads.ts';
import { KeyStore, verifyDeepSeekKey } from '../settings/key-store.ts';
import type { StreamToken, UploadedFile } from '../types.ts';
import {
  findReportDir,
  getCandidateDetail,
  getCost,
  getJob,
  getSnapshot,
  listCandidates,
  listEvents,
  listJobs,
} from './data.ts';
import { getAgents, getDoctor, resetAll } from './ops.ts';

type RunStatus = 'running' | 'completed' | 'failed' | 'idle';

interface WebServerOptions {
  host?: string;
  port?: number;
}

interface ActiveRun {
  jobId: string;
  runId: string;
  provider: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  summary?: RunSummary;
  error?: string;
  boot: Bootstrapped;
  hitl: WebHitlResponder;
  listeners: Set<(chunk: StreamToken) => void>;
}

interface HitlPending {
  question: HitlQuestion;
  resolve: (answer: HitlAnswer) => void;
}

class WebHitlResponder implements HitlResponder {
  private pending: HitlPending | null = null;

  async ask(question: HitlQuestion): Promise<HitlAnswer> {
    if (this.pending) throw new Error(`仍有未答复的 HITL 问题：${this.pending.question.id}`);
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
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function text(
  res: ServerResponse,
  code: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
  headers: Record<string, string> = {},
): void {
  res.statusCode = code;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 40 * 1024 * 1024) throw new Error('请求体过大（>40MB）');
    chunks.push(buffer);
  }
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

function inferStatus(jobStatus: string): RunStatus {
  if (jobStatus === 'completed' || jobStatus === 'draft') return 'completed';
  if (jobStatus === 'failed') return 'failed';
  return 'idle';
}

function readReport(jobId: string): Record<string, unknown> | null {
  const dir = findReportDir(jobId);
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

export async function startWebServer(options: WebServerOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const runs = new Map<string, ActiveRun>();
  const paths = resolvePaths();
  const keys = new KeyStore(paths.dataDir);

  const buildRunInfo = (jobId: string) => {
    const snapshot = getSnapshot(jobId);
    if (!snapshot.job) return null;
    const runtime = runs.get(jobId);
    const reportDir = findReportDir(jobId);
    return {
      jobId,
      runId: runtime?.runId ?? (reportDir ? path.basename(reportDir) : ''),
      provider: runtime?.provider ?? (snapshot.job.status === 'pipeline' ? 'deepseek' : ''),
      status: runtime?.status ?? inferStatus(snapshot.job.status),
      startedAt: runtime?.startedAt ?? snapshot.job.created_ts,
      completedAt: runtime?.completedAt ?? null,
      pendingHitl: runtime?.hitl.currentQuestion() ?? null,
      error: runtime?.error ?? null,
      reportAvailable: Boolean(reportDir),
      reportDir,
      summary: runtime?.summary ?? null,
    };
  };

  const launch = (opts: {
    boot: Bootstrapped;
    hitl: WebHitlResponder;
    listeners: Set<(chunk: StreamToken) => void>;
    requirements: string;
    uploadFiles?: UploadedFile[];
    resumeOnly: boolean;
  }): ActiveRun => {
    const run: ActiveRun = {
      jobId: opts.boot.job.id,
      runId: opts.boot.deps.runId,
      provider: opts.boot.deps.llm.provider.name,
      status: 'running',
      startedAt: new Date().toISOString(),
      boot: opts.boot,
      hitl: opts.hitl,
      listeners: opts.listeners,
    };
    runs.set(run.jobId, run);
    void (async () => {
      try {
        const summary = await runPipeline(opts.boot.deps, {
          requirements: opts.requirements,
          hitl: opts.hitl,
          uploadFiles: opts.uploadFiles,
          resumeOnly: opts.resumeOnly,
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
          opts.boot.deps.ledger.setJobStatus(run.jobId, 'failed');
          opts.boot.deps.events.emit(run.jobId, 'coordinator', 'run.failed', { error: message });
        } catch {
          // 避免二次故障掩盖原错误
        }
      } finally {
        opts.boot.close();
      }
    })();
    return run;
  };

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        text(res, 400, 'Bad Request');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      const staticFile = STATIC_FILES[pathname];
      if (method === 'GET' && staticFile) {
        const full = path.join(PUBLIC_DIR, staticFile.file);
        if (!existsSync(full)) {
          text(res, 500, `缺少前端资源：${staticFile.file}`);
          return;
        }
        text(res, 200, readFileSync(full, 'utf8'), staticFile.type);
        return;
      }
      if (method === 'GET' && pathname === '/favicon.ico') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/api/config') {
        const config = loadPipelineConfig();
        const key = await keys.status();
        const ocrLocal = ['chi_sim.traineddata.gz', 'eng.traineddata.gz'].every((name) =>
          existsSync(path.join(paths.ocrDir, name)),
        );
        json(res, 200, {
          ok: true,
          key,
          ocr: { external: Boolean(process.env.BOLE_OCR_URL), local: ocrLocal },
          pipeline: {
            batchSize: config.batchSize,
            maxBatchesInFlight: config.maxBatchesInFlight,
            pools: config.pools,
            deepEval: config.deepEval,
            topN: config.topN,
            models: config.models,
          },
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/key') {
        const body = await readJsonBody(req);
        const apiKey = String(body.apiKey ?? '').trim();
        if (!apiKey) {
          json(res, 400, { ok: false, error: 'API Key 不能为空' });
          return;
        }
        let verification: { verified: boolean; warning?: string };
        try {
          verification = await verifyDeepSeekKey(apiKey, process.env.BOLE_BASE_URL ?? 'https://api.deepseek.com');
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const status = await keys.save(apiKey);
        json(res, 200, { ok: true, key: status, verified: verification.verified, warning: verification.warning });
        return;
      }

      if (method === 'DELETE' && pathname === '/api/key') {
        await keys.clear();
        json(res, 200, { ok: true, key: await keys.status() });
        return;
      }

      if (method === 'GET' && pathname === '/api/jobs') {
        const jobs = listJobs(100).map((job) => ({
          ...job,
          activeStatus: runs.get(job.id)?.status ?? inferStatus(job.status),
        }));
        json(res, 200, { ok: true, jobs });
        return;
      }

      if (method === 'POST' && pathname === '/api/uploads') {
        const body = await readJsonBody(req);
        const { saveUpload } = await import('../ingest/uploads.ts');
        const uploaded = await saveUpload(
          { filename: String(body.filename ?? ''), contentBase64: String(body.contentBase64 ?? '') },
          paths.uploadsDir,
        );
        json(res, 200, {
          ok: true,
          upload: {
            uploadId: uploaded.uploadId,
            filename: uploaded.filename,
            size: uploaded.size,
            contentType: uploaded.contentType,
          },
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/run') {
        const body = await readJsonBody(req);
        const requirements = String(body.requirements ?? '').trim();
        if (requirements.length < 5) {
          json(res, 400, { ok: false, error: 'requirements 至少 5 个字符' });
          return;
        }
        const uploadIds = Array.isArray(body.uploadIds)
          ? body.uploadIds.map((id) => String(id)).filter(Boolean)
          : [];
        if (uploadIds.length === 0) {
          json(res, 400, { ok: false, error: '请先上传至少一份简历（PDF/DOCX/图片/文本）' });
          return;
        }
        const files: UploadedFile[] = [];
        for (const id of uploadIds) {
          const file = await loadUpload(id, paths.uploadsDir);
          if (file) files.push(file);
        }
        if (files.length === 0) {
          json(res, 400, { ok: false, error: '上传文件不存在或已过期，请重新上传' });
          return;
        }
        const deepseekApiKey = await keys.get();
        if (!deepseekApiKey) {
          json(res, 400, { ok: false, error: '尚未绑定 DeepSeek API Key：请先在设置中完成绑定。' });
          return;
        }
        const listeners = new Set<(chunk: StreamToken) => void>();
        const boot = await bootstrap({
          requirements,
          deepseekApiKey,
          stream: (chunk) => {
            for (const listener of listeners) {
              try {
                listener(chunk);
              } catch {
                // 前端断开不应中断流水线
              }
            }
          },
        });
        const hitl = new WebHitlResponder();
        const run = launch({ boot, hitl, listeners, requirements, uploadFiles: files, resumeOnly: false });
        json(res, 200, { ok: true, jobId: run.jobId, runId: run.runId, status: run.status });
        return;
      }

      const runMatch = /^\/api\/run\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && runMatch) {
        const jobId = decodeURIComponent(runMatch[1]);
        const snapshot = getSnapshot(jobId);
        if (!snapshot.job) {
          json(res, 404, { ok: false, error: `任务不存在: ${jobId}` });
          return;
        }
        json(res, 200, { ok: true, run: buildRunInfo(jobId), snapshot });
        return;
      }

      const streamMatch = /^\/api\/run\/([^/]+)\/stream$/.exec(pathname);
      if (method === 'GET' && streamMatch) {
        const jobId = decodeURIComponent(streamMatch[1]);
        const runtime = runs.get(jobId);
        if (!runtime) {
          json(res, 404, { ok: false, error: '该任务不在当前运行会话内，无法建立实时流' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const send = (event: string, data: unknown): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        let lastSeq = Number(url.searchParams.get('sinceSeq') ?? 0);
        let closed = false;
        const tokenListener = (chunk: StreamToken): void => {
          if (!closed) send('token', chunk);
        };
        runtime.listeners.add(tokenListener);
        send('status', buildRunInfo(jobId));
        send('snapshot', getSnapshot(jobId));
        let lastStatus = runtime.status;
        const poll = setInterval(() => {
          if (closed) return;
          try {
            for (const event of listEvents(jobId, lastSeq, 100)) {
              lastSeq = Math.max(lastSeq, event.seq);
              send('log', event);
            }
            const info = buildRunInfo(jobId);
            if (info && (info.status !== lastStatus || info.pendingHitl)) {
              lastStatus = info.status as RunStatus;
              send('status', info);
            }
            if (runtime.status === 'completed' || runtime.status === 'failed') {
              send('snapshot', getSnapshot(jobId));
              send('done', { status: runtime.status, error: runtime.error ?? null });
              clearInterval(poll);
              setTimeout(() => {
                if (!closed) res.end();
              }, 500);
            }
          } catch {
            // 下一轮重试
          }
        }, 350);
        const heartbeat = setInterval(() => {
          if (!closed) res.write(': ping\n\n');
        }, 15_000);
        req.on('close', () => {
          closed = true;
          runtime.listeners.delete(tokenListener);
          clearInterval(poll);
          clearInterval(heartbeat);
        });
        return;
      }

      const eventsMatch = /^\/api\/run\/([^/]+)\/events$/.exec(pathname);
      if (method === 'GET' && eventsMatch) {
        const jobId = decodeURIComponent(eventsMatch[1]);
        const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200)));
        json(res, 200, { ok: true, events: listEvents(jobId, Number.isFinite(sinceSeq) ? sinceSeq : 0, limit) });
        return;
      }

      const hitlMatch = /^\/api\/run\/([^/]+)\/hitl$/.exec(pathname);
      if (method === 'POST' && hitlMatch) {
        const jobId = decodeURIComponent(hitlMatch[1]);
        const runtime = runs.get(jobId);
        if (!runtime) {
          json(res, 404, { ok: false, error: '该任务不在当前 Web 会话内，无法回答 HITL' });
          return;
        }
        const body = await readJsonBody(req);
        const answer = String(body.answer ?? '').trim();
        if (!answer) {
          json(res, 400, { ok: false, error: 'answer 不能为空' });
          return;
        }
        runtime.hitl.answer(answer, String(body.actor ?? 'HR(web)'));
        json(res, 200, { ok: true });
        return;
      }

      const reportMatch = /^\/api\/run\/([^/]+)\/report$/.exec(pathname);
      if (method === 'GET' && reportMatch) {
        const jobId = decodeURIComponent(reportMatch[1]);
        const report = readReport(jobId);
        if (!report) {
          json(res, 404, { ok: false, error: '报告尚未生成' });
          return;
        }
        // 仅供对话内汇总与后续 MCP 使用；不提供 Markdown/JSON 下载。
        json(res, 200, report);
        return;
      }

      const candidatesMatch = /^\/api\/run\/([^/]+)\/candidates$/.exec(pathname);
      if (method === 'GET' && candidatesMatch) {
        const jobId = decodeURIComponent(candidatesMatch[1]);
        json(res, 200, { ok: true, candidates: listCandidates(jobId) });
        return;
      }

      const candidateMatch = /^\/api\/run\/([^/]+)\/candidates\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && candidateMatch) {
        const jobId = decodeURIComponent(candidateMatch[1]);
        const needle = decodeURIComponent(candidateMatch[2]);
        const detail = getCandidateDetail(jobId, needle);
        if (!detail) {
          json(res, 404, { ok: false, error: `找不到候选人: ${needle}` });
          return;
        }
        json(res, 200, { ok: true, candidate: detail });
        return;
      }

      const costMatch = /^\/api\/run\/([^/]+)\/cost$/.exec(pathname);
      if (method === 'GET' && costMatch) {
        const jobId = decodeURIComponent(costMatch[1]);
        json(res, 200, { ok: true, ...getCost(jobId) });
        return;
      }

      const resumeMatch = /^\/api\/run\/([^/]+)\/resume$/.exec(pathname);
      if (method === 'POST' && resumeMatch) {
        const jobId = decodeURIComponent(resumeMatch[1]);
        const job = getJob(jobId);
        if (!job) {
          json(res, 404, { ok: false, error: `任务不存在: ${jobId}` });
          return;
        }
        if (runs.get(jobId)?.status === 'running') {
          json(res, 409, { ok: false, error: '该任务正在运行，不能重复启动' });
          return;
        }
        const deepseekApiKey = await keys.get();
        if (!deepseekApiKey) {
          json(res, 400, { ok: false, error: '尚未绑定 DeepSeek API Key：请先在设置中完成绑定。' });
          return;
        }
        const listeners = new Set<(chunk: StreamToken) => void>();
        const boot = await bootstrap({
          requirements: job.requirements,
          jobId,
          seed: job.seed ?? 'resume',
          deepseekApiKey,
          stream: (chunk) => {
            for (const listener of listeners) {
              try {
                listener(chunk);
              } catch {
                // 前端断开不应中断流水线
              }
            }
          },
        });
        const hitl = new WebHitlResponder();
        const run = launch({ boot, hitl, listeners, requirements: job.requirements, resumeOnly: true });
        json(res, 200, { ok: true, jobId, runId: run.runId, status: run.status });
        return;
      }

      if (method === 'GET' && pathname === '/api/agents') {
        json(res, 200, { ok: true, ...getAgents() });
        return;
      }
      if (method === 'GET' && pathname === '/api/doctor') {
        json(res, 200, { ok: true, ...(await getDoctor()) });
        return;
      }
      if (method === 'POST' && pathname === '/api/reset') {
        const body = await readJsonBody(req);
        if (String(body.confirm ?? '') !== 'RESET') {
          json(res, 400, { ok: false, error: '需要 confirm="RESET" 才能清空台账' });
          return;
        }
        if ([...runs.values()].some((run) => run.status === 'running')) {
          json(res, 409, { ok: false, error: '仍有任务在运行，不能清空台账' });
          return;
        }
        const removed = resetAll();
        runs.clear();
        json(res, 200, { ok: true, ...removed });
        return;
      }

      if (pathname.startsWith('/api/')) {
        json(res, 404, { ok: false, error: `未知接口: ${pathname}` });
        return;
      }
      text(res, 404, 'Not Found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /上传|不支持的文件|文件内容|超过/.test(message) ? 400 : 500;
      json(res, status, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  process.stdout.write(`BoLe Web 已启动: http://${host}:${port}\n`);
  process.stdout.write('对话式控制台：上传简历 → 开始筛选 → 实时事件/流式生成 → 证据审计 → 对话内报告。\n');
}
