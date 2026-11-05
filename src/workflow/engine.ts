import { randomUUID } from 'node:crypto';
import { ApprovalPendingError } from '../core/approvals.ts';
import { WorkflowRegistry } from './registry.ts';
import { WorkflowStore, hash, json } from './store.ts';
import { WorkflowBusyError, WorkflowCancelledError, WorkflowPausedError, WorkflowUncertainError } from './types.ts';
import type { Node, NodeContext, RunRow, RunStatus } from './types.ts';
import type { Ledger } from '../core/ledger.ts';
import type { HitlResponder } from '../agents/hitl.ts';

export class WorkflowEngine {
  readonly store: WorkflowStore;
  private registry: WorkflowRegistry;
  private options: { shouldPause?: () => boolean; checkpoint?: () => void; approvalResponder?: HitlResponder };
  constructor(ledger: Ledger, registry: WorkflowRegistry, options: { shouldPause?: () => boolean; checkpoint?: () => void; approvalResponder?: HitlResponder } = {}) {
    this.store = new WorkflowStore(ledger); this.registry = registry; this.options = options;
  }
  async start<I, O>(jobId: string, key: string, input: I): Promise<O> {
    const definition = this.registry.get(key);
    const parsed = definition.input.parse(input);
    const definitionHash = this.store.define(key, this.registry.bundle(key));
    const row = this.store.create(jobId, key, definitionHash, parsed);
    return this.resume<O>(row.id);
  }
  async resume<O>(runId: string): Promise<O> {
    const root = this.store.get(runId);
    if (root.parent_run_id) throw new Error('请从根工作流恢复执行');
    // Compare the entire implementation bundle, even when the run has already completed.
    const current = this.store.define(root.workflow_key, this.registry.bundle(root.workflow_key));
    if (current !== root.definition_hash) throw new Error('工作流实现与原版本不一致');
    const owner = randomUUID();
    const db = this.store.ledger.db;
    if (db.prepare('UPDATE workflow_runs SET lease_owner=?,lease_until=? WHERE id=? AND (lease_owner IS NULL OR lease_until<?)')
      .run(owner, Date.now() + 30000, runId, Date.now()).changes !== 1) throw new WorkflowBusyError();
    const timer = setInterval(() => {
      db.prepare('UPDATE workflow_runs SET lease_until=? WHERE id=? AND lease_owner=?').run(Date.now() + 30000, runId, owner);
    }, 5000);
    timer.unref();
    try { return await this.executeRun(root) as O; }
    finally { clearInterval(timer); db.prepare('UPDATE workflow_runs SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?').run(runId, owner); }
  }
  cancel(runId: string): void {
    const row = this.store.get(runId);
    if (row.parent_run_id) throw new Error('请取消根工作流');
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) throw new Error('运行已结束');
    for (const child of this.store.inspect(row.job_id).runs.filter((r) => r.root_run_id === row.id && !['succeeded', 'failed'].includes(r.status))) this.store.state(child.id, 'cancelled');
  }
  private checkpoint(rootId: string): void {
    if (this.store.get(rootId).status === 'cancelled') throw new WorkflowCancelledError();
    if (this.options.shouldPause?.()) throw new WorkflowPausedError();
    this.options.checkpoint?.();
  }
  private status(error: unknown): RunStatus {
    return error instanceof ApprovalPendingError ? 'waiting_approval'
      : error instanceof WorkflowUncertainError ? 'waiting_confirmation'
      : error instanceof WorkflowPausedError ? 'paused'
      : error instanceof WorkflowCancelledError ? 'cancelled' : 'failed';
  }
  private async executeRun(row: RunRow): Promise<unknown> {
    const definition = this.registry.get(row.workflow_key);
    if (this.store.define(row.workflow_key, this.registry.bundle(row.workflow_key)) !== row.definition_hash) throw new Error('子工作流版本指纹不一致');
    if (row.status === 'cancelled') throw new WorkflowCancelledError();
    if (row.status === 'succeeded') return definition.output.parse(JSON.parse(row.output_json!));
    this.store.state(row.id, 'running');
    try {
      const input = definition.input.parse(JSON.parse(row.input_json));
      const output = definition.output.parse(await this.executeNode(row, definition.body, input, `/${definition.body.spec.id}`));
      this.checkpoint(row.root_run_id);
      this.store.state(row.id, 'succeeded', null, output);
      return output;
    } catch (error) { this.store.state(row.id, this.status(error), error instanceof Error ? error.message : String(error)); throw error; }
  }
  private async executeNode<I, O>(row: RunRow, node: Node<I, O>, value: I, path: string): Promise<O> {
    this.checkpoint(row.root_run_id);
    const input = node.input ? node.input.parse(value) : value;
    // Always pass checkpoint copies: sibling branches and callers cannot mutate stored input.
    const inputJson = json(input);
    const previous = this.store.node(row.id, path);
    if (previous && previous.input_json !== inputJson) throw new Error(`节点输入与原检查点不一致：${path}`);
    if (previous?.status === 'succeeded') {
      try { return node.output ? node.output.parse(JSON.parse(previous.output_json!)) : JSON.parse(previous.output_json!) as O; }
      catch (error) {
        if (node.spec.kind !== 'task') { this.store.finish(row.id, path, 'failed', undefined, '检查点输出不符合契约'); throw error; }
        this.store.finish(row.id, path, 'waiting_confirmation', undefined, `检查点输出不符合契约：${error instanceof Error ? error.message : String(error)}`);
        throw new WorkflowUncertainError(path);
      }
    }
    // Ancestors inherit the waiting state, but must re-enter their children after confirmation.
    if (node.spec.kind === 'task' && (previous?.status === 'waiting_confirmation' || previous?.status === 'running' && node.recovery === 'confirm')) {
      this.store.finish(row.id, path, 'waiting_confirmation', undefined, '执行中断，外部结果未确认');
      throw new WorkflowUncertainError(path);
    }
    this.store.start(row.id, path, node.spec.id, node.spec.kind, input);
    const context: NodeContext = {
      ledger: this.store.ledger, jobId: row.job_id, runId: row.id, rootRunId: row.root_run_id, path,
      idempotencyKey: hash([row.id, path]), approvalResponder: this.options.approvalResponder,
      checkpoint: () => this.checkpoint(row.root_run_id),
      run: (child, childInput, segment) => this.executeNode(row, child, childInput, `${path}/${encodeURIComponent(segment)}`),
      control: (create) => this.store.control(row.id, path, create),
      child: async <A, B>(key: string, childInput: A): Promise<B> => {
        const childDef = this.registry.get(key);
        const parsed = childDef.input.parse(childInput);
        const childHash = this.store.define(key, this.registry.bundle(key));
        const child = this.store.create(row.job_id, key, childHash, parsed, { runId: row.id, path, rootRunId: row.root_run_id });
        return await this.executeRun(child) as B;
      },
    };
    this.store.ledger.appendEvent(row.job_id, 'workflow', 'workflow.node.started', { runId: row.id, path, kind: node.spec.kind });
    try {
      const raw = await node.execute(JSON.parse(inputJson) as I, context);
      const result = node.output ? node.output.parse(raw) : raw;
      const encoded = json(result);
      this.store.finish(row.id, path, 'succeeded', JSON.parse(encoded));
      this.store.ledger.appendEvent(row.job_id, 'workflow', 'workflow.node.succeeded', { runId: row.id, path });
      return JSON.parse(encoded) as O;
    } catch (error) {
      let status = this.status(error);
      if (status === 'failed' && node.spec.kind === 'task' && node.recovery === 'confirm') status = 'waiting_confirmation';
      this.store.finish(row.id, path, status, undefined, error instanceof Error ? error.message : String(error));
      this.store.ledger.appendEvent(row.job_id, 'workflow', 'workflow.node.stopped', { runId: row.id, path, status, error: error instanceof Error ? error.message : String(error) });
      if (status === 'waiting_confirmation' && !(error instanceof WorkflowUncertainError)) throw new WorkflowUncertainError(path);
      throw error;
    }
  }
}
