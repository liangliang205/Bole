import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './util/fsx.ts';
import type { AgentId, ModelTier } from './types.ts';

export interface AgentPreset {
  id: AgentId;
  nameZh: string;
  role: string;
  tier: ModelTier;
  tools: string[];
  maxDepth: number;
  canDelegate: boolean;
  outputSchema: string;
  prompt: string;
  version: string;
}

export interface AgentRegistryFile {
  version: string;
  agents: Record<AgentId, AgentPreset>;
}

export interface PipelineConfig {
  version: string;
  batchSize: number;
  maxBatchesInFlight: number;
  pools: { parse: number; assess: number; review: number };
  admission: { maxRefusalRetries: number; baseBackoffMs: number; maxBackoffMs: number };
  selfLoop: { maxLoops: number };
  deepEval: { enabled: boolean; percent: number; tier: ModelTier };
  structuredOutput: { maxAttempts: number };
  topN: number;
  conclusionScale: Record<string, number>;
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheHitPerMTok: number }>;
  models: Record<ModelTier, string>;
  bench: { concurrency: number[]; itemsPerRun: number; simulatedLatencyMs: number };
  fairness: { protectedCategories: string[] };
}

export interface BolePaths {
  root: string;
  configDir: string;
  dataDir: string;
  inboxDir: string;
  knowledgeDir: string;
  indexDir: string;
  goldenDir: string;
  runsDir: string;
  dbPath: string;
  promptsDir: string;
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function resolvePaths(root = projectRoot()): BolePaths {
  const dataDir = process.env.BOLE_DATA_DIR ?? path.join(root, 'data');
  return {
    root,
    configDir: path.join(root, 'config'),
    dataDir,
    inboxDir: process.env.BOLE_INBOX ?? path.join(dataDir, 'inbox'),
    knowledgeDir: process.env.BOLE_KNOWLEDGE ?? path.join(dataDir, 'knowledge'),
    indexDir: path.join(dataDir, 'index'),
    goldenDir: path.join(dataDir, 'golden'),
    runsDir: process.env.BOLE_RUNS ?? path.join(root, 'runs'),
    dbPath: process.env.BOLE_DB ?? path.join(dataDir, 'ledger.db'),
    promptsDir: path.join(root, 'config', 'prompts'),
  };
}

export function loadPipelineConfig(root = projectRoot()): PipelineConfig {
  const file = path.join(root, 'config', 'pipeline.json');
  const cfg = readJsonFile<PipelineConfig>(file);
  if (process.env.BOLE_BATCH_SIZE) cfg.batchSize = Number(process.env.BOLE_BATCH_SIZE);
  if (process.env.BOLE_MAX_BATCHES_IN_FLIGHT) cfg.maxBatchesInFlight = Number(process.env.BOLE_MAX_BATCHES_IN_FLIGHT);
  if (process.env.BOLE_DEEP_EVAL_PERCENT) cfg.deepEval.percent = Number(process.env.BOLE_DEEP_EVAL_PERCENT);
  return cfg;
}

export function loadAgentRegistry(root = projectRoot()): AgentRegistryFile {
  return readJsonFile<AgentRegistryFile>(path.join(root, 'config', 'agents.json'));
}

export function loadPrompt(preset: AgentPreset, paths = resolvePaths()): string {
  const file = path.join(paths.promptsDir, path.basename(preset.prompt));
  if (!existsSync(file)) throw new Error(`缺少提示词文件: ${file}`);
  return readFileSync(file, 'utf8');
}

export function loadKnowledge(paths = resolvePaths()): { file: string; title: string; text: string }[] {
  if (!existsSync(paths.knowledgeDir)) return [];
  return readdirSync(paths.knowledgeDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({
      file: path.join(paths.knowledgeDir, name),
      title: name.replace(/\.md$/, ''),
      text: readFileSync(path.join(paths.knowledgeDir, name), 'utf8'),
    }));
}

export function describeAgent(preset: AgentPreset): string {
  return `${preset.nameZh}(${preset.id}) tier=${preset.tier} maxDepth=${preset.maxDepth} v${preset.version}`;
}

export const TIER_MODEL_ENV: Record<ModelTier, string> = {
  flash: 'BOLE_FLASH_MODEL',
  pro: 'BOLE_PRO_MODEL',
};
