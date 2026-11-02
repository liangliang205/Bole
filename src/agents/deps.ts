import type { Ledger } from '../core/ledger.ts';
import type { EventLog } from '../core/events.ts';
import type { LlmRouter } from '../llm/router.ts';
import type { AgentRegistry } from '../core/registry.ts';
import type { PipelineConfig, BolePaths } from '../config.ts';
import type { RagIndex } from '../tools/rag.ts';
import type { KnowledgeService } from '../knowledge/service.ts';
import type { StreamSink } from '../types.ts';

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
  /** 兼容旧测试/CLI 的轻量 RAG；生产知识库使用 knowledge。 */
  rag: RagIndex;
  knowledge: KnowledgeService;
  /** SSE token 流；CLI 场景为空。 */
  stream?: StreamSink;
}

export function newWorkerId(agent: string, index: number): string {
  return `${agent}#${index}`;
}
