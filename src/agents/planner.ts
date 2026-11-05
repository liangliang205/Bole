import { loadSkill } from '../config.ts';
import { roleKnowledge } from './knowledge.ts';
import { AgentStore } from '../agent-platform/store.ts';
import { screeningPlanSchema, type ScreeningPlanOutput } from '../schemas.ts';
import type { AgentDeps } from './deps.ts';
import { sharedPrefix, systemPrompt } from './prompts.ts';
import { callAgentJson } from './structured-call.ts';

export interface ScreeningInventory {
  usable: number;
  duplicates: number;
  failed: number;
  formats: Record<string, number>;
  resumeOnly: boolean;
  defaults: {
    batchSize: number;
    maxBatchesInFlight: number;
    maxActiveAgents: number;
    pools: { parse: number; assess: number; review: number };
    deepEval: { enabled: boolean; percent: number };
  };
}

export interface ScreeningPlan extends ScreeningPlanOutput {
  source: 'agent' | 'fallback';
}

/** 硬边界只用于安全钳制，不参与“要不要扇出”的判断；判断来自 Agent + skill。 */
const BOUNDS = {
  batchSize: [1, 16] as const,
  maxBatchesInFlight: [1, 4] as const,
  maxActiveAgents: [1, 12] as const,
  parse: [1, 8] as const,
  assess: [1, 8] as const,
  review: [1, 4] as const,
};

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalize(plan: ScreeningPlanOutput, inventory: ScreeningInventory): ScreeningPlanOutput {
  const single = plan.mode === 'single';
  return {
    mode: plan.mode,
    batchSize: single ? Math.max(1, inventory.usable) : clamp(plan.batchSize, BOUNDS.batchSize),
    maxBatchesInFlight: single ? 1 : clamp(plan.maxBatchesInFlight, BOUNDS.maxBatchesInFlight),
    maxActiveAgents: single ? 1 : clamp(plan.maxActiveAgents, BOUNDS.maxActiveAgents),
    deepEval: {
      enabled: plan.deepEval.enabled,
      percent: Math.min(100, Math.max(0, plan.deepEval.percent)),
    },
    pools: single
      ? { parse: 1, assess: 1, review: 1 }
      : {
          parse: clamp(plan.pools.parse, BOUNDS.parse),
          assess: clamp(plan.pools.assess, BOUNDS.assess),
          review: clamp(plan.pools.review, BOUNDS.review),
        },
    reason: plan.reason.trim(),
  };
}

function fallbackPlan(inventory: ScreeningInventory, errors: string[]): ScreeningPlan {
  const d = inventory.defaults;
  return {
    mode: 'batch',
    batchSize: d.batchSize,
    maxBatchesInFlight: d.maxBatchesInFlight,
    maxActiveAgents: d.maxActiveAgents,
    deepEval: d.deepEval,
    pools: d.pools,
    reason: `规划 Agent 不可用，使用配置默认值（${errors.join('；').slice(0, 120)}）`,
    source: 'fallback',
  };
}

/**
 * 上传/接入完成后，由主 Agent 阅读 screening-plan skill，决定是否扇出与各阶段并发。
 * 代码只做边界钳制与执行；失败时回退到配置默认值，保证流水线可用。
 */
export async function planScreening(deps: AgentDeps, inventory: ScreeningInventory): Promise<ScreeningPlan> {
  const skill = new AgentStore(deps.ledger).manifest(deps.jobId)?.bindings.coordinator.definition.skills.find((s) => s.id === 'screening-plan')?.content ?? loadSkill('screening-plan', deps.paths);
  const user = [
    '【简历清单】',
    `usable=${inventory.usable}；duplicates=${inventory.duplicates}；failed=${inventory.failed}；resume_only=${inventory.resumeOnly}`,
    `formats=${JSON.stringify(inventory.formats)}`,
    '',
    '【当前配置默认值】',
    `batchSize=${inventory.defaults.batchSize}；maxBatchesInFlight=${inventory.defaults.maxBatchesInFlight}；maxActiveAgents=${inventory.defaults.maxActiveAgents}；pools=${JSON.stringify(inventory.defaults.pools)}；deepEval=${JSON.stringify(inventory.defaults.deepEval)}`,
    '',
    '【硬边界（超出会被钳制）】',
    `batchSize=${BOUNDS.batchSize[0]}-${BOUNDS.batchSize[1]}；maxBatchesInFlight=${BOUNDS.maxBatchesInFlight[0]}-${BOUNDS.maxBatchesInFlight[1]}；maxActiveAgents=${BOUNDS.maxActiveAgents[0]}-${BOUNDS.maxActiveAgents[1]}；pools.parse=${BOUNDS.parse[0]}-${BOUNDS.parse[1]}；pools.assess=${BOUNDS.assess[0]}-${BOUNDS.assess[1]}；pools.review=${BOUNDS.review[0]}-${BOUNDS.review[1]}`,
    '',
    '【任务】阅读 screening-plan skill，决定是否扇出（single/batch）、批大小、在途批数、统一子 Agent 总上限、各阶段并发与是否深评；理由必须结合上面的清单，不要套用固定数字。',
  ].join('\n');

  const result = await callAgentJson(deps, {
    agent: 'coordinator',
    tier: 'pro',
    schemaName: 'screening_plan',
    schema: screeningPlanSchema,
    system: `${systemPrompt(deps, 'coordinator')}\n\n${skill}`,
    user: user + await roleKnowledge(deps, 'coordinator', deps.ledger.getJob(deps.jobId)?.requirements ?? ''),
    sharedPrefix: sharedPrefix(deps, 'coordinator', [skill]),
    phase: 'screening_plan',
    label: '筛选计划',
    meta: { inventory, skill: 'screening-plan' },
  });

  if (!result.ok) return fallbackPlan(inventory, result.errors);
  return { ...normalize(result.value, inventory), source: 'agent' };
}
