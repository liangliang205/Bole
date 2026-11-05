import { createHash, randomUUID } from 'node:crypto';
import type { Ledger } from '../core/ledger.ts';
import type { NodeRow, RunRow, RunStatus } from './types.ts';

/** Reject values that cannot survive a checkpoint round trip. */
export function json(value: unknown): string {
  const ancestors = new Set<object>();
  const inspect = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) throw new Error('工作流数据必须是有限、无循环引用的 JSON 值');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('工作流数据不能包含类实例');
    ancestors.add(item);
    for (const child of Array.isArray(item) ? Array.from(item) : Object.values(item)) inspect(child);
    ancestors.delete(item);
  };
  inspect(value);
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(json(value)).digest('hex'); }
export class WorkflowStore {
  readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  define(key: string, snapshot: unknown): string {
    const contentHash = hash(snapshot);
    const old = this.ledger.db.prepare('SELECT content_hash FROM workflow_definitions WHERE workflow_key=?').get(key);
    if (old && old.content_hash !== contentHash) throw new Error(`工作流实现发生变化，请保留旧实现并发布新版本：${key}`);
    this.ledger.db.prepare('INSERT OR IGNORE INTO workflow_definitions VALUES (?,?,?,?)').run(key, contentHash, json(snapshot), new Date().toISOString());
    return contentHash;
  }
  root(jobId: string): RunRow | undefined { return this.ledger.db.prepare('SELECT * FROM workflow_runs WHERE job_id=? AND parent_run_id IS NULL').get(jobId) as unknown as RunRow | undefined; }
  get(id: string): RunRow { const row = this.ledger.db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(id) as unknown as RunRow | undefined; if (!row) throw new Error('工作流运行不存在'); return row; }
  create(jobId: string, key: string, definitionHash: string, input: unknown, parent?: { runId: string; path: string; rootRunId: string }): RunRow {
    const old = parent ? this.ledger.db.prepare('SELECT * FROM workflow_runs WHERE parent_run_id=? AND parent_node_path=?').get(parent.runId, parent.path) as unknown as RunRow | undefined : this.root(jobId);
    if (old) {
      if (old.workflow_key !== key || old.definition_hash !== definitionHash || old.input_json !== json(input)) throw new Error('工作流运行的版本或输入与原快照不一致');
      return old;
    }
    const id = randomUUID(); const now = new Date().toISOString();
    this.ledger.db.prepare(`INSERT INTO workflow_runs
      (id,job_id,workflow_key,root_run_id,parent_run_id,parent_node_path,definition_hash,input_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, jobId, key, parent?.rootRunId ?? id, parent?.runId ?? null, parent?.path ?? null, definitionHash, json(input), now, now);
    this.ledger.appendEvent(jobId, 'workflow', 'workflow.created', { runId: id, key, parentRunId: parent?.runId ?? null });
    return this.get(id);
  }
  state(id: string, status: RunStatus, error: string | null = null, output?: unknown): void {
    this.ledger.db.prepare('UPDATE workflow_runs SET status=?,error=?,output_json=?,updated_at=? WHERE id=?').run(status, error, output === undefined ? null : json(output), new Date().toISOString(), id);
    const row = this.get(id);
    this.ledger.appendEvent(row.job_id, 'workflow', 'workflow.state', { runId: id, status, error });
  }
  node(runId: string, path: string): NodeRow | undefined { return this.ledger.db.prepare('SELECT * FROM workflow_nodes WHERE run_id=? AND path=?').get(runId, path) as unknown as NodeRow | undefined; }
  start(runId: string, path: string, id: string, kind: NodeRow['kind'], input: unknown): void {
    this.ledger.db.prepare(`INSERT INTO workflow_nodes (run_id,path,node_id,kind,status,input_json,attempt,updated_at)
      VALUES (?,?,?,?,'running',?,1,?) ON CONFLICT(run_id,path) DO UPDATE SET status='running',attempt=attempt+1,error=NULL,updated_at=excluded.updated_at`)
      .run(runId, path, id, kind, json(input), new Date().toISOString());
  }
  finish(runId: string, path: string, status: RunStatus, output?: unknown, error: string | null = null): void {
    this.ledger.db.prepare('UPDATE workflow_nodes SET status=?,output_json=?,error=?,updated_at=? WHERE run_id=? AND path=?').run(status, output === undefined ? null : json(output), error, new Date().toISOString(), runId, path);
  }
  control<T>(runId: string, path: string, create: () => T): T {
    const saved = this.node(runId, path)?.control_json;
    if (saved !== null && saved !== undefined) return JSON.parse(saved) as T;
    const value = create(); this.ledger.db.prepare('UPDATE workflow_nodes SET control_json=? WHERE run_id=? AND path=?').run(json(value), runId, path); return value;
  }
  inspect(jobId: string) {
    const runs = this.ledger.db.prepare('SELECT * FROM workflow_runs WHERE job_id=? ORDER BY created_at,rowid').all(jobId) as unknown as RunRow[];
    return { runs, nodes: runs.flatMap((r) => this.ledger.db.prepare('SELECT * FROM workflow_nodes WHERE run_id=? ORDER BY rowid').all(r.id) as unknown as NodeRow[]) };
  }
  confirm(runId: string, path: string, decision: { action: 'retry' } | { action: 'complete'; output: unknown }, actor: string): void {
    const run = this.get(runId);
    const root = this.get(run.root_run_id);
    if (root.lease_owner && (root.lease_until ?? 0) > Date.now()) throw new Error('运行仍被占用，请等待执行者释放');
    const node = this.node(runId, path);
    if (node?.status !== 'waiting_confirmation' || node.kind !== 'task') throw new Error('只有结果待确认的任务节点可以人工确认');
    this.finish(runId, path, decision.action === 'retry' ? 'pending' : 'succeeded', decision.action === 'complete' ? decision.output : undefined);
    this.ledger.appendEvent(run.job_id, actor, 'workflow.node.confirmed', { runId, path, action: decision.action });
  }
}
