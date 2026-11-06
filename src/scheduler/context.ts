import { AsyncLocalStorage } from 'node:async_hooks';
import type { NodeContext } from '../workflow/types.ts';

/** Model requests outside a worker reservation (planning/OCR/profile) share admission too. */
export const nodeExecution = new AsyncLocalStorage<NodeContext & { executionCapacity: number }>();
