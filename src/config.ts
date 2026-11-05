import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './util/fsx.ts';
import type { AgentId, ModelTier } from './types.ts';

export interface AgentPreset {
  promptContent?: string;
  definitionHash?: string;
  id: AgentId;
  nameZh: string;
  role: string;
  tier: ModelTier;
  /** 可执行的 Function Calling 工具（仅声明真实存在的工具；流水线角色通常为空）。 */
  tools: string[];
  /** 声明式能力标签：说明该角色在代码里实际调用哪些能力，不参与工具绑定。 */
  capabilities?: string[];
  /**
   * 可用的外接 MCP 工具白名单：'*'、'server'、'server:tool'、'server:*'。
   * 缺省或空数组 = 该 Agent 不允许调用任何外接 MCP 工具。
   */
  mcp?: string[];
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
  /** 统一子 Agent 总并发上限（跨解析/评估/核查共享）。 */
  maxActiveAgents: number;
  pools: { parse: number; assess: number; review: number };
  admission: { maxRefusalRetries: number; baseBackoffMs: number; maxBackoffMs: number };
  selfLoop: { maxLoops: number };
  deepEval: { enabled: boolean; percent: number; tier: ModelTier };
  structuredOutput: { maxAttempts: number };
  topN: number;
  conclusionScale: Record<string, number>;
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheHitPerMTok: number; offPeakMultiplier?: number }>;
  models: Record<ModelTier, string>;
  fairness: { protectedCategories: string[] };
}

export interface BolePaths {
  root: string;
  configDir: string;
  dataDir: string;
  uploadsDir: string;
  ocrDir: string;
  knowledgeDir: string;
  knowledgeDbPath: string;
  indexDir: string;
  runsDir: string;
  dbPath: string;
  promptsDir: string;
  skillsDir: string;
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
    uploadsDir: process.env.BOLE_UPLOADS ?? path.join(dataDir, 'uploads'),
    ocrDir: process.env.BOLE_OCR_DIR ?? path.join(dataDir, 'ocr'),
    knowledgeDir: process.env.BOLE_KNOWLEDGE ?? path.join(dataDir, 'knowledge'),
    knowledgeDbPath: process.env.BOLE_KNOWLEDGE_DB ?? path.join(dataDir, 'knowledge.db'),
    indexDir: path.join(dataDir, 'index'),
    runsDir: process.env.BOLE_RUNS ?? path.join(root, 'runs'),
    dbPath: process.env.BOLE_DB ?? path.join(dataDir, 'ledger.db'),
    promptsDir: path.join(root, 'config', 'prompts'),
    skillsDir: path.join(root, 'config', 'skills'),
  };
}

export function loadPipelineConfig(root = projectRoot()): PipelineConfig {
  const file = path.join(root, 'config', 'pipeline.json');
  const cfg = readJsonFile<PipelineConfig>(file);
  cfg.maxActiveAgents ??= 8;
  if (process.env.BOLE_BATCH_SIZE) cfg.batchSize = Number(process.env.BOLE_BATCH_SIZE);
  if (process.env.BOLE_MAX_BATCHES_IN_FLIGHT) cfg.maxBatchesInFlight = Number(process.env.BOLE_MAX_BATCHES_IN_FLIGHT);
  if (process.env.BOLE_MAX_ACTIVE_AGENTS) cfg.maxActiveAgents = Number(process.env.BOLE_MAX_ACTIVE_AGENTS);
  if (process.env.BOLE_DEEP_EVAL_PERCENT) cfg.deepEval.percent = Number(process.env.BOLE_DEEP_EVAL_PERCENT);
  return cfg;
}

export function loadAgentRegistry(root = projectRoot()): AgentRegistryFile {
  return readJsonFile<AgentRegistryFile>(path.join(root, 'config', 'agents.json'));
}

export function loadPrompt(preset: AgentPreset, paths = resolvePaths()): string {
  if (preset.promptContent !== undefined) return preset.promptContent;
  const file = path.join(paths.promptsDir, path.basename(preset.prompt));
  if (!existsSync(file)) throw new Error(`缺少提示词文件: ${file}`);
  return readFileSync(file, 'utf8');
}

/** 加载 skill：放在 config/skills/<name>.md，作为角色提示词的补充说明（可测试、可版本化）。 */
export function loadSkill(name: string, paths = resolvePaths()): string {
  const file = path.join(paths.skillsDir, `${name}.md`);
  if (!existsSync(file)) throw new Error(`缺少 skill 文件: ${file}`);
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
