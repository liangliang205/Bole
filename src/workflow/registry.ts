import { z } from 'zod';
import type { Workflow } from './types.ts';
import { hash } from './store.ts';

export class WorkflowRegistry {
  private definitions = new Map<string, Workflow<unknown, unknown>>();
  register<I, O>(definition: Workflow<I, O>): this {
    const key = `${definition.id}@${definition.version}`;
    const old = this.definitions.get(key);
    const erased = definition as unknown as Workflow<unknown, unknown>;
    if (old && hash(this.snapshot(old)) !== hash(this.snapshot(erased))) throw new Error(`不能覆盖工作流版本：${key}`);
    this.definitions.set(key, erased); return this;
  }
  get(key: string): Workflow<unknown, unknown> { const def = this.definitions.get(key); if (!def) throw new Error(`工作流版本未注册：${key}`); return def; }
  snapshot(def: Workflow<unknown, unknown>): unknown {
    return { id: def.id, version: def.version, implementation: def.implementation, input: z.toJSONSchema(def.input), output: z.toJSONSchema(def.output), body: def.body.spec };
  }
  /** Freeze transitive child definitions as well as the root. Reject recursive nesting. */
  bundle(key: string, stack: string[] = []): unknown {
    if (stack.includes(key) || stack.length > 20) throw new Error('子工作流循环引用或嵌套过深');
    const def = this.get(key); const children: Record<string, unknown> = {};
    const visit = (spec: typeof def.body.spec) => {
      if (spec.kind === 'subworkflow') { const child = (spec.config as { workflowKey: string }).workflowKey; children[child] = this.bundle(child, [...stack, key]); }
      spec.children?.forEach(visit);
    };
    visit(def.body.spec);
    return { definition: this.snapshot(def), children };
  }
}
