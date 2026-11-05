import path from 'node:path';
import { AgentStore } from './agent-platform/store.ts';
import { MemoryService } from './memory/service.ts';
import { ApprovalStore, parseExecutionMode, type ExecutionMode } from './core/approvals.ts';
import { randomBytes } from 'node:crypto';
import { loadPipelineConfig, resolvePaths } from './config.ts';
import { AgentRegistry } from './core/registry.ts';
import { Ledger } from './core/ledger.ts';
import { EventLog } from './core/events.ts';
import { RagIndex } from './tools/rag.ts';
import { KnowledgeService } from './knowledge/service.ts';
import { LlmRouter } from './llm/router.ts';
import { DeepSeekProvider } from './llm/deepseek.ts';
import { ProviderStore } from './settings/provider-store.ts';
import { ensureDir, writeJson } from './util/fsx.ts';
import type { AgentDeps } from './agents/deps.ts';
import type { LlmProvider } from './llm/provider.ts';
import type { JobRow, StreamSink } from './types.ts';

export interface BootstrapOptions {
  agentTeamKey?: string;
  policyVersionId?: string;
  executionMode?: ExecutionMode;
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
  let registry = AgentRegistry.load(paths.root);
  const ledger = new Ledger(paths.dbPath);
  const events = new EventLog(ledger);
  const rag = new RagIndex([]);

  let provider: LlmProvider;
  let providerIdentity: string;
  let models: { flash: string; pro: string };
  if (opts.provider) {
    provider = opts.provider;
    providerIdentity = provider.name;
    models = {
      flash: process.env.BOLE_FLASH_MODEL ?? config.models.flash,
      pro: process.env.BOLE_PRO_MODEL ?? config.models.pro,
    };
  } else {
    const store = new ProviderStore(paths.dataDir);
    const active = await store.getActive();
    if (!active) {
      ledger.close();
      throw new Error('尚未配置模型提供商：请先在 Web「设置与模型」中添加并选择提供商。');
    }
    const apiKey = opts.deepseekApiKey?.trim() || active.apiKey;
    if (!apiKey) {
      ledger.close();
      throw new Error(`模型提供商「${active.name}」未绑定 API Key：请在设置中填写。`);
    }
    provider = new DeepSeekProvider({
      apiKey,
      baseUrl: active.baseUrl,
      protocol: active.api,
      deepseekStyle: active.builtin,
      name: active.name,
    });
    providerIdentity = JSON.stringify({ id: active.id, baseUrl: active.baseUrl, api: active.api });
    models = {
      flash: process.env.BOLE_FLASH_MODEL ?? active.flashModel,
      pro: process.env.BOLE_PRO_MODEL ?? active.proModel,
    };
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
  if (!opts.jobId) new ApprovalStore(ledger).setMode(job.id, parseExecutionMode(opts.executionMode));
  if (opts.policyVersionId) {
    if (opts.jobId) { ledger.close(); throw new Error('续跑不能更换评分标准'); }
    try { new MemoryService(ledger).selectPolicy(job.id, opts.policyVersionId); }
    catch (error) { ledger.deleteJob(job.id); ledger.close(); throw error; }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const agentStore = new AgentStore(ledger);
  try {
    agentStore.seed(paths.root);
    if (opts.jobId && opts.agentTeamKey && agentStore.manifest(job.id)?.teamKey !== opts.agentTeamKey) throw new Error('续跑不能切换已绑定的 Agent 团队');
    const manifest = agentStore.bind(job.id, opts.agentTeamKey ?? 'builtin@1.0.0', models, provider.name, Boolean(opts.jobId), providerIdentity);
    registry = agentStore.registry(manifest);
    models = manifest.models;
  } catch (error) { ledger.close(); throw error; }
  const runId = opts.runId ?? `run_${stamp}_${randomBytes(3).toString('hex')}`;
  const runDir = path.join(paths.runsDir, runId);
  await ensureDir(runDir);
  const knowledge = new KnowledgeService(paths.knowledgeDbPath);

  const llm = new LlmRouter({
    provider,
    providerIdentity,
    pricing: config.pricing,
    models,
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
    knowledge,
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
    models: { flash: models.flash, pro: models.pro },
    startedTs: new Date().toISOString(),
  });

  ledger.appendEvent(job.id, 'coordinator', 'run.created', {
    runId,
    provider: provider.name,
    seed,
    registryFingerprint: registry.fingerprint,
  });

  return { deps, job, close: () => { knowledge.close(); ledger.close(); } };
}
