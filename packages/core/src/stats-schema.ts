/** Anonymous usage-event schema shared by the web client and the edge ingest Worker. No DOM, no deps. */

export const MAX_BATCH = 50;

export type EventName = 'transfer' | 'app_open' | 'peer_found' | 'qr_pair';
export type Outcome = 'done' | 'cancelled' | 'failed';
export type LinkType = 'lan' | 'qr' | 'relay';
export type DeviceKind = 'mobile' | 'desktop';

/** Fields common to every event. Nothing here can identify a person or device long-term. */
export interface BaseEvent {
  ev: EventName;
  ts: number;
  browser: string;
  os: string;
  deviceKind: DeviceKind;
  dailyId: string;
  appVersion: string;
}

export interface TransferEvent extends BaseEvent {
  ev: 'transfer';
  outcome: Outcome;
  errorCode?: string;
  files: number;
  bytes: number;
  ms: number;
  type: LinkType;
  channels: number;
  chunkSize: number;
  connectMs: number;
}
export interface AppOpenEvent extends BaseEvent { ev: 'app_open' }
export interface PeerFoundEvent extends BaseEvent { ev: 'peer_found'; discoverMs: number }
export interface QrPairEvent extends BaseEvent { ev: 'qr_pair'; ok: boolean }
export type UsageEvent = TransferEvent | AppOpenEvent | PeerFoundEvent | QrPairEvent;

const BASE_KEYS = ['ev', 'ts', 'browser', 'os', 'deviceKind', 'dailyId', 'appVersion'];
const KEYS: Record<EventName, string[]> = {
  transfer: [...BASE_KEYS, 'outcome', 'errorCode', 'files', 'bytes', 'ms', 'type', 'channels', 'chunkSize', 'connectMs'],
  app_open: BASE_KEYS,
  peer_found: [...BASE_KEYS, 'discoverMs'],
  qr_pair: [...BASE_KEYS, 'ok'],
};
const BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'samsung', 'opera', 'other'];
const OSES = ['android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z.+-]{1,20}$/;
const CODE = /^[a-z0-9_.-]{1,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Finite number clamped into [min,max] and rounded; undefined when not a number. */
export function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.round(Math.min(max, Math.max(min, v)));
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate and normalize one event. Unknown fields, unknown enums or missing fields reject it. */
export function parseEvent(raw: unknown, now: number = Date.now()): ParseResult<UsageEvent> {
  if (!isObj(raw)) return { ok: false, error: 'not an object' };
  const ev = raw.ev;
  if (ev !== 'transfer' && ev !== 'app_open' && ev !== 'peer_found' && ev !== 'qr_pair') return { ok: false, error: 'bad ev' };
  const allowed = KEYS[ev];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) return { ok: false, error: `unknown field ${k}` };

  // events may sit in an offline queue for weeks, but never come from the future or before this app existed
  const ts = clampInt(raw.ts, 1_700_000_000_000, now + 5 * 60_000);
  if (ts === undefined) return { ok: false, error: 'bad ts' };
  if (typeof raw.browser !== 'string' || !BROWSERS.includes(raw.browser)) return { ok: false, error: 'bad browser' };
  if (typeof raw.os !== 'string' || !OSES.includes(raw.os)) return { ok: false, error: 'bad os' };
  if (raw.deviceKind !== 'mobile' && raw.deviceKind !== 'desktop') return { ok: false, error: 'bad deviceKind' };
  if (typeof raw.dailyId !== 'string' || !UUID.test(raw.dailyId)) return { ok: false, error: 'bad dailyId' };
  if (typeof raw.appVersion !== 'string' || !VERSION.test(raw.appVersion)) return { ok: false, error: 'bad appVersion' };
  const base: BaseEvent = {
    ev, ts, browser: raw.browser, os: raw.os, deviceKind: raw.deviceKind,
    dailyId: raw.dailyId.toLowerCase(), appVersion: raw.appVersion,
  };

  switch (ev) {
    case 'app_open':
      return { ok: true, value: { ...base, ev } };
    case 'peer_found': {
      const discoverMs = clampInt(raw.discoverMs, 0, 600_000);
      if (discoverMs === undefined) return { ok: false, error: 'bad discoverMs' };
      return { ok: true, value: { ...base, ev, discoverMs } };
    }
    case 'qr_pair': {
      if (typeof raw.ok !== 'boolean') return { ok: false, error: 'bad ok' };
      return { ok: true, value: { ...base, ev, ok: raw.ok } };
    }
    case 'transfer': {
      if (raw.outcome !== 'done' && raw.outcome !== 'cancelled' && raw.outcome !== 'failed') return { ok: false, error: 'bad outcome' };
      if (raw.type !== 'lan' && raw.type !== 'qr' && raw.type !== 'relay') return { ok: false, error: 'bad type' };
      let errorCode: string | undefined;
      if (raw.errorCode !== undefined) {
        if (typeof raw.errorCode !== 'string' || !CODE.test(raw.errorCode)) return { ok: false, error: 'bad errorCode' };
        errorCode = raw.errorCode;
      }
      const files = clampInt(raw.files, 0, 100_000);
      const bytes = clampInt(raw.bytes, 0, 2 ** 50);
      const ms = clampInt(raw.ms, 0, 7 * 86_400_000);
      const channels = clampInt(raw.channels, 0, 32);
      const chunkSize = clampInt(raw.chunkSize, 0, 4 * 1024 * 1024);
      const connectMs = clampInt(raw.connectMs, 0, 600_000);
      if (files === undefined || bytes === undefined || ms === undefined || channels === undefined
        || chunkSize === undefined || connectMs === undefined) return { ok: false, error: 'bad number' };
      const out: TransferEvent = { ...base, ev, outcome: raw.outcome, files, bytes, ms, type: raw.type, channels, chunkSize, connectMs };
      if (errorCode) out.errorCode = errorCode;
      return { ok: true, value: out };
    }
  }
}

/** Validate a whole POST body: `{ events: [...] }`, at most MAX_BATCH. Any invalid event rejects the batch. */
export function parseBatch(body: unknown, now: number = Date.now()): ParseResult<UsageEvent[]> {
  if (!isObj(body)) return { ok: false, error: 'not an object' };
  for (const k of Object.keys(body)) if (k !== 'events') return { ok: false, error: `unknown field ${k}` };
  const list = body.events;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) return { ok: false, error: 'bad events' };
  const events: UsageEvent[] = [];
  for (const item of list) {
    const r = parseEvent(item, now);
    if (!r.ok) return r;
    events.push(r.value);
  }
  return { ok: true, value: events };
}

/** Map an error message to a short stable code; the output never contains user text. */
export function errorCodeOf(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('handshake')) return 'handshake';
  if (m.includes('connection not ready') || m.includes('never opened')) return 'no_channel';
  if (m.includes('closed') || m.includes('errored')) return 'channel_closed';
  if (m.includes('mismatch')) return 'hash_mismatch';
  if (m.includes('quota') || m.includes('sink')) return 'storage';
  if (m.includes('timeout')) return 'timeout';
  if (m.includes('ice') || m.includes('stun')) return 'ice';
  return 'other';
}
