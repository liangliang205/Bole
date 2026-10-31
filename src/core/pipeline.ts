/**
 * 编排原语：批内并发（parallel）与批间流动（pipeline）。
 * 关键性质：批 i 进入下游后，批 i+1 立刻开始上游处理——不存在"等全部批完成"的全局屏障。
 */

export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function mapSettled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  return mapConcurrent(items, limit, async (item, index) => {
    try {
      return { ok: true as const, value: await fn(item, index) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
}

export interface BatchFlowOptions<T, R> {
  batches: T[][];
  maxInFlight: number;
  run: (batch: T[], index: number) => Promise<R>;
  onBatchStart?: (index: number, size: number) => void;
  onBatchDone?: (index: number, result: R) => void;
  onBatchError?: (index: number, error: unknown) => void;
}

/** 批间流动：最多 maxInFlight 个批同时在流，每个批独立走自己的 stage 链。 */
export async function flowBatches<T, R>(opts: BatchFlowOptions<T, R>): Promise<(R | undefined)[]> {
  const { batches, maxInFlight, run } = opts;
  const results = new Array<R | undefined>(batches.length);
  if (batches.length === 0) return results;
  let next = 0;
  const workerCount = Math.max(1, Math.min(maxInFlight, batches.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= batches.length) return;
      const batch = batches[index];
      opts.onBatchStart?.(index, batch.length);
      try {
        const result = await run(batch, index);
        results[index] = result;
        opts.onBatchDone?.(index, result);
      } catch (error) {
        opts.onBatchError?.(index, error);
        results[index] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
