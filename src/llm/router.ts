import type { ChatRequest, ChatResult, ModelTier, StopReason } from '../types.ts';
import { AgentStore } from '../agent-platform/store.ts';
import { currentExecutionId } from '../scheduler/execution.ts';
import { nodeExecution } from '../scheduler/context.ts';
import { createHash } from 'node:crypto';
import type { Ledger } from '../core/ledger.ts';
import { computeCost, type PricingTable } from './cost.ts';
import type { LlmProvider } from './provider.ts';
import { schemaInstruction } from '../schemas.ts';

export interface LlmCallRecord {
  agent: string;
  schemaName: string;
  tier: ModelTier;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheHit: boolean;
  cacheAligned: boolean;
}

export interface LlmRouterOptions {
  providerIdentity?: string;
  provider: LlmProvider;
  pricing: PricingTable;
  models: Record<ModelTier, string>;
  ledger?: Ledger;
  jobId?: string;
  cacheAlignment?: boolean;
  onCall?: (record: LlmCallRecord) => void;
}

export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * 模型路由：tier → model 映射写死在配置里；统一记账、缓存前缀对齐与成本核算。
 * 真实 provider 与 mock provider 走同一条路由，切换只改构造参数。
 */
export class LlmRouter {
  private providerIdentity?: string;
  readonly provider: LlmProvider;
  readonly cacheAlignment: boolean;
  private pricing: PricingTable;
  private models: Record<ModelTier, string>;
  private ledger?: Ledger;
  private jobId?: string;
  private onCall?: (record: LlmCallRecord) => void;
  private records: LlmCallRecord[] = [];

  constructor(opts: LlmRouterOptions) {
    this.provider = opts.provider;
    this.providerIdentity = opts.providerIdentity;
    this.pricing = opts.pricing;
    this.models = opts.models;
    this.ledger = opts.ledger;
    this.jobId = opts.jobId;
    this.cacheAlignment = opts.cacheAlignment ?? true;
    this.onCall = opts.onCall;
  }

  get calls(): readonly LlmCallRecord[] {
    return this.records;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const store = this.ledger ? new AgentStore(this.ledger) : undefined;
    const manifest = this.jobId ? store?.manifest(this.jobId) : undefined;
    const entries = Object.entries(manifest?.bindings ?? {});
    const selected = entries.find(([slot]) => slot === req.meta?.agentSlot) ?? entries.find(([slot]) => slot === req.agent) ?? entries.find(([, b]) => b.definition.id === req.agent);
    const scope = nodeExecution.getStore();
    if (scope && !currentExecutionId()) {
      const label = createHash('sha256').update(JSON.stringify({ agent: req.agent, system: req.system, user: req.user, schema: req.schemaName, meta: req.meta })).digest('hex').slice(0, 20);
      return scope.schedule(`model:${req.agent}:${label}`, [
        { key: 'platform:agents', capacity: scope.executionCapacity },
        ...(selected ? [{ key: `agent:${selected[1].key}`, capacity: selected[1].definition.limits.maxConcurrency }] : []),
      ], () => this.chat(req));
    }
    let invocation: string | undefined;
    if (selected && store && this.jobId) {
      const [slot, binding] = selected;
      if (manifest!.providerName !== this.provider.name) throw new Error('模型提供商与任务绑定不一致，请切回原提供商');
      if (manifest!.providerIdentity && manifest!.providerIdentity !== this.providerIdentity) throw new Error('模型网关与任务绑定不一致');
      const safeMeta = Object.fromEntries(Object.entries(req.meta ?? {}).filter(([key]) => ['taskId', 'resumeId', 'batchId', 'phase', 'step', 'kind'].includes(key)));
      const executionId = currentExecutionId();
      if (executionId) safeMeta.executionId = executionId;
      invocation = store.beginInvocation(this.jobId, slot, binding, { system: req.system, user: req.user, messages: req.messages, images: req.images }, { ...safeMeta, definitionHash: binding.hash, model: manifest!.models[req.tier] });
      req = { ...req, agent: binding.definition.id, model: manifest!.models[req.tier],
        signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(binding.definition.limits.timeoutMs)]) : AbortSignal.timeout(binding.definition.limits.timeoutMs),
        meta: { ...req.meta, agentSlot: slot, agentVersionKey: binding.key, invocationId: invocation } };
    }
    const model = req.model ?? this.models[req.tier];
    const schemaText =
      req.schemaName && !req.jsonSchema ? schemaInstruction(req.schemaName) : '';
    const jsonSchema = req.jsonSchema ?? (req.schemaName && schemaText ? schemaText : undefined);
    const system = req.schemaName
      ? `${req.system}\n\n【输出要求】只输出一个 JSON 对象，不要 markdown 代码块或解释。JSON Schema：\n${schemaText}`
      : req.system;
    const sharedPrefix = this.cacheAlignment ? req.sharedPrefix : undefined;

    let result: Awaited<ReturnType<LlmProvider['chat']>>;
    try { result = await this.provider.chat({
      ...req,
      model,
      system,
      jsonSchema,
      sharedPrefix,
    });
      if (invocation) store!.finishInvocation(invocation, true, result.json ?? result.text);
    } catch (error) { if (invocation) store!.finishInvocation(invocation, false, String(error)); throw error; }

    const usage = {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      cachedPromptTokens: this.cacheAlignment ? result.usage.cachedPromptTokens : 0,
    };
    const costUsd = computeCost(model, this.pricing, usage);
    const call: ChatResult = {
      text: result.text,
      json: result.json ?? extractJson(result.text),
      toolCalls: result.toolCalls,
      usage: { ...usage, costUsd },
      stopReason: result.stopReason as StopReason,
      model,
      latencyMs: result.latencyMs,
      cacheHit: result.cacheHit,
    };

    const record: LlmCallRecord = {
      agent: req.agent,
      schemaName: req.schemaName ?? 'text',
      tier: req.tier,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      costUsd,
      latencyMs: result.latencyMs,
      cacheHit: result.cacheHit,
      cacheAligned: this.cacheAlignment,
    };
    this.records.push(record);
    this.onCall?.(record);
    if (this.ledger && this.jobId) {
      this.ledger.addUsage({
        job_id: this.jobId,
        agent: req.agent,
        model,
        tier: req.tier,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cached_tokens: usage.cachedPromptTokens,
        cost_usd: costUsd,
        latency_ms: result.latencyMs,
      });
    }
    return call;
  }
}
