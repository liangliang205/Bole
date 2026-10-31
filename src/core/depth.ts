import type { AgentPreset } from '../config.ts';

export class DepthExceededError extends Error {
  constructor(agentId: string, attempted: number, budget: number) {
    super(`深度预算耗尽：${agentId} 试图在第 ${attempted} 层委派，预算 maxDepth=${budget}（子 Agent 禁止再派生）`);
    this.name = 'DepthExceededError';
  }
}

/**
 * 执行上下文：子 Agent 只能执行自己的任务，不得再委派（depth=1，maxDepth=0）。
 * 这是"可证明的无递归失控"：不是靠提示词，而是靠运行时断言。
 */
export class ExecutionContext {
  readonly agentId: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly canDelegate: boolean;

  constructor(preset: AgentPreset, depth: number) {
    this.agentId = preset.id;
    this.depth = depth;
    this.maxDepth = preset.maxDepth;
    this.canDelegate = preset.canDelegate;
  }

  assertMayDelegate(): void {
    if (!this.canDelegate || this.depth + 1 > this.maxDepth) {
      throw new DepthExceededError(this.agentId, this.depth + 1, this.maxDepth);
    }
  }

  describe(): string {
    return `${this.agentId}@depth${this.depth}/max${this.maxDepth}`;
  }
}

export function coordinatorContext(preset: AgentPreset): ExecutionContext {
  return new ExecutionContext(preset, 0);
}

export function workerContext(preset: AgentPreset): ExecutionContext {
  return new ExecutionContext(preset, 1);
}
