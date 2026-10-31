import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolvePaths, loadPipelineConfig } from '../config.ts';
import { AgentRegistry } from '../core/registry.ts';
import { Ledger } from '../core/ledger.ts';
import { mapConcurrent } from '../core/pipeline.ts';
import { sleep } from '../util/time.ts';
import { generateGoldenSet } from '../../scripts/generate-golden.ts';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function getAgents(): {
  version: string;
  fingerprint: string;
  agents: {
    id: string;
    nameZh: string;
    role: string;
    tier: string;
    maxDepth: number;
    tools: string[];
    outputSchema: string;
    version: string;
  }[];
} {
  const registry = AgentRegistry.load();
  return {
    version: registry.version,
    fingerprint: registry.fingerprint,
    agents: registry.list().map((agent) => ({
      id: agent.id,
      nameZh: agent.nameZh,
      role: agent.role,
      tier: agent.tier,
      maxDepth: agent.maxDepth,
      tools: agent.tools,
      outputSchema: agent.outputSchema,
      version: agent.version,
    })),
  };
}

export function getDoctor(): { checks: DoctorCheck[] } {
  const paths = resolvePaths();
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    status: nodeMajor >= 22 ? 'ok' : 'fail',
    detail: `${process.versions.node}（需要 >= 22.6）`,
  });
  for (const file of ['config/agents.json', 'config/pipeline.json']) {
    checks.push({
      name: file,
      status: existsSync(`${paths.root}/${file}`) ? 'ok' : 'fail',
      detail: existsSync(`${paths.root}/${file}`) ? '存在' : '缺失',
    });
  }
  const inboxCount = existsSync(paths.inboxDir)
    ? readdirSync(paths.inboxDir).filter((name) => name.endsWith('.eml')).length
    : 0;
  checks.push({
    name: '黄金邮箱',
    status: inboxCount > 0 ? 'ok' : 'warn',
    detail: inboxCount > 0 ? `${inboxCount} 封 .eml` : '为空，请先运行 seed',
  });
  const knowledgeCount = existsSync(paths.knowledgeDir)
    ? readdirSync(paths.knowledgeDir).filter((name) => name.endsWith('.md')).length
    : 0;
  checks.push({
    name: 'RAG 知识库',
    status: knowledgeCount > 0 ? 'ok' : 'warn',
    detail: `${knowledgeCount} 个文档`,
  });
  try {
    const registry = AgentRegistry.load();
    checks.push({ name: 'Agent preset', status: 'ok', detail: `${registry.list().length} 个 / ${registry.fingerprint}` });
  } catch (error) {
    checks.push({
      name: 'Agent preset',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const ledger = new Ledger(paths.dbPath);
    const jobs = ledger.listJobs().length;
    ledger.close();
    checks.push({ name: '台账', status: 'ok', detail: `可写，${jobs} 个历史任务` });
  } catch (error) {
    checks.push({ name: '台账', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
  checks.push({
    name: 'DeepSeek Key',
    status: process.env.DEEPSEEK_API_KEY ? 'ok' : 'warn',
    detail: process.env.DEEPSEEK_API_KEY ? '环境变量已配置' : '未配置（mock 可运行）',
  });
  const config = loadPipelineConfig();
  checks.push({
    name: '模型档位',
    status: 'ok',
    detail: `flash=${config.models.flash} / pro=${config.models.pro}；深评 ${config.deepEval.percent}% → ${config.deepEval.tier}`,
  });
  return { checks };
}

export interface BenchRow {
  concurrency: number;
  throughput: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  success: number;
  items: number;
}

export async function runBench(options: { items?: number; latency?: number; concurrency?: number[] } = {}): Promise<{
  rows: BenchRow[];
  speedup: number;
  items: number;
  latency: number;
}> {
  const items = Math.max(1, Math.min(500, Number(options.items ?? 60)));
  const latency = Math.max(0, Math.min(500, Number(options.latency ?? 8)));
  const levels = (options.concurrency ?? [1, 4, 8]).filter((value) => Number.isInteger(value) && value > 0);
  const rows: BenchRow[] = [];
  for (const level of levels) {
    const durations: number[] = [];
    const started = performance.now();
    await mapConcurrent(Array.from({ length: items }, (_, index) => index), level, async () => {
      const taskStart = performance.now();
      await sleep(latency);
      durations.push(performance.now() - taskStart);
    });
    const totalMs = performance.now() - started;
    durations.sort((a, b) => a - b);
    rows.push({
      concurrency: level,
      throughput: Number(((items / totalMs) * 1000).toFixed(1)),
      totalMs: Math.round(totalMs),
      p50Ms: Math.round(durations[Math.floor(durations.length * 0.5)] ?? 0),
      p95Ms: Math.round(durations[Math.floor(durations.length * 0.95)] ?? 0),
      success: durations.length,
      items,
    });
  }
  const baseline = rows.find((row) => row.concurrency === 1)?.throughput ?? rows[0]?.throughput ?? 1;
  const best = rows.reduce((max, row) => Math.max(max, row.throughput), baseline);
  return { rows, speedup: Number((best / Math.max(baseline, 0.001)).toFixed(2)), items, latency };
}

export async function seedGolden(): Promise<{ messages: number; files: number; inboxDir: string }> {
  return generateGoldenSet();
}

export function resetAll(): { removed: string[] } {
  const paths = resolvePaths();
  const removed: string[] = [];
  for (const file of [paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`, `${paths.dbPath}-journal`]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push(file);
    }
  }
  if (existsSync(paths.runsDir)) {
    rmSync(paths.runsDir, { recursive: true, force: true });
    removed.push(paths.runsDir);
  }
  return { removed };
}
