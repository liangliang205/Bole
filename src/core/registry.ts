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
      if (!Array.isArray(preset.tools) || preset.tools.length === 0) {
        throw new RegistryValidationError(`preset ${id} 未声明工具集`);
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
    return AGENT_IDS.map((id) => this.get(id));
  }
}
