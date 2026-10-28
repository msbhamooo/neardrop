/**
 * Anonymous usage reporting (owner-only dashboard at /admin; there is no stats UI in the app).
 * Every public function is fire-and-forget and swallows all errors: stats must never touch a transfer.
 * See "Privacy" in the README for exactly what is collected.
 */
import { get, set } from 'idb-keyval';
import { errorCodeOf, type UsageEvent, type LinkType } from '@neardrop/core';
import { EventQueue } from './queue.js';
import { getDailyId } from './daily-id.js';
import { detectBrowser, detectDeviceKind, detectOs } from './env.js';
import { session } from '../identity.js';

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.1.0';
const QUEUE_KEY = 'neardrop:stats-queue';
const DAY_KEY = 'nd.stats.day';

const queue = new EventQueue({
  store: {
    get: () => get<UsageEvent[]>(QUEUE_KEY),
    set: (v) => set(QUEUE_KEY, v),
  },
  send: (batch) => navigator.sendBeacon('/api/events', new Blob([JSON.stringify({ events: batch })], { type: 'application/json' })),
  online: () => navigator.onLine,
});

function enabled(): boolean {
  return session.value?.settings.shareStats !== false;
}

function common() {
  const ua = navigator.userAgent;
  return {
    ts: Date.now(),
    browser: detectBrowser(ua),
    os: detectOs(ua),
    deviceKind: detectDeviceKind(ua),
    dailyId: getDailyId({
      get: () => JSON.parse(localStorage.getItem(DAY_KEY) ?? 'null') ?? undefined,
      set: (v) => localStorage.setItem(DAY_KEY, JSON.stringify(v)),
    }),
    appVersion: APP_VERSION,
  };
}

function record(build: () => Omit<UsageEvent, keyof ReturnType<typeof common>>): void {
  try {
    if (!enabled()) return;
    const event = { ...common(), ...build() } as UsageEvent;
    void queue.enqueue(event).then(() => (navigator.onLine ? queue.flush() : 0));
  } catch { /* never break the app */ }
}

export interface TransferReport {
  outcome: 'done' | 'cancelled' | 'failed';
  error?: string;
  files: number;
  bytes: number;
  ms: number;
  type: LinkType;
  channels: number;
  chunkSize: number;
  connectMs: number;
}

export function reportTransfer(r: TransferReport): void {
  record(() => ({
    ev: 'transfer', outcome: r.outcome, files: r.files, bytes: r.bytes, ms: r.ms, type: r.type,
    channels: r.channels, chunkSize: r.chunkSize, connectMs: r.connectMs,
    ...(r.outcome === 'failed' ? { errorCode: errorCodeOf(r.error ?? '') } : {}),
  }) as never);
}
export const reportAppOpen = (): void => record(() => ({ ev: 'app_open' }) as never);
export const reportPeerFound = (discoverMs: number): void => record(() => ({ ev: 'peer_found', discoverMs }) as never);
export const reportQrPair = (ok: boolean): void => record(() => ({ ev: 'qr_pair', ok }) as never);

/** Deliver anything queued while offline (call on startup and when the browser comes back online). */
export function flushStats(): void {
  try { if (enabled()) void queue.flush(); } catch { /* ignore */ }
}
try { addEventListener('online', flushStats); } catch { /* non-browser */ }
