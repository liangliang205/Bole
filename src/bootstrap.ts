import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadPipelineConfig, resolvePaths } from './config.ts';
import { AgentRegistry } from './core/registry.ts';
import { Ledger } from './core/ledger.ts';
import { EventLog } from './core/events.ts';
import { RagIndex } from './tools/rag.ts';
import { LlmRouter } from './llm/router.ts';
import { DeepSeekProvider } from './llm/deepseek.ts';
import { ensureDir, writeJson } from './util/fsx.ts';
import type { AgentDeps } from './agents/deps.ts';
import type { LlmProvider } from './llm/provider.ts';
import type { JobRow, StreamSink } from './types.ts';

export interface BootstrapOptions {
  requirements: string;
  seed?: string;
  deepseekApiKey?: string;
  cacheAlignment?: boolean;
  jobId?: string;
  runId?: string;
  /** 测试/自定义网关注入；生产默认 DeepSeek。 */
  provider?: LlmProvider;
  /** SSE token 流回调。 */
  stream?: StreamSink;
}

export interface Bootstrapped {
  deps: AgentDeps;
  job: JobRow;
  close: () => void;
}

export async function bootstrap(opts: BootstrapOptions): Promise<Bootstrapped> {
  const paths = resolvePaths();
  const config = loadPipelineConfig(paths.root);
  const registry = AgentRegistry.load(paths.root);
  const ledger = new Ledger(paths.dbPath);
  const events = new EventLog(ledger);
  const rag = RagIndex.loadOrBuild(paths.knowledgeDir, paths.indexDir);

  if (!opts.provider && !opts.deepseekApiKey) {
    ledger.close();
    throw new Error('未绑定 DeepSeek API Key：请先在 Web 页面完成绑定（服务端持久化，只需一次）。');
  }

  let job: JobRow;
  if (opts.jobId) {
    const existing = ledger.getJob(opts.jobId);
    if (!existing) {
      ledger.close();
      throw new Error(`任务不存在: ${opts.jobId}`);
    }
    job = existing;
  } else {
    job = ledger.createJob({
      title: '待画像岗位',
      requirements: opts.requirements,
      seed: opts.seed ?? 'live',
    });
  }
  const seed = opts.seed ?? job.seed ?? 'live';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runId = opts.runId ?? `run_${stamp}_${randomBytes(3).toString('hex')}`;
  const runDir = path.join(paths.runsDir, runId);
  await ensureDir(runDir);

  const provider = opts.provider ?? new DeepSeekProvider({ apiKey: opts.deepseekApiKey });
  const llm = new LlmRouter({
    provider,
    pricing: config.pricing,
    models: {
      flash: process.env.BOLE_FLASH_MODEL ?? config.models.flash,
      pro: process.env.BOLE_PRO_MODEL ?? config.models.pro,
    },
    ledger,
    jobId: job.id,
    cacheAlignment: opts.cacheAlignment ?? true,
  });

  const deps: AgentDeps = {
    ledger,
    events,
    llm,
    registry,
    config,
    paths,
    runId,
    runDir,
    jobId: job.id,
    seed,
    rag,
    stream: opts.stream,
  };

  await writeJson(path.join(runDir, 'run.json'), {
    runId,
    jobId: job.id,
    seed,
    provider: provider.name,
    cacheAlignment: opts.cacheAlignment ?? true,
    registryFingerprint: registry.fingerprint,
    registryVersion: registry.version,
    models: { flash: config.models.flash, pro: config.models.pro },
    startedTs: new Date().toISOString(),
  });

  ledger.appendEvent(job.id, 'coordinator', 'run.created', {
    runId,
    provider: provider.name,
    seed,
    registryFingerprint: registry.fingerprint,
  });

  return { deps, job, close: () => ledger.close() };
}
