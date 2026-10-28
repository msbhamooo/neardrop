import { describe, expect, it } from 'vitest';
import type { UsageEvent } from '@neardrop/core';
import { EventQueue, type QueueStore } from '../src/stats/queue.js';
import { getDailyId } from '../src/stats/daily-id.js';
import { detectBrowser, detectDeviceKind, detectOs } from '../src/stats/env.js';

const ev = (n: number) => ({ ev: 'app_open', ts: n } as unknown as UsageEvent);
function memStore(initial: UsageEvent[] = []): QueueStore & { data: UsageEvent[] } {
  const s = { data: initial, get: async () => s.data, set: async (v: UsageEvent[]) => { s.data = v; } };
  return s;
}

describe('EventQueue', () => {
  it('keeps events while offline and flushes later, in batches of 50', async () => {
    const store = memStore();
    let online = false;
    const batches: number[] = [];
    const q = new EventQueue({ store, online: () => online, send: (b) => { batches.push(b.length); return true; } });
    for (let i = 0; i < 120; i++) await q.enqueue(ev(i));
    expect(await q.flush()).toBe(0);
    expect(store.data).toHaveLength(120);
    online = true;
    expect(await q.flush()).toBe(120);
    expect(batches).toEqual([50, 50, 20]);
    expect(store.data).toHaveLength(0);
  });
  it('keeps unsent events when the transport refuses', async () => {
    const store = memStore();
    const q = new EventQueue({ store, online: () => true, send: () => false });
    await q.enqueue(ev(1));
    expect(await q.flush()).toBe(0);
    expect(store.data).toHaveLength(1);
  });
  it('drops the oldest events beyond the cap', async () => {
    const store = memStore();
    const q = new EventQueue({ store, online: () => false, send: () => true, maxQueued: 3 });
    for (let i = 1; i <= 5; i++) await q.enqueue(ev(i));
    expect(store.data.map((e) => e.ts)).toEqual([3, 4, 5]);
  });
  it('never throws when storage or transport fail', async () => {
    const bad: QueueStore = { get: async () => { throw new Error('idb'); }, set: async () => { throw new Error('idb'); } };
    const q = new EventQueue({ store: bad, online: () => true, send: () => { throw new Error('net'); } });
    await expect(q.enqueue(ev(1))).resolves.toBeUndefined();
    await expect(q.flush()).resolves.toBe(0);
  });
  it('does not lose concurrent enqueues', async () => {
    const store = memStore();
    const q = new EventQueue({ store, online: () => false, send: () => true });
    await Promise.all(Array.from({ length: 30 }, (_, i) => q.enqueue(ev(i))));
    expect(store.data).toHaveLength(30);
  });
});

describe('getDailyId', () => {
  const mk = () => {
    let v: { day: string; id: string } | undefined;
    return { get: () => v, set: (x: { day: string; id: string }) => { v = x; } };
  };
  it('is stable within a UTC day and rotates on the next', () => {
    const store = mk();
    let n = 0;
    const uuid = () => `id-${++n}`;
    const d1 = Date.UTC(2026, 9, 28, 1);
    expect(getDailyId(store, d1, uuid)).toBe('id-1');
    expect(getDailyId(store, d1 + 3600_000, uuid)).toBe('id-1');
    expect(getDailyId(store, Date.UTC(2026, 9, 29, 0, 0, 1), uuid)).toBe('id-2');
  });
  it('still returns an id when storage throws', () => {
    const broken = { get: () => { throw new Error('x'); }, set: () => { throw new Error('x'); } };
    expect(getDailyId(broken, 0, () => 'z')).toBe('z');
  });
});

describe('env detection', () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120';
  it('returns only fixed vocabulary labels', () => {
    expect([detectBrowser(ios), detectOs(ios), detectDeviceKind(ios)]).toEqual(['safari', 'ios', 'mobile']);
    expect([detectBrowser(win), detectOs(win), detectDeviceKind(win)]).toEqual(['edge', 'windows', 'desktop']);
    expect(detectBrowser('weird')).toBe('other');
  });
});
