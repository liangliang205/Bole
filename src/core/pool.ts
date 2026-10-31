import { sleep } from '../util/time.ts';
import type { PoolStats } from '../types.ts';

export class PoolFullError extends Error {
  constructor(pool: string, capacity: number, refusals: number) {
    super(`容量池 ${pool} 已满（capacity=${capacity}，拒绝次数=${refusals}）：拒绝不排队`);
    this.name = 'PoolFullError';
  }
}

export interface Slot {
  id: string;
  label: string;
  release: () => void;
}

export interface AdmissionOptions {
  maxRefusalRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs?: number;
}

/**
 * 容量池：满载时**直接拒绝**，不维护等待队列。
 * 调用方（编排层）决定是否以有界退避重试——这避免"排队等自己依赖的上游占用的名额"造成死锁。
 */
export class CapacityPool {
  readonly name: string;
  readonly capacity: number;
  private active = 0;
  private peak = 0;
  private acquired = 0;
  private refused = 0;
  private released = 0;
  private timeouts = 0;
  private waiters: (() => void)[] = [];

  constructor(name: string, capacity: number) {
    if (capacity < 1) throw new Error('容量池容量必须 >= 1');
    this.name = name;
    this.capacity = capacity;
  }

  tryAcquire(label: string): Slot | null {
    if (this.active >= this.capacity) {
      this.refused += 1;
      return null;
    }
    this.active += 1;
    this.acquired += 1;
    this.peak = Math.max(this.peak, this.active);
    const id = `${this.name}#${this.acquired}`;
    let released = false;
    const self = this;
    return {
      id,
      label,
      release() {
        if (released) return;
        released = true;
        self.active -= 1;
        self.released += 1;
        self.wakeWaiters();
      },
    };
  }

  /** 有界准入：反复尝试 tryAcquire，失败记录 refusal 并退避；超限抛 PoolFullError。 */
  async acquire(label: string, opts: AdmissionOptions): Promise<Slot> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let attempts = 0;
    for (;;) {
      const slot = this.tryAcquire(label);
      if (slot) return slot;
      attempts += 1;
      if (attempts > opts.maxRefusalRetries || Date.now() > deadline) {
        this.timeouts += 1;
        throw new PoolFullError(this.name, this.capacity, this.refused);
      }
      const backoff = Math.min(
        opts.maxBackoffMs,
        opts.baseBackoffMs * 2 ** Math.min(attempts, 6),
      );
      const jitter = Math.random() * Math.min(backoff, 10);
      await this.waitForChange(backoff + jitter);
    }
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.waiters.push(done);
      setTimeout(done, ms);
      // 防止 waiters 无限增长
      if (this.waiters.length > 10_000) this.waiters = this.waiters.filter((w) => w !== done);
    });
  }

  private wakeWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  stats(): PoolStats {
    return {
      name: this.name,
      capacity: this.capacity,
      active: this.active,
      peak: this.peak,
      acquired: this.acquired,
      refused: this.refused,
      released: this.released,
      timeouts: this.timeouts,
    };
  }
}

export function admissionOptions(overrides?: Partial<AdmissionOptions>): AdmissionOptions {
  return {
    maxRefusalRetries: 200,
    baseBackoffMs: 4,
    maxBackoffMs: 60,
    timeoutMs: 30_000,
    ...overrides,
  };
}

export async function withSlot<T>(pool: CapacityPool, label: string, opts: AdmissionOptions, fn: () => Promise<T>): Promise<T> {
  const slot = await pool.acquire(label, opts);
  try {
    return await fn();
  } finally {
    slot.release();
  }
}

export async function delay(ms: number): Promise<void> {
  await sleep(ms);
}
