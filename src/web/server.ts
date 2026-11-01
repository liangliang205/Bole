import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrap, type Bootstrapped } from '../bootstrap.ts';
import { PipelinePausedError, runPipeline, type RunSummary } from '../agents/coordinator.ts';
import type { HitlAnswer, HitlQuestion, HitlResponder } from '../agents/hitl.ts';
import { loadPipelineConfig, resolvePaths } from '../config.ts';
import { loadUpload } from '../ingest/uploads.ts';
import { fetchModelList, verifyDeepSeekKey } from '../settings/key-store.ts';
import { ProviderStore, type ProviderApi, type ProviderInput, type ProviderPublic } from '../settings/provider-store.ts';
import { StreamPreviewer } from './stream-preview.ts';
import type { StreamToken, UploadedFile } from '../types.ts';
import {
  deleteJob,
  findReportDir,
  getCandidateDetail,
  getCost,
  getJob,
  getSnapshot,
  listCandidates,
  listEvents,
  listJobs,
  updateJobMeta,
} from './data.ts';
import { getAgents, getDoctor, resetAll } from './ops.ts';

type RunStatus = 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'idle';

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
  pausedAt?: string;
  pauseRequested?: boolean;
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
  if (jobStatus === 'paused') return 'paused';
  return 'idle';
}

function readReport(jobId: string): Record<string, unknown> | null {
  const dir = findReportDir(jobId);
  if (!dir) return null;
  try {
    const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Record<string, unknown>;
    // 旧报告没有 reason 字段：从已保存的维度 rationale 补出理由，避免旧会话看起来“没有理由”。
    if (Array.isArray(report.top)) {
      report.top = report.top.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const candidate = item as Record<string, unknown>;
        if (typeof candidate.reason === 'string' && candidate.reason.trim()) return candidate;
        const dimensions = Array.isArray(candidate.dimensions) ? candidate.dimensions : [];
        const reason = dimensions
          .filter((dimension): dimension is Record<string, unknown> => Boolean(dimension) && typeof dimension === 'object')
          .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))
          .slice(0, 2)
          .map((dimension) => `${String(dimension.name ?? dimension.key ?? '评估维度')}：${String(dimension.rationale ?? '')}`)
          .filter((line) => !line.endsWith('：'))
          .join('；');
        return { ...candidate, reason: reason || `结论 ${String(candidate.conclusion ?? '')}` };
      });
    }
    return report;
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
  const providers = new ProviderStore(paths.dataDir);

  const toProviderInput = (body: Record<string, unknown>, existing?: ProviderPublic): ProviderInput => {
    const requested = body.api ?? existing?.api;
    const api: ProviderApi = requested === 'openai-responses' || requested === 'anthropic-messages' || requested === 'openai-chat'
      ? requested
      : 'openai-chat';
    return {
      id: existing?.id ?? (typeof body.id === 'string' ? body.id.trim() : undefined),
      name: String(body.name ?? existing?.name ?? ''),
      baseUrl: String(body.baseUrl ?? existing?.baseUrl ?? ''),
      api,
      flashModel: String(body.flashModel ?? existing?.flashModel ?? ''),
      proModel: String(body.proModel ?? existing?.proModel ?? ''),
      models: Array.isArray(body.models)
        ? body.models
            .map((item) => {
              const model = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
              return { id: String(model.id ?? '').trim(), name: String(model.name ?? model.id ?? '').trim() };
            })
            .filter((model) => model.id)
        : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined,
    };
  };

  const resolveProviderModels = async (input: ProviderInput, existing: ProviderPublic | undefined, apiKey: string | undefined): Promise<void> => {
    if (input.id === 'deepseek' || existing?.builtin) {
      input.flashModel ||= 'deepseek-flash';
      input.proModel ||= 'deepseek-v4-pro';
      return;
    }
    if (input.models?.length) {
      const ids = input.models.map((model) => model.id);
      input.flashModel ||= ids.find((id) => /flash|mini|small|turbo|lite|haiku/i.test(id)) ?? ids[0];
      input.proModel ||= ids.find((id) => /pro|max|large|opus|sonnet|gpt-4|reason/i.test(id)) ?? ids[ids.length - 1] ?? ids[0];
    }
    if (existing?.flashModel && existing?.proModel) {
      input.flashModel ||= existing.flashModel;
      input.proModel ||= existing.proModel;
    }
    if (input.flashModel && input.proModel) return;
    const key = input.apiKey || apiKey;
    if (!key) throw new Error('需要 API Key 才能自动发现模型');
    const result = await fetchModelList(key, input.baseUrl, input.api);
    if (result.ids.length === 0) {
      throw new Error(result.error ?? `无法从 ${result.endpoint} 发现模型；请手动添加模型 ID`);
    }
    const ids = result.ids;
    const flash = ids.find((id) => /flash|mini|small|turbo|lite|haiku/i.test(id)) ?? ids[0];
    const pro = ids.find((id) => /pro|max|large|opus|sonnet|gpt-4|reason/i.test(id)) ?? ids[ids.length - 1] ?? flash;
    input.flashModel ||= flash;
    input.proModel ||= pro;
  };

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
      pausedAt: runtime?.pausedAt ?? null,
      pendingHitl: runtime?.hitl.currentQuestion() ?? null,
      error: runtime?.error ?? null,
      reportAvailable: Boolean(reportDir),
      reportDir,
      summary: runtime?.summary ?? null,
    };
  };

  const makeStreamSink = (listeners: Set<(chunk: StreamToken) => void>) => {
    const previewer = new StreamPreviewer();
    return (chunk: StreamToken): void => {
      let payload = chunk;
      try {
        payload = { ...chunk, preview: previewer.push(chunk) };
      } catch {
        // 解析失败时退回原始 chunk，前端会显示"正在生成"
      }
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch {
          // 前端断开不应中断流水线
        }
      }
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
          shouldPause: () => run.pauseRequested === true,
        });
        run.status = 'completed';
        run.summary = summary;
        run.completedAt = new Date().toISOString();
      } catch (error) {
        if (error instanceof PipelinePausedError) {
          run.status = 'paused';
          run.pausedAt = new Date().toISOString();
          run.completedAt = run.pausedAt;
          try {
            opts.boot.deps.ledger.setJobStatus(run.jobId, 'paused');
            opts.boot.deps.events.emit(run.jobId, 'coordinator', 'run.paused', {
              reason: '用户暂停',
              at: run.pausedAt,
            });
          } catch {
            // 暂停状态已保存在内存，事件失败不掩盖暂停
          }
        } else {
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
        const providerList = await providers.list();
        const ocrLocal = ['chi_sim.traineddata.gz', 'eng.traineddata.gz'].every((name) =>
          existsSync(path.join(paths.ocrDir, name)),
        );
        json(res, 200, {
          ok: true,
          providers: providerList.providers,
          activeProviderId: providerList.activeId,
          ocr: {
            mode: (process.env.BOLE_OCR_MODE ?? 'deepseek').toLowerCase(),
            model: process.env.BOLE_OCR_MODEL ?? config.models.flash,
            fallback: process.env.BOLE_OCR_FALLBACK !== 'false',
            external: Boolean(process.env.BOLE_OCR_URL),
            local: ocrLocal,
          },
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

      if (method === 'GET' && pathname === '/api/providers') {
        const list = await providers.list();
        json(res, 200, { ok: true, ...list });
        return;
      }

      if (method === 'POST' && pathname === '/api/providers') {
        const body = await readJsonBody(req);
        const input = toProviderInput(body);
        let warning: string | undefined;
        try {
          if (input.apiKey) {
            const verification = await verifyDeepSeekKey(input.apiKey, input.baseUrl, input.api, input.id === 'deepseek');
            warning = verification.warning;
          }
          await resolveProviderModels(input, undefined, input.apiKey);
          const saved = await providers.save(input);
          if (body.activate === true) await providers.activate(saved.id);
          const list = await providers.list();
          json(res, 200, { ok: true, saved, ...list, warning });
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      const discoverMatch = /^\/api\/providers\/discover-models$/.exec(pathname);
      if (method === 'POST' && discoverMatch) {
        const body = await readJsonBody(req);
        const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/$/, '');
        if (!/^https?:\/\//i.test(baseUrl)) {
          json(res, 400, { ok: false, error: 'API 地址必须以 http:// 或 https:// 开头' });
          return;
        }
        const apiValue = String(body.api ?? 'openai-chat');
        const api: ProviderApi = apiValue === 'openai-responses' || apiValue === 'anthropic-messages' || apiValue === 'openai-chat'
          ? apiValue
          : 'openai-chat';
        const providerId = String(body.providerId ?? '').trim();
        const apiKey = String(body.apiKey ?? '').trim() || (providerId ? await providers.getKey(providerId) : null);
        if (!apiKey) {
          json(res, 400, { ok: false, error: '请先填写 API 密钥，或先保存提供商' });
          return;
        }
        const result = await fetchModelList(apiKey, baseUrl, api, false);
        if (result.ids.length === 0) {
          json(res, 400, {
            ok: false,
            error: result.error ?? `网关没有返回模型列表（${result.endpoint}）`,
            endpoint: result.endpoint,
          });
          return;
        }
        json(res, 200, {
          ok: true,
          endpoint: result.endpoint,
          models: result.ids.map((id) => ({ id, name: id })),
        });
        return;
      }

      const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname);
      if (providerMatch && (method === 'PATCH' || method === 'DELETE')) {
        const providerId = decodeURIComponent(providerMatch[1]);
        const list = await providers.list();
        const existing = list.providers.find((provider) => provider.id === providerId);
        if (!existing) {
          json(res, 404, { ok: false, error: `提供商不存在：${providerId}` });
          return;
        }
        if (method === 'DELETE') {
          try {
            await providers.remove(providerId);
            const next = await providers.list();
            json(res, 200, { ok: true, ...next });
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        const body = await readJsonBody(req);
        const input = toProviderInput(body, existing);
        let warning: string | undefined;
        try {
          if (input.apiKey) {
            const verification = await verifyDeepSeekKey(input.apiKey, input.baseUrl, input.api, Boolean(existing.builtin));
            warning = verification.warning;
          }
          const existingKey = input.apiKey || (await providers.getKey(existing.id));
          await resolveProviderModels(input, existing, existingKey ?? undefined);
          const saved = await providers.save(input);
          const next = await providers.list();
          json(res, 200, { ok: true, saved, ...next, warning });
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      const activateMatch = /^\/api\/providers\/([^/]+)\/activate$/.exec(pathname);
      if (method === 'POST' && activateMatch) {
        const providerId = decodeURIComponent(activateMatch[1]);
        try {
          const active = await providers.activate(providerId);
          json(res, 200, { ok: true, active, ...(await providers.list()) });
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      const testProviderMatch = /^\/api\/providers\/([^/]+)\/test$/.exec(pathname);
      if (method === 'POST' && testProviderMatch) {
        const providerId = decodeURIComponent(testProviderMatch[1]);
        const list = await providers.list();
        const provider = list.providers.find((item) => item.id === providerId);
        if (!provider) {
          json(res, 404, { ok: false, error: `提供商不存在：${providerId}` });
          return;
        }
        const apiKey = await providers.getKey(providerId);
        if (!apiKey) {
          json(res, 400, { ok: false, error: '该提供商还没有绑定 API Key' });
          return;
        }
        try {
          const verification = await verifyDeepSeekKey(apiKey, provider.baseUrl, provider.api, provider.builtin);
          json(res, 200, { ok: true, verified: verification.verified, warning: verification.warning });
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (method === 'GET' && pathname === '/api/jobs') {
        const jobs = listJobs(200).map((job) => ({
          ...job,
          activeStatus: runs.get(job.id)?.status ?? inferStatus(job.status),
        }));
        json(res, 200, { ok: true, jobs });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
      if (jobMatch && (method === 'PATCH' || method === 'DELETE')) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const job = getJob(jobId);
        if (!job) {
          json(res, 404, { ok: false, error: `会话不存在: ${jobId}` });
          return;
        }
        const runtime = runs.get(jobId);
        const active = runtime?.status === 'running' || runtime?.status === 'pausing';
        if (method === 'DELETE') {
          if (active) {
            json(res, 409, { ok: false, error: '会话正在运行，请先暂停或等待结束再删除' });
            return;
          }
          const removed = deleteJob(jobId);
          runs.delete(jobId);
          json(res, 200, { ok: true, removed });
          return;
        }
        const body = await readJsonBody(req);
        const patch: { title?: string; archived?: boolean; pinned?: boolean } = {};
        if (body.title !== undefined) {
          const title = String(body.title).trim();
          if (title.length < 1 || title.length > 120) {
            json(res, 400, { ok: false, error: '会话标题需为 1-120 个字符' });
            return;
          }
          patch.title = title;
        }
        if (typeof body.archived === 'boolean') patch.archived = body.archived;
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
        if (patch.archived === true && active) {
          json(res, 409, { ok: false, error: '会话正在运行，请先暂停或等待结束再归档' });
          return;
        }
        if (Object.keys(patch).length === 0) {
          json(res, 400, { ok: false, error: '没有可更新的字段' });
          return;
        }
        updateJobMeta(jobId, patch);
        json(res, 200, { ok: true, jobId, ...patch });
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
        const activeProvider = await providers.getActive();
        if (!activeProvider) {
          json(res, 400, { ok: false, error: '尚未配置模型提供商：请先在「设置与模型」中添加。' });
          return;
        }
        if (!activeProvider.apiKey) {
          json(res, 400, { ok: false, error: `模型提供商「${activeProvider.name}」未绑定 API Key。` });
          return;
        }
        const listeners = new Set<(chunk: StreamToken) => void>();
        const boot = await bootstrap({
          requirements,
          stream: makeStreamSink(listeners),
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
            if (runtime.status === 'completed' || runtime.status === 'failed' || runtime.status === 'paused') {
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

      // 对话内附件下载：只允许运行目录中的 docx / pdf（伯乐工具产物）
      const filesMatch = /^\/api\/run\/([^/]+)\/files\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && filesMatch) {
        const jobId = decodeURIComponent(filesMatch[1]);
        const name = decodeURIComponent(filesMatch[2]);
        if (name.includes('..') || !/^[^/\\]+\.(docx|pdf)$/i.test(name)) {
          json(res, 400, { ok: false, error: '非法文件名' });
          return;
        }
        const dir = findReportDir(jobId);
        const file = dir ? path.join(dir, name) : null;
        if (!file || !existsSync(file)) {
          json(res, 404, { ok: false, error: '文件不存在或已清理' });
          return;
        }
        res.statusCode = 200;
        res.setHeader(
          'Content-Type',
          /\.pdf$/i.test(name) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
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

      const pauseMatch = /^\/api\/run\/([^/]+)\/pause$/.exec(pathname);
      if (method === 'POST' && pauseMatch) {
        const jobId = decodeURIComponent(pauseMatch[1]);
        const runtime = runs.get(jobId);
        if (!runtime) {
          json(res, 404, { ok: false, error: '该任务不在当前 Web 会话内，无法暂停' });
          return;
        }
        if (runtime.status !== 'running' && runtime.status !== 'pausing') {
          json(res, 409, { ok: false, error: '当前任务没有在运行，无法暂停' });
          return;
        }
        if (runtime.hitl.currentQuestion()) {
          json(res, 409, { ok: false, error: '当前正在等待人工回答，请先回答后再暂停' });
          return;
        }
        if (runtime.status === 'running') {
          runtime.pauseRequested = true;
          runtime.status = 'pausing';
          try {
            runtime.boot.deps.events.emit(jobId, 'coordinator', 'run.pausing', { reason: '用户请求暂停' });
          } catch {
            // 事件失败不影响暂停请求
          }
        }
        json(res, 200, { ok: true, status: runtime.status, message: '将在当前批次/阶段结束后暂停' });
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
        if (runs.get(jobId)?.status === 'running' || runs.get(jobId)?.status === 'pausing') {
          json(res, 409, { ok: false, error: '该任务正在运行，不能重复启动' });
          return;
        }
        const activeProvider = await providers.getActive();
        if (!activeProvider) {
          json(res, 400, { ok: false, error: '尚未配置模型提供商：请先在「设置与模型」中添加。' });
          return;
        }
        if (!activeProvider.apiKey) {
          json(res, 400, { ok: false, error: `模型提供商「${activeProvider.name}」未绑定 API Key。` });
          return;
        }
        const listeners = new Set<(chunk: StreamToken) => void>();
        const boot = await bootstrap({
          requirements: job.requirements,
          jobId,
          seed: job.seed ?? 'resume',
          stream: makeStreamSink(listeners),
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
        if ([...runs.values()].some((run) => run.status === 'running' || run.status === 'pausing')) {
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
