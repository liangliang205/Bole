import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths, loadPipelineConfig } from '../config.ts';
import { AgentRegistry } from '../core/registry.ts';
import { Ledger } from '../core/ledger.ts';
import { KeyStore } from '../settings/key-store.ts';

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

export async function getDoctor(): Promise<{ checks: DoctorCheck[] }> {
  const paths = resolvePaths();
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js', status: nodeMajor >= 22 ? 'ok' : 'fail', detail: `${process.versions.node}（需要 >= 22.6）` });
  for (const file of ['config/agents.json', 'config/pipeline.json']) {
    const full = path.join(paths.root, file);
    checks.push({ name: file, status: existsSync(full) ? 'ok' : 'fail', detail: existsSync(full) ? '存在' : '缺失' });
  }
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
    checks.push({ name: 'Agent preset', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const ledger = new Ledger(paths.dbPath);
    const jobs = ledger.listJobs().length;
    ledger.close();
    checks.push({ name: '台账', status: 'ok', detail: `可写，${jobs} 个历史任务` });
  } catch (error) {
    checks.push({ name: '台账', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
  const keyStatus = await new KeyStore(paths.dataDir).status();
  checks.push({
    name: 'DeepSeek Key',
    status: keyStatus.bound ? 'ok' : 'warn',
    detail: keyStatus.bound ? `已绑定 ${keyStatus.masked ?? ''}（服务端持久化）` : '未绑定；进入 Web 会提示绑定',
  });
  const ocrReady = Boolean(process.env.BOLE_OCR_URL)
    || ['chi_sim.traineddata.gz', 'eng.traineddata.gz'].every((name) => existsSync(path.join(paths.ocrDir, name)));
  checks.push({
    name: 'OCR',
    status: ocrReady ? 'ok' : 'warn',
    detail: process.env.BOLE_OCR_URL
      ? '使用外部 OCR 服务'
      : ocrReady
        ? '本地 OCR 语言数据已就绪'
        : '未下载 OCR 语言数据；图片简历会失败，请运行 pnpm ocr:download',
  });
  const config = loadPipelineConfig();
  checks.push({
    name: '模型档位',
    status: 'ok',
    detail: `flash=${config.models.flash} / pro=${config.models.pro}；深评 ${config.deepEval.percent}% → ${config.deepEval.tier}`,
  });
  return { checks };
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
  for (const dir of [paths.runsDir, paths.uploadsDir]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return { removed };
}
