/**
 * Offline-tolerant event queue. Storage and transport are injected so it is testable and so the
 * browser bits (IndexedDB, sendBeacon) stay in stats/index.ts. Nothing here ever throws.
 */
import { MAX_BATCH, type UsageEvent } from '@neardrop/core';

export interface QueueStore {
  get(): Promise<UsageEvent[] | undefined>;
  set(events: UsageEvent[]): Promise<void>;
}

export interface QueueDeps {
  store: QueueStore;
  /** Hand a batch to the network; true when it was accepted for delivery. */
  send(batch: UsageEvent[]): boolean;
  online(): boolean;
  /** Oldest events are dropped beyond this, so a long-offline device cannot grow storage forever. */
  maxQueued?: number;
}

export class EventQueue {
  private chain: Promise<void> = Promise.resolve();
  private readonly max: number;

  constructor(private readonly deps: QueueDeps) {
    this.max = deps.maxQueued ?? 500;
  }

  /** Serialize read-modify-write cycles so concurrent calls cannot lose events. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  enqueue(event: UsageEvent): Promise<void> {
    return this.locked(async () => {
      try {
        const q = (await this.deps.store.get()) ?? [];
        q.push(event);
        await this.deps.store.set(q.slice(-this.max));
      } catch { /* stats must never break the app */ }
    });
  }

  /** Send everything queued, MAX_BATCH at a time. Events stay queued if the network is down or send fails. */
  flush(): Promise<number> {
    return this.locked(async () => {
      let sent = 0;
      try {
        if (!this.deps.online()) return 0;
        let q = (await this.deps.store.get()) ?? [];
        while (q.length > 0) {
          const batch = q.slice(0, MAX_BATCH);
          if (!this.deps.send(batch)) break;
          q = q.slice(batch.length);
          sent += batch.length;
          await this.deps.store.set(q);
        }
      } catch { /* keep the queue as-is */ }
      return sent;
    });
  }
}
