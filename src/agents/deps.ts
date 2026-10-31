import type { Ledger } from '../core/ledger.ts';
import type { EventLog } from '../core/events.ts';
import type { LlmRouter } from '../llm/router.ts';
import type { AgentRegistry } from '../core/registry.ts';
import type { PipelineConfig, BolePaths } from '../config.ts';
import type { RagIndex } from '../tools/rag.ts';

export interface FaultInjection {
  /** 模拟"幻觉结论"：这些 label 的评估结论会被拔高 */
  fabricate?: string[];
  /** 模拟"偏见理由"：这些 label 的评估理由会引用受保护属性 */
  bias?: string[];
  /** 模拟首轮 schema 违规：这些 resumeId 的第一次输出不合法 */
  invalidSchemaFor?: string[];
}

export interface AgentDeps {
  ledger: Ledger;
  events: EventLog;
  llm: LlmRouter;
  registry: AgentRegistry;
  config: PipelineConfig;
  paths: BolePaths;
  runId: string;
  runDir: string;
  jobId: string;
  seed: string;
  rag: RagIndex;
  faults?: FaultInjection;
  latencyMs?: number;
}

export function newWorkerId(agent: string, index: number): string {
  return `${agent}#${index}`;
}
