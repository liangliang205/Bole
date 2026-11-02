import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths, loadPipelineConfig } from '../config.ts';
import { AgentRegistry } from '../core/registry.ts';
import { Ledger } from '../core/ledger.ts';
import { ProviderStore } from '../settings/provider-store.ts';
import { KnowledgeService } from '../knowledge/service.ts';

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
  const knowledge = new KnowledgeService(paths.knowledgeDbPath);
  try {
    const stats = knowledge.stats();
    checks.push({
      name: '知识库',
      status: stats.enabledBases > 0 ? 'ok' : 'warn',
      detail: `${stats.bases} 个知识库 / ${stats.enabledBases} 已启用 / ${stats.documents} 份文档 / ${stats.chunks} 个分块`,
    });
  } finally {
    knowledge.close();
  }
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
  const activeProvider = await new ProviderStore(paths.dataDir).getActive();
  checks.push({
    name: '模型提供商',
    status: activeProvider?.apiKey ? 'ok' : 'warn',
    detail: activeProvider
      ? `${activeProvider.name}（${activeProvider.api}）· ${activeProvider.flashModel} / ${activeProvider.proModel}${activeProvider.apiKey ? '' : ' · 未绑定 Key'}`
      : '未配置；进入 Web 会提示添加',
  });
  const config = loadPipelineConfig();
  const ocrMode = (process.env.BOLE_OCR_MODE ?? 'deepseek').toLowerCase();
  const ocrModel = process.env.BOLE_OCR_MODEL ?? activeProvider?.flashModel ?? config.models.flash;
  const ocrLocal = Boolean(process.env.BOLE_OCR_URL)
    || ['chi_sim.traineddata.gz', 'eng.traineddata.gz'].every((name) => existsSync(path.join(paths.ocrDir, name)));
  const fallback = process.env.BOLE_OCR_FALLBACK !== 'false';
  if (ocrMode === 'deepseek' || ocrMode === 'auto') {
    const visionReady = Boolean(activeProvider?.builtin && activeProvider.apiKey);
    checks.push({
      name: 'OCR',
      status: visionReady ? 'ok' : 'warn',
      detail: visionReady
        ? `DeepSeek Vision（${ocrModel}）${fallback ? ocrLocal ? ' + 本地回退就绪' : ' + 本地回退未就绪' : ''}`
        : '当前模型提供商不是 DeepSeek 或未绑定 Key；图片 OCR 可能不可用，失败会回退本地 Tesseract',
    });
  } else if (ocrMode === 'local') {
    checks.push({
      name: 'OCR',
      status: ocrLocal ? 'ok' : 'warn',
      detail: ocrLocal ? '本地 Tesseract 语言数据已就绪' : '未下载 OCR 语言数据；请运行 pnpm ocr:download',
    });
  } else if (ocrMode === 'url') {
    checks.push({
      name: 'OCR',
      status: process.env.BOLE_OCR_URL ? 'ok' : 'warn',
      detail: process.env.BOLE_OCR_URL ? '外部 OCR 服务' : 'BOLE_OCR_MODE=url 但未配置 BOLE_OCR_URL',
    });
  } else {
    checks.push({ name: 'OCR', status: 'warn', detail: `未知 BOLE_OCR_MODE=${ocrMode}` });
  }
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
