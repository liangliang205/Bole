import { z } from 'zod';
import { ApprovalPendingError, ApprovalRejectedError, ApprovalStore } from '../core/approvals.ts';
import type { ApprovalKind } from '../core/approvals.ts';
import { WorkflowCancelledError, WorkflowPausedError, WorkflowUncertainError } from './types.ts';
import type { LoopResult, Node, NodeContext, Outcome, Workflow } from './types.ts';

export function task<I, O>(options: { id: string; input: z.ZodType<I>; output: z.ZodType<O>; recovery: 'retry' | 'confirm'; handler: (input: I, ctx: NodeContext) => Promise<O> | O }): Node<I, O> {
  return { spec: { id: options.id, kind: 'task', config: { recovery: options.recovery, input: z.toJSONSchema(options.input), output: z.toJSONSchema(options.output) }, implementations: [String(options.handler)] },
    input: options.input, output: options.output, recovery: options.recovery,
    execute: async (input, ctx) => options.handler(input, ctx) };
}
type Erased = Node<unknown, unknown>;
export function sequence<I, O>(id: string, a: Node<I, O>): Node<I, O>;
export function sequence<I, A, O>(id: string, a: Node<I, A>, b: Node<A, O>): Node<I, O>;
export function sequence<I, A, B, O>(id: string, a: Node<I, A>, b: Node<A, B>, c: Node<B, O>): Node<I, O>;
export function sequence<I, A, B, C, O>(id: string, a: Node<I, A>, b: Node<A, B>, c: Node<B, C>, d: Node<C, O>): Node<I, O>;
export function sequence<I, A, B, C, D, O>(id: string, a: Node<I, A>, b: Node<A, B>, c: Node<B, C>, d: Node<C, D>, e: Node<D, O>): Node<I, O>;
export function sequence(id: string, ...steps: Erased[]): Erased {
  if (!steps.length) throw new Error('顺序节点不能为空');
  return { spec: { id, kind: 'sequence', children: steps.map((s) => s.spec) }, execute: async (input, ctx) => {
    let result = input; for (const step of steps) result = await ctx.run(step, result, step.spec.id); return result;
  } };
}
/** Keep immutable input alongside a branch aggregate for the following step. */
export function retain<I, O>(id: string, node: Node<I, O>): Node<I, { input: I; result: O }> {
  return { spec: { id, kind: 'sequence', children: [node.spec] }, execute: async (input, ctx) => ({ input, result: await ctx.run(node, input, node.spec.id) }) };
}
export function condition<I, O>(id: string, options: { test: (input: I) => boolean; then: Node<I, O>; otherwise: Node<I, O> }): Node<I, O> {
  return { spec: { id, kind: 'condition', children: [options.then.spec, options.otherwise.spec], implementations: [String(options.test)] }, execute: async (input, ctx) => {
    const branch = ctx.control(() => { const choice = options.test(input); if (typeof choice !== 'boolean') throw new Error('条件必须返回布尔值'); return choice ? 'then' : 'otherwise'; });
    return ctx.run(options[branch], input, branch);
  } };
}
export function isSuspension(error: unknown): boolean {
  return error instanceof WorkflowPausedError || error instanceof WorkflowUncertainError || error instanceof WorkflowCancelledError || error instanceof ApprovalPendingError;
}
export function parallel<I, T, O>(id: string, options: {
  items: (input: I) => T[]; key: (item: T, index: number) => string;
  concurrency: number | ((input: I) => number); body: Node<T, O>; failure: 'collect' | 'fail-fast';
}): Node<I, Outcome<O>[]> {
  return { spec: { id, kind: 'parallel', config: { failure: options.failure, concurrency: typeof options.concurrency === 'number' ? options.concurrency : 'dynamic' },
    children: [options.body.spec], implementations: [String(options.items), String(options.key), String(options.concurrency)] }, execute: async (input, ctx) => {
    const saved = ctx.control(() => {
      const items = options.items(input);
      const entries = items.map((value, index) => ({ key: options.key(value, index), value }));
      if (new Set(entries.map((e) => e.key)).size !== entries.length || entries.some((e) => typeof e.key !== 'string' || !e.key.length)) throw new Error('并行分支 key 必须唯一且非空');
      const concurrency = typeof options.concurrency === 'number' ? options.concurrency : options.concurrency(input);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error('并发数必须为 1–128');
      return { entries, concurrency };
    });
    const results: Outcome<O>[] = new Array(saved.entries.length);
    let next = 0; let stop = false; let fatal: unknown; let hasFatal = false;
    await Promise.all(Array.from({ length: Math.min(saved.concurrency, saved.entries.length) }, async () => {
      while (!stop) {
        const index = next++; if (index >= saved.entries.length) return;
        const entry = saved.entries[index];
        try { ctx.checkpoint(); results[index] = { key: entry.key, ok: true, value: await ctx.run(options.body, entry.value, entry.key) }; }
        catch (error) {
          results[index] = { key: entry.key, ok: false, error: error instanceof Error ? error.message : String(error) };
          // Approval waits do not stop independent branches. Pausing/fail-fast does stop dispatch.
          if (isSuspension(error) || options.failure === 'fail-fast') {
            if (!hasFatal || isSuspension(error) && !isSuspension(fatal)) { fatal = error; hasFatal = true; }
            if (!(error instanceof ApprovalPendingError)) stop = true;
          }
        }
      }
    }));
    if (hasFatal) throw fatal;
    return results;
  } };
}
/** Fixed branches use the same bounded executor and stable output keys. */
export function branches<I, O>(id: string, options: { branches: Record<string, Node<I, O>>; concurrency: number; failure: 'collect' | 'fail-fast' }): Node<I, Outcome<O>[]> {
  const keys = Object.keys(options.branches);
  const body: Node<{ key: string; input: I }, O> = { spec: { id: 'branch', kind: 'sequence', children: Object.values(options.branches).map((n) => n.spec) },
    execute: (item, ctx) => ctx.run(options.branches[item.key], item.input, item.key) };
  return parallel(id, { items: (input: I) => keys.map((key) => ({ key, input })), key: (v) => v.key, concurrency: options.concurrency, failure: options.failure, body });
}
export function loop<S>(id: string, options: { body: Node<S, S>; until: (state: S) => boolean; maxIterations: number | ((state: S) => number) }): Node<S, LoopResult<S>> {
  return { spec: { id, kind: 'loop', children: [options.body.spec], implementations: [String(options.until), String(options.maxIterations)] }, execute: async (input, ctx) => {
    const max = ctx.control(() => typeof options.maxIterations === 'number' ? options.maxIterations : options.maxIterations(input));
    if (!Number.isInteger(max) || max < 1 || max > 1000) throw new Error('循环次数必须为 1–1000');
    let value = input;
    for (let i = 0; i < max; i++) {
      value = await ctx.run(options.body, value, `iteration-${i + 1}`);
      // The per-iteration decision is itself a checkpointed node.
      const test: Node<S, boolean> = { spec: { id: 'until', kind: 'condition' }, execute: async (state) => {
        const result = options.until(state); if (typeof result !== 'boolean') throw new Error('循环退出条件必须返回布尔值'); return result;
      } };
      if (await ctx.run(test, value, `until-${i + 1}`)) return { status: 'completed', iterations: i + 1, value };
    }
    return { status: 'exhausted', iterations: max, value };
  } };
}
export function subworkflow<I, O>(id: string, workflowKey: string, input: z.ZodType<I>, output: z.ZodType<O>): Node<I, O> {
  return { spec: { id, kind: 'subworkflow', config: { workflowKey, input: z.toJSONSchema(input), output: z.toJSONSchema(output) } }, input, output, execute: (value, ctx) => ctx.child<I, O>(workflowKey, value) };
}
export function approval<I>(id: string, options: { title: string; input: z.ZodType<I>; kind?: ApprovalKind; payload?: (input: I) => Record<string, unknown> }): Node<I, I> {
  return { spec: { id, kind: 'approval', config: { title: options.title, kind: options.kind ?? 'workflow', input: z.toJSONSchema(options.input) }, implementations: [String(options.payload)] }, input: options.input, output: options.input,
    execute: async (input, ctx) => {
      const store = new ApprovalStore(ctx.ledger);
      let record = store.request(ctx.jobId, options.kind ?? 'workflow', { ...(options.payload ? options.payload(input) : { data: input }), title: options.title, workflowRunId: ctx.runId, nodePath: ctx.path }, `workflow:${ctx.idempotencyKey}`);
      if (record.status === 'pending' && ctx.approvalResponder) {
        const answer = await ctx.approvalResponder.ask({ id: record.id, node: 'workflow', question: `${options.title}\n${record.payload_json}`, options: ['批准', '拒绝'], recommendedOption: '拒绝', blocking: true });
        if (!/auto/i.test(answer.actor)) record = store.decide(record.id, ctx.jobId, answer.answer === '批准', answer.actor);
      }
      if (record.status === 'pending') throw new ApprovalPendingError(record);
      if (record.status !== 'approved' && record.status !== 'completed') throw new ApprovalRejectedError();
      return input;
    } };
}
export function defineWorkflow<I, O>(definition: Workflow<I, O>): Workflow<I, O> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(definition.id) || !/^\d+\.\d+\.\d+$/.test(definition.version)) throw new Error('工作流 ID 或版本格式不正确');
  if (!definition.implementation) throw new Error('必须指定工作流实现指纹');
  const visit = (node: Node<I, O>['spec'], depth: number): void => {
    if (depth > 40 || !/^[a-zA-Z0-9_-]{1,100}$/.test(node.id)) throw new Error('节点 ID 不合法或嵌套过深');
    const ids = (node.children ?? []).map((c) => c.id);
    if (new Set(ids).size !== ids.length) throw new Error(`同一控制节点下的 ID 不能重复：${node.id}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(definition.body.spec, 0);
  return definition;
}
