/** Dashboard SQL builders (D1/SQLite) and result shapers. Pure functions so they are unit-testable. */

export type Range = 'today' | '7d' | '30d' | 'all';
export const RANGES: Range[] = ['today', '7d', '30d', 'all'];
export const LINK_TYPES = ['lan', 'qr', 'relay'] as const;

const DAY = 86_400_000;

export function parseRange(v: string | null): Range {
  return RANGES.includes(v as Range) ? (v as Range) : '7d';
}

/** Start of the range as epoch ms; "today" starts at 00:00 UTC. */
export function rangeStart(range: Range, now: number): number {
  switch (range) {
    case 'today': return now - (now % DAY);
    case '7d': return now - 7 * DAY;
    case '30d': return now - 30 * DAY;
    case 'all': return 0;
  }
}

export interface Stmt { key: string; sql: string; params: Array<string | number> }

/** MB/s of a finished transfer (bytes and ms are both positive). */
const SPEED = '(bytes * 1000.0 / ms / 1048576.0)';
const TRANSFER = "ev = 'transfer' AND ts >= ?";
const GOOD = `${TRANSFER} AND outcome = 'done' AND ms > 0 AND bytes > 0`;

/** Nearest-rank percentile (p in 0..1) of speed, optionally for one link type. */
function percentile(key: string, p: number, since: number, type?: string): Stmt {
  const where = `${GOOD}${type ? ' AND type = ?' : ''}`;
  const params: Array<string | number> = type ? [since, type] : [since];
  return {
    key,
    sql: `SELECT ${SPEED} AS v FROM events WHERE ${where} ORDER BY v ` +
      `LIMIT 1 OFFSET (SELECT MAX(0, CAST((COUNT(*) - 1) * ${p} AS INTEGER)) FROM events WHERE ${where})`,
    params: [...params, ...params],
  };
}

export function buildStatements(range: Range, now: number): Stmt[] {
  const since = rangeStart(range, now);
  const s: Stmt[] = [
    {
      key: 'totals',
      sql: `SELECT COUNT(*) AS transfers, COALESCE(SUM(CASE WHEN outcome='done' THEN 1 ELSE 0 END),0) AS done, ` +
        `COALESCE(SUM(CASE WHEN outcome='done' THEN files ELSE 0 END),0) AS files, ` +
        `COALESCE(SUM(CASE WHEN outcome='done' THEN bytes ELSE 0 END),0) AS bytes FROM events WHERE ${TRANSFER}`,
      params: [since],
    },
    {
      key: 'connect',
      sql: `SELECT AVG(connect_ms) AS v FROM events WHERE ${TRANSFER} AND outcome='done' AND connect_ms > 0`,
      params: [since],
    },
    { key: 'discover', sql: "SELECT AVG(discover_ms) AS v FROM events WHERE ev = 'peer_found' AND ts >= ?", params: [since] },
    { key: 'speedAvg', sql: `SELECT AVG(${SPEED}) AS v FROM events WHERE ${GOOD}`, params: [since] },
    percentile('speedMedian', 0.5, since),
    percentile('speedP90', 0.9, since),
    {
      key: 'dau',
      sql: "SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(DISTINCT daily_id) AS n FROM events WHERE ts >= ? GROUP BY day ORDER BY day",
      params: [since],
    },
    {
      key: 'perDay',
      sql: `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*) AS transfers, ` +
        `COALESCE(SUM(CASE WHEN outcome='done' THEN bytes ELSE 0 END),0) AS bytes, ` +
        `AVG(CASE WHEN outcome='done' AND ms > 0 AND bytes > 0 THEN ${SPEED} END) AS speed ` +
        `FROM events WHERE ${TRANSFER} GROUP BY day ORDER BY day`,
      params: [since],
    },
    { key: 'browser', sql: `SELECT browser AS k, COUNT(*) AS n FROM events WHERE ${TRANSFER} GROUP BY browser ORDER BY n DESC`, params: [since] },
    { key: 'os', sql: `SELECT os AS k, COUNT(*) AS n FROM events WHERE ${TRANSFER} GROUP BY os ORDER BY n DESC`, params: [since] },
    { key: 'deviceKind', sql: `SELECT device_kind AS k, COUNT(*) AS n FROM events WHERE ${TRANSFER} GROUP BY device_kind ORDER BY n DESC`, params: [since] },
    {
      key: 'errors',
      sql: `SELECT COALESCE(error_code, 'unknown') AS k, COUNT(*) AS n FROM events WHERE ${TRANSFER} AND outcome='failed' GROUP BY k ORDER BY n DESC LIMIT 20`,
      params: [since],
    },
    {
      key: 'largest',
      sql: `SELECT bytes, ms, type, ts FROM events WHERE ${TRANSFER} AND outcome='done' ORDER BY bytes DESC LIMIT 1`,
      params: [since],
    },
    {
      key: 'fastest',
      sql: `SELECT ${SPEED} AS speed, bytes, type, ts FROM events WHERE ${GOOD} ORDER BY speed DESC LIMIT 1`,
      params: [since],
    },
    {
      key: 'qr',
      sql: "SELECT COALESCE(SUM(ok),0) AS ok, COUNT(*) - COALESCE(SUM(ok),0) AS fail FROM events WHERE ev = 'qr_pair' AND ts >= ?",
      params: [since],
    },
  ];
  for (const t of LINK_TYPES) {
    s.push({ key: `speedAvg:${t}`, sql: `SELECT AVG(${SPEED}) AS v FROM events WHERE ${GOOD} AND type = ?`, params: [since, t] });
    s.push(percentile(`speedMedian:${t}`, 0.5, since, t));
    s.push(percentile(`speedP90:${t}`, 0.9, since, t));
  }
  return s;
}

type Row = Record<string, unknown>;
export type Results = Record<string, Row[]>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const first = (r: Results, k: string): Row => r[k]?.[0] ?? {};
const val = (r: Results, k: string): number | null => num(first(r, k).v);
const counts = (rows: Row[] = []) => rows.map((x) => ({ key: String(x.k), count: Number(x.n) }));

export interface SpeedStats { avg: number | null; median: number | null; p90: number | null }
export interface DashboardStats {
  range: Range;
  totals: { transfers: number; done: number; files: number; bytes: number; successRate: number | null };
  speed: { all: SpeedStats } & Record<(typeof LINK_TYPES)[number], SpeedStats>;
  avgConnectMs: number | null;
  avgDiscoverMs: number | null;
  dau: Array<{ day: string; count: number }>;
  perDay: Array<{ day: string; transfers: number; bytes: number; speed: number | null }>;
  browser: Array<{ key: string; count: number }>;
  os: Array<{ key: string; count: number }>;
  deviceKind: Array<{ key: string; count: number }>;
  errors: Array<{ key: string; count: number }>;
  largest: { bytes: number; ms: number; type: string; ts: number } | null;
  fastest: { speed: number; bytes: number; type: string; ts: number } | null;
  qr: { ok: number; fail: number };
}

export function shapeStats(range: Range, r: Results): DashboardStats {
  const t = first(r, 'totals');
  const transfers = Number(t.transfers ?? 0);
  const done = Number(t.done ?? 0);
  const speedOf = (suffix: string): SpeedStats => ({
    avg: val(r, `speedAvg${suffix}`), median: val(r, `speedMedian${suffix}`), p90: val(r, `speedP90${suffix}`),
  });
  const l = first(r, 'largest');
  const f = first(r, 'fastest');
  const qr = first(r, 'qr');
  return {
    range,
    totals: { transfers, done, files: Number(t.files ?? 0), bytes: Number(t.bytes ?? 0), successRate: transfers ? done / transfers : null },
    speed: { all: speedOf(''), lan: speedOf(':lan'), qr: speedOf(':qr'), relay: speedOf(':relay') },
    avgConnectMs: val(r, 'connect'),
    avgDiscoverMs: val(r, 'discover'),
    dau: (r.dau ?? []).map((x) => ({ day: String(x.day), count: Number(x.n) })),
    perDay: (r.perDay ?? []).map((x) => ({ day: String(x.day), transfers: Number(x.transfers), bytes: Number(x.bytes), speed: num(x.speed) })),
    browser: counts(r.browser),
    os: counts(r.os),
    deviceKind: counts(r.deviceKind),
    errors: counts(r.errors),
    largest: l.bytes === undefined ? null : { bytes: Number(l.bytes), ms: Number(l.ms), type: String(l.type), ts: Number(l.ts) },
    fastest: f.speed === undefined ? null : { speed: Number(f.speed), bytes: Number(f.bytes), type: String(f.type), ts: Number(f.ts) },
    qr: { ok: Number(qr.ok ?? 0), fail: Number(qr.fail ?? 0) },
  };
}

/** Run every statement in one D1 batch and shape the result. */
export async function loadStats(db: D1Database, range: Range, now = Date.now()): Promise<DashboardStats> {
  const stmts = buildStatements(range, now);
  const out = await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
  const results: Results = {};
  stmts.forEach((s, i) => { results[s.key] = (out[i]?.results ?? []) as Row[]; });
  return shapeStats(range, results);
}
