import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadPipelineConfig, resolvePaths } from './config.ts';
import { AgentRegistry } from './core/registry.ts';
import { Ledger } from './core/ledger.ts';
import { EventLog } from './core/events.ts';
import { RagIndex } from './tools/rag.ts';
import { LlmRouter } from './llm/router.ts';
import { MockProvider } from './llm/mock.ts';
import { DeepSeekProvider } from './llm/deepseek.ts';
import { ensureDir, writeJson } from './util/fsx.ts';
import type { FaultInjection, AgentDeps } from './agents/deps.ts';
import type { JobRow } from './types.ts';

export interface BootstrapOptions {
  requirements: string;
  seed?: string;
  llm?: 'mock' | 'deepseek';
  cacheAlignment?: boolean;
  faults?: FaultInjection;
  jobId?: string;
  runId?: string;
  mockLatencyMs?: number;
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
      seed: opts.seed ?? 'demo-2026',
    });
  }
  const seed = opts.seed ?? job.seed ?? 'demo-2026';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runId = opts.runId ?? `run_${stamp}_${randomBytes(3).toString('hex')}`;
  const runDir = path.join(paths.runsDir, runId);
  await ensureDir(runDir);

  const providerKind = opts.llm ?? (process.env.BOLE_LLM as 'mock' | 'deepseek' | undefined) ?? 'mock';
  const provider =
    providerKind === 'deepseek'
      ? new DeepSeekProvider({})
      : new MockProvider({
          latencyMs: opts.mockLatencyMs ?? Number(process.env.BOLE_MOCK_LATENCY_MS ?? 0),
          invalidSchemaOnce: opts.faults?.invalidSchemaFor,
          faults: { fabricate: opts.faults?.fabricate, bias: opts.faults?.bias },
        });

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
    faults: opts.faults,
  };

  await writeJson(path.join(runDir, 'run.json'), {
    runId,
    jobId: job.id,
    seed,
    provider: providerKind,
    cacheAlignment: opts.cacheAlignment ?? true,
    registryFingerprint: registry.fingerprint,
    registryVersion: registry.version,
    models: { flash: config.models.flash, pro: config.models.pro },
    faults: opts.faults ?? {},
    startedTs: new Date().toISOString(),
  });

  ledger.appendEvent(job.id, 'coordinator', 'run.created', {
    runId,
    provider: providerKind,
    seed,
    registryFingerprint: registry.fingerprint,
  });

  return { deps, job, close: () => ledger.close() };
}
