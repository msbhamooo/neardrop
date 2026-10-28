import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStatements, parseRange, rangeStart, shapeStats, type Results } from '../src/queries.js';
import { INSERT_SQL, eventToRow } from '../src/events.js';
import type { UsageEvent } from '../../../packages/core/src/stats-schema.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const base = (over: Partial<UsageEvent> & { ev: UsageEvent['ev'] }) =>
  ({ ts: NOW - 1000, browser: 'chrome', os: 'windows', deviceKind: 'desktop', dailyId: 'a'.repeat(8) + '-0000-4000-8000-000000000000', appVersion: '1', ...over }) as UsageEvent;
const xfer = (o: Record<string, unknown>) =>
  base({ ev: 'transfer', outcome: 'done', files: 1, bytes: 10_485_760, ms: 1000, type: 'lan', channels: 4, chunkSize: 65536, connectMs: 500, ...o } as never);

function makeDb(events: UsageEvent[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(process.cwd(), 'apps/edge/migrations/0001_events.sql'), 'utf8'));
  const ins = db.prepare(INSERT_SQL);
  for (const e of events) ins.run(...eventToRow(e));
  return db;
}

function run(db: DatabaseSync, range: 'today' | '7d' | '30d' | 'all') {
  const results: Results = {};
  for (const s of buildStatements(range, NOW)) results[s.key] = db.prepare(s.sql).all(...s.params) as never;
  return shapeStats(range, results);
}

describe('range helpers', () => {
  it('parses and defaults', () => {
    expect(parseRange('30d')).toBe('30d');
    expect(parseRange('nope')).toBe('7d');
    expect(parseRange(null)).toBe('7d');
  });
  it('computes starts', () => {
    expect(rangeStart('all', NOW)).toBe(0);
    expect(rangeStart('today', NOW)).toBe(Date.UTC(2026, 9, 28));
    expect(rangeStart('7d', NOW)).toBe(NOW - 7 * DAY);
  });
});

describe('dashboard queries on real SQLite', () => {
  const db = makeDb([
    xfer({ bytes: 10 * 1048576, ms: 1000 }), // 10 MB/s
    xfer({ bytes: 20 * 1048576, ms: 1000 }), // 20 MB/s
    xfer({ bytes: 40 * 1048576, ms: 1000, type: 'relay', browser: 'safari', os: 'ios', deviceKind: 'mobile' }), // 40
    xfer({ outcome: 'failed', errorCode: 'handshake', bytes: 0, ms: 0 }),
    xfer({ outcome: 'failed', errorCode: 'handshake', bytes: 0, ms: 0 }),
    xfer({ outcome: 'cancelled', bytes: 5, ms: 5 }),
    xfer({ ts: NOW - 20 * DAY, bytes: 1048576, ms: 1000 }),
    base({ ev: 'peer_found', discoverMs: 1000 } as never),
    base({ ev: 'peer_found', discoverMs: 3000 } as never),
    base({ ev: 'qr_pair', ok: true } as never),
    base({ ev: 'qr_pair', ok: false } as never),
    base({ ev: 'app_open', dailyId: 'b'.repeat(8) + '-0000-4000-8000-000000000000' }),
  ]);

  it('computes totals, success rate and ranges', () => {
    const s = run(db, '7d');
    expect(s.totals.transfers).toBe(6);
    expect(s.totals.done).toBe(3);
    expect(s.totals.bytes).toBe(70 * 1048576);
    expect(s.totals.successRate).toBeCloseTo(0.5);
    expect(run(db, 'all').totals.transfers).toBe(7);
    expect(run(db, '30d').totals.transfers).toBe(7);
  });
  it('computes avg / median / p90 speed overall and per link type', () => {
    const s = run(db, '7d');
    expect(s.speed.all.avg).toBeCloseTo(70 / 3);
    expect(s.speed.all.median).toBeCloseTo(20);
    expect(s.speed.all.p90).toBeCloseTo(20); // nearest-rank, n=3 -> index 1
    expect(s.speed.lan.avg).toBeCloseTo(15);
    expect(s.speed.relay.median).toBeCloseTo(40);
    expect(s.speed.qr.avg).toBeNull();
  });
  it('computes connect and discover averages, extremes, failures, qr', () => {
    const s = run(db, '7d');
    expect(s.avgConnectMs).toBeCloseTo(500);
    expect(s.avgDiscoverMs).toBeCloseTo(2000);
    expect(s.largest?.bytes).toBe(40 * 1048576);
    expect(s.fastest?.speed).toBeCloseTo(40);
    expect(s.errors).toEqual([{ key: 'handshake', count: 2 }]);
    expect(s.qr).toEqual({ ok: 1, fail: 1 });
  });
  it('counts distinct daily ids per day and breakdowns', () => {
    const s = run(db, 'today');
    expect(s.dau).toEqual([{ day: '2026-10-28', count: 2 }]);
    expect(s.browser.find((b) => b.key === 'safari')?.count).toBe(1);
    expect(s.deviceKind.map((d) => d.key).sort()).toEqual(['desktop', 'mobile']);
    expect(s.perDay[0]?.transfers).toBe(6);
  });
  it('handles an empty database', () => {
    const s = run(makeDb([]), 'all');
    expect(s.totals.successRate).toBeNull();
    expect(s.largest).toBeNull();
    expect(s.speed.all.median).toBeNull();
  });
});
