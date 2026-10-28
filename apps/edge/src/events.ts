/**
 * POST /api/events: strict validation, per-IP rate limit, insert into D1 (lifetime retention).
 * The client IP is only handed to the rate limiter as a key; it is never written anywhere.
 */
import { parseBatch, type UsageEvent } from '../../../packages/core/src/stats-schema.js';

export interface EventsEnv {
  DB: D1Database;
  RATE?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

const MAX_BODY_BYTES = 64 * 1024;
const H = { 'cache-control': 'no-store' };

export const INSERT_SQL =
  'INSERT INTO events (ts, ev, outcome, error_code, files, bytes, ms, type, channels, chunk_size, connect_ms, discover_ms, ok, browser, os, device_kind, daily_id, app_version) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

export function eventToRow(e: UsageEvent): Array<string | number | null> {
  const t = e.ev === 'transfer' ? e : null;
  return [
    e.ts, e.ev, t?.outcome ?? null, t?.errorCode ?? null, t?.files ?? null, t?.bytes ?? null, t?.ms ?? null,
    t?.type ?? null, t?.channels ?? null, t?.chunkSize ?? null, t?.connectMs ?? null,
    e.ev === 'peer_found' ? e.discoverMs : null, e.ev === 'qr_pair' ? (e.ok ? 1 : 0) : null,
    e.browser, e.os, e.deviceKind, e.dailyId, e.appVersion,
  ];
}

export async function handleEvents(request: Request, env: EventsEnv, ip: string): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...H, allow: 'POST' } });
  if (env.RATE) {
    const { success } = await env.RATE.limit({ key: ip });
    if (!success) return new Response(null, { status: 429, headers: { ...H, 'retry-after': '60' } });
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413, headers: H });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413, headers: H });

  let body: unknown;
  try { body = JSON.parse(text); } catch { return new Response('bad json', { status: 400, headers: H }); }
  const parsed = parseBatch(body);
  if (!parsed.ok) return new Response(parsed.error, { status: 400, headers: H });

  try {
    await env.DB.batch(parsed.value.map((e) => env.DB.prepare(INSERT_SQL).bind(...eventToRow(e))));
  } catch {
    return new Response(null, { status: 503, headers: H });
  }
  return new Response(null, { status: 204, headers: H });
}
