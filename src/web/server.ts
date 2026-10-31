import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrap, type Bootstrapped } from '../bootstrap.ts';
import { runPipeline, type RunSummary } from '../agents/coordinator.ts';
import { DEMO_FAULTS, DEMO_REQUIREMENTS, DEMO_SEED } from '../cli/demo-data.ts';
import type { HitlAnswer, HitlQuestion, HitlResponder } from '../agents/hitl.ts';
import { loadPipelineConfig, resolvePaths } from '../config.ts';
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
import { getAgents, getDoctor, resetAll, runBench, seedGolden } from './ops.ts';

type RunStatus = 'running' | 'completed' | 'failed' | 'idle';

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

function text(res: ServerResponse, code: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = code;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new Error('请求体过大（>2MB）');
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

  const launch = (opts: {
    boot: Bootstrapped;
    hitl: WebHitlResponder;
    provider: 'mock' | 'deepseek';
    requirements: string;
    inboxDir: string;
    mcpMode: 'in-process' | 'stdio';
    resumeOnly: boolean;
  }): ActiveRun => {
    const run: ActiveRun = {
      jobId: opts.boot.job.id,
      runId: opts.boot.deps.runId,
      provider: opts.provider,
      status: 'running',
      startedAt: new Date().toISOString(),
      boot: opts.boot,
      hitl: opts.hitl,
    };
    runs.set(run.jobId, run);
    void (async () => {
      try {
        const summary = await runPipeline(opts.boot.deps, {
          requirements: opts.requirements,
          hitl: opts.hitl,
          inboxDir: opts.inboxDir,
          mcpMode: opts.mcpMode,
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
        json(res, 200, {
          ok: true,
          hasDeepseekKey: Boolean(process.env.DEEPSEEK_API_KEY),
          defaultLlm: (process.env.BOLE_LLM as 'mock' | 'deepseek' | undefined) ?? 'mock',
          demoRequirements: DEMO_REQUIREMENTS,
          demoSeed: DEMO_SEED,
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

      if (method === 'GET' && pathname === '/api/jobs') {
        const jobs = listJobs(100).map((job) => ({
          ...job,
          activeStatus: runs.get(job.id)?.status ?? inferStatus(job.status),
        }));
        json(res, 200, { ok: true, jobs });
        return;
      }

      if (method === 'GET' && pathname === '/api/latest') {
        const jobs = listJobs(1);
        json(res, 200, { ok: true, jobId: jobs[0]?.id ?? null });
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
          json(res, 400, { ok: false, error: '未提供 DeepSeek API Key：请在设置中填写 key，或配置 DEEPSEEK_API_KEY。' });
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
        const run = launch({
          boot,
          hitl,
          provider: llm,
          requirements,
          // 前端不开放任意 inboxDir，避免本地服务被用作文件读取代理
          inboxDir: paths.inboxDir,
          mcpMode: String(body.mcpMode ?? 'in-process') === 'stdio' ? 'stdio' : 'in-process',
          resumeOnly: false,
        });
        json(res, 200, { ok: true, jobId: run.jobId, runId: run.runId, provider: run.provider, status: run.status });
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
        const runtime = runs.get(jobId);
        const reportDir = findReportDir(jobId);
        const inferredRunId = reportDir ? path.basename(reportDir) : '';
        json(res, 200, {
          ok: true,
          run: {
            jobId,
            runId: runtime?.runId ?? inferredRunId,
            provider: runtime?.provider ?? 'unknown',
            status: runtime?.status ?? inferStatus(snapshot.job.status),
            startedAt: runtime?.startedAt ?? snapshot.job.created_ts,
            completedAt: runtime?.completedAt ?? null,
            pendingHitl: runtime?.hitl.currentQuestion() ?? null,
            error: runtime?.error ?? null,
            reportAvailable: Boolean(reportDir),
            reportDir,
            summary: runtime?.summary ?? null,
          },
          snapshot,
        });
        return;
      }

      const eventsMatch = /^\/api\/run\/([^/]+)\/events$/.exec(pathname);
      if (method === 'GET' && eventsMatch) {
        const jobId = decodeURIComponent(eventsMatch[1]);
        const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200)));
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
        const dir = findReportDir(jobId);
        const file = dir ? path.join(dir, 'report.html') : '';
        if (!file || !existsSync(file)) {
          text(res, 404, '报告尚未生成');
          return;
        }
        text(res, 200, readFileSync(file, 'utf8'), 'text/html; charset=utf-8');
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
        const body = await readJsonBody(req);
        const llm = (String(body.llm ?? 'mock') === 'deepseek' ? 'deepseek' : 'mock') as 'mock' | 'deepseek';
        const deepseekApiKey = String(body.deepseekApiKey ?? '').trim();
        if (llm === 'deepseek' && !deepseekApiKey && !process.env.DEEPSEEK_API_KEY) {
          json(res, 400, { ok: false, error: '未提供 DeepSeek API Key' });
          return;
        }
        const hitl = new WebHitlResponder();
        const boot = await bootstrap({
          requirements: job.requirements,
          jobId,
          seed: job.seed ?? 'resume',
          llm,
          deepseekApiKey: deepseekApiKey || undefined,
          faults: body.withFaults === true ? DEMO_FAULTS : {},
        });
        const run = launch({
          boot,
          hitl,
          provider: llm,
          requirements: job.requirements,
          inboxDir: paths.inboxDir,
          mcpMode: 'in-process',
          resumeOnly: true,
        });
        json(res, 200, { ok: true, jobId, runId: run.runId, status: run.status });
        return;
      }

      if (method === 'GET' && pathname === '/api/agents') {
        json(res, 200, { ok: true, ...getAgents() });
        return;
      }
      if (method === 'GET' && pathname === '/api/doctor') {
        json(res, 200, { ok: true, ...getDoctor() });
        return;
      }
      if (method === 'POST' && pathname === '/api/seed') {
        const result = await seedGolden();
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (method === 'POST' && pathname === '/api/bench') {
        const body = await readJsonBody(req);
        const result = await runBench({
          items: Number(body.items ?? 60),
          latency: Number(body.latency ?? 8),
          concurrency: Array.isArray(body.concurrency) ? (body.concurrency as number[]) : undefined,
        });
        json(res, 200, { ok: true, ...result });
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
      json(res, 500, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  process.stdout.write(`BoLe Web 已启动: http://${host}:${port}\n`);
  process.stdout.write('提示：所有操作（发起运行 / HITL / 候选人审计 / 成本 / 工具）都在页面完成。\n');
}
