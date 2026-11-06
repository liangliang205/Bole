import { loadPrompt, loadSkill } from '../config.ts';
import { createHash } from 'node:crypto';
import type { AgentId } from '../types.ts';
import type { AgentDeps } from './deps.ts';

const promptCache = new Map<string, string>();

export function systemPrompt(deps: AgentDeps, id: AgentId): string {
  const preset = deps.registry.get(id);
  const policy = ['profiler', 'parser', 'assessor', 'auditor'].includes(id) ? loadSkill('evidence-calibration', deps.paths) : '';
  const key = `${preset.definitionHash ?? `${preset.id}@${preset.version}:${deps.paths.root}`}:${createHash('sha256').update(policy).digest('hex')}`;
  const cached = promptCache.get(key);
  if (cached) return cached;
  const prompt = loadPrompt(preset, deps.paths) + (policy ? `\n\n【平台技能 evidence-calibration@1.0.0】\n${policy}` : '');
  promptCache.set(key, prompt);
  return prompt;
}

/**
 * 缓存前缀：系统提示词 + 工具池 + 稳定参考（评分卡/JD）组成共享常量前缀。
 * 每份简历/每次评估的差异内容只放在请求末尾，从而最大化前缀缓存命中。
 */
export function sharedPrefix(deps: AgentDeps, id: AgentId, stableParts: string[] = []): string {
  const preset = deps.registry.get(id);
  return [
    systemPrompt(deps, id),
    preset.tools.length ? `【工具池】${preset.tools.join(', ')}` : '',
    `【深度预算】maxDepth=${preset.maxDepth}，禁止再委派`,
    ...stableParts,
  ].filter(Boolean).join('\n\n');
}

export function taskBook(input: {
  task: string;
  inputs: Record<string, string>;
  references?: string[];
  schemaName: string;
  completion: string;
  boundary?: string;
}): string {
  const lines = [`【任务】${input.task}`];
  lines.push(`【输入】${Object.entries(input.inputs).map(([k, v]) => `${k}=${v}`).join('；')}`);
  if (input.references && input.references.length > 0) {
    lines.push('【参考】');
    for (const ref of input.references) lines.push(`- ${ref}`);
  }
  lines.push(`【输出 schema】${input.schemaName}`);
  lines.push(`【完成标准】${input.completion}`);
  lines.push(`【边界】${input.boundary ?? 'maxDepth=0；禁止再委派；禁止读取未授权数据'}`);
  return lines.join('\n');
}
