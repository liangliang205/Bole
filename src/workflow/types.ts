import type { z } from 'zod';
import type { Ledger } from '../core/ledger.ts';
import type { HitlResponder } from '../agents/hitl.ts';

export type RunStatus = 'pending' | 'running' | 'waiting_approval' | 'waiting_confirmation' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export interface NodeSpec {
  id: string;
  kind: 'task' | 'sequence' | 'parallel' | 'condition' | 'loop' | 'subworkflow' | 'approval';
  config?: unknown;
  children?: NodeSpec[];
  implementations?: string[];
}
export interface NodeContext {
  ledger: Ledger;
  jobId: string;
  runId: string;
  rootRunId: string;
  path: string;
  idempotencyKey: string;
  approvalResponder?: HitlResponder;
  run<I, O>(node: Node<I, O>, input: I, segment: string): Promise<O>;
  control<T>(create: () => T): T;
  child<I, O>(key: string, input: I): Promise<O>;
  checkpoint(): void;
}
export interface Node<I, O> {
  spec: NodeSpec;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  recovery?: 'retry' | 'confirm';
  execute(input: I, context: NodeContext): Promise<O>;
}
export interface Workflow<I, O> {
  id: string;
  version: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  body: Node<I, O>;
  /** Source fingerprints for imported handlers, predicates and schemas. */
  implementation: string;
}
export interface RunRow {
  id: string; job_id: string; workflow_key: string; root_run_id: string;
  parent_run_id: string | null; parent_node_path: string | null;
  definition_hash: string; input_json: string; output_json: string | null;
  status: RunStatus; error: string | null; created_at: string; updated_at: string;
  lease_owner: string | null; lease_until: number | null;
}
export interface NodeRow {
  run_id: string; path: string; node_id: string; kind: NodeSpec['kind'];
  status: RunStatus; input_json: string; output_json: string | null;
  control_json: string | null; attempt: number; error: string | null; updated_at: string;
}
export type Outcome<T> = { key: string; ok: true; value: T } | { key: string; ok: false; error: string };
export interface LoopResult<S> { status: 'completed' | 'exhausted'; iterations: number; value: S }

export class WorkflowPausedError extends Error { constructor() { super('工作流已暂停'); } }
export class WorkflowUncertainError extends Error { constructor(path: string) { super(`节点结果待人工确认：${path}；请确认外部操作结果后恢复`); } }
export class WorkflowCancelledError extends Error { constructor() { super('工作流已取消'); } }
export class WorkflowBusyError extends Error { constructor() { super('工作流已有执行者，请稍后再试'); } }
