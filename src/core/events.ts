import type { Ledger } from './ledger.ts';
import { AgentStore } from '../agent-platform/store.ts';
import type { EventRow } from '../types.ts';

export type EventListener = (event: EventRow) => void;

/** append-only 事件流：所有节点只追加，不修改历史。视图由事件+台账重建。 */
export class EventLog {
  private ledger: Ledger;
  private listeners: EventListener[] = [];

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(jobId: string | null, actor: string, type: string, payload: Record<string, unknown> = {}): EventRow {
    const binding = jobId ? new AgentStore(this.ledger).manifest(jobId)?.bindings[actor] : undefined;
    if (binding) { payload = { ...payload, agentSlot: actor, agentVersion: binding.key }; actor = binding.definition.id; }
    const row = this.ledger.appendEvent(jobId, actor, type, payload);
    for (const listener of this.listeners) {
      try {
        listener(row);
      } catch {
        // 监听器异常不得影响主流程
      }
    }
    return row;
  }
}
