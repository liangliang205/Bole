import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { AgentId, ModelTier } from '../types.ts';
import type { AgentPreset } from '../config.ts';
import { loadAgentRegistry, resolvePaths } from '../config.ts';
import { sha256Hex } from '../util/ids.ts';

export const AGENT_IDS: AgentId[] = [
  'coordinator',
  'profiler',
  'fetcher',
  'parser',
  'assessor',
  'auditor',
];

export const KNOWN_SCHEMAS = new Set([
  'coordinator_plan',
  'jd_analysis',
  'fetch_manifest',
  'parse_resume',
  'evaluate_resume',
  'review_eval',
]);

/**
 * 可执行的 Function Calling 工具白名单。
 * tools 字段里出现未知名字会让注册表启动失败——防止"配置声明了但代码里不存在"的幽灵工具。
 * 新增真实工具时同步这里，并补对应注册表测试。
 */
export const KNOWN_TOOLS = new Set([
  'export_word',
  'office_export_pdf',
  'load_workspace_dependencies',
  'python_exec',
]);

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryValidationError';
  }
}

/**
 * preset 注册表：角色=配置。persona、工具集、模型档、schema、深度预算全部版本化，
 * 换模型档只改 pipeline.json，不改代码。
 */
export class AgentRegistry {
  readonly version: string;
  readonly fingerprint: string;
  private presets: Map<AgentId, AgentPreset>;

  private constructor(version: string, fingerprint: string, presets: Map<AgentId, AgentPreset>) {
    this.version = version;
    this.fingerprint = fingerprint;
    this.presets = presets;
  }
  static bound(presets: Record<string, AgentPreset>, fingerprint: string): AgentRegistry {
    return new AgentRegistry('dynamic-1', fingerprint, new Map(Object.entries(presets)));
  }

  static load(root?: string): AgentRegistry {
    const paths = resolvePaths(root);
    const file = loadAgentRegistry(paths.root);
    const presets = new Map<AgentId, AgentPreset>();
    for (const id of AGENT_IDS) {
      const preset = file.agents[id];
      if (!preset) throw new RegistryValidationError(`preset 缺失: ${id}`);
      if (preset.id !== id) throw new RegistryValidationError(`preset id 不一致: ${preset.id} != ${id}`);
      if (!['flash', 'pro'].includes(preset.tier as ModelTier)) {
        throw new RegistryValidationError(`preset ${id} 的 tier 非法: ${preset.tier}`);
      }
      if (!KNOWN_SCHEMAS.has(preset.outputSchema)) {
        throw new RegistryValidationError(`preset ${id} 的 outputSchema 未注册: ${preset.outputSchema}`);
      }
      if (!Array.isArray(preset.tools) || preset.tools.some((item) => typeof item !== 'string')) {
        throw new RegistryValidationError(`preset ${id} 的 tools 必须是字符串数组`);
      }
      for (const tool of preset.tools) {
        if (!KNOWN_TOOLS.has(tool)) {
          throw new RegistryValidationError(
            `preset ${id} 声明了未实现的工具: ${tool}（已注册：${[...KNOWN_TOOLS].join(', ')}）`,
          );
        }
      }
      if (preset.capabilities !== undefined) {
        if (!Array.isArray(preset.capabilities) || preset.capabilities.some((item) => typeof item !== 'string')) {
          throw new RegistryValidationError(`preset ${id} 的 capabilities 必须是字符串数组`);
        }
      }
      if (preset.mcp !== undefined && (!Array.isArray(preset.mcp) || preset.mcp.some((item) => typeof item !== 'string'))) {
        throw new RegistryValidationError(`preset ${id} 的 mcp 白名单必须是字符串数组`);
      }
      const promptFile = path.join(paths.promptsDir, path.basename(preset.prompt));
      if (!existsSync(promptFile)) {
        throw new RegistryValidationError(`preset ${id} 的提示词文件不存在: ${promptFile}`);
      }
      if (id === 'coordinator') {
        if (!preset.canDelegate || preset.maxDepth < 1) {
          throw new RegistryValidationError('coordinator 必须 canDelegate=true 且 maxDepth>=1');
        }
      } else if (preset.canDelegate || preset.maxDepth !== 0) {
        throw new RegistryValidationError(`子 Agent ${id} 必须 canDelegate=false 且 maxDepth=0（禁止递归派生）`);
      }
      presets.set(id, preset);
    }
    const fingerprint = sha256Hex(
      readFileSync(path.join(paths.configDir, 'agents.json'), 'utf8') +
        readFileSync(path.join(paths.configDir, 'pipeline.json'), 'utf8'),
    ).slice(0, 12);
    return new AgentRegistry(file.version, fingerprint, presets);
  }

  get(id: AgentId): AgentPreset {
    const preset = this.presets.get(id);
    if (!preset) throw new RegistryValidationError(`未注册的 Agent: ${id}`);
    return preset;
  }

  list(): AgentPreset[] {
    return [...this.presets.values()];
  }
}
