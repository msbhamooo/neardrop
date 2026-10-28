import { describe, expect, it } from 'vitest';
import { parseEvent, parseBatch, errorCodeOf, MAX_BATCH } from '../src/stats-schema.js';

const NOW = 1_800_000_000_000;
const base = {
  ts: NOW - 1000, browser: 'chrome', os: 'windows', deviceKind: 'desktop',
  dailyId: '123e4567-e89b-42d3-a456-426614174000', appVersion: '0.1.0',
};
const transfer = {
  ...base, ev: 'transfer', outcome: 'done', files: 2, bytes: 1000, ms: 500, type: 'lan',
  channels: 4, chunkSize: 65536, connectMs: 800,
};

describe('parseEvent', () => {
  it('accepts a valid transfer', () => {
    expect(parseEvent(transfer, NOW).ok).toBe(true);
  });
  it('rejects unknown fields such as filenames', () => {
    expect(parseEvent({ ...transfer, filename: 'secret.pdf' }, NOW)).toEqual({ ok: false, error: 'unknown field filename' });
  });
  it('clamps absurd numbers', () => {
    const r = parseEvent({ ...transfer, ms: 1e15, files: -5 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.ev === 'transfer') {
      expect(r.value.files).toBe(0);
      expect(r.value.ms).toBe(7 * 86_400_000);
    }
  });
  it('rejects bad enums, ids and very-future timestamps', () => {
    expect(parseEvent({ ...transfer, type: 'wifi' }, NOW).ok).toBe(false);
    expect(parseEvent({ ...transfer, dailyId: 'abc' }, NOW).ok).toBe(false);
    expect(parseEvent({ ...transfer, browser: 'Mozilla/5.0 (long user agent)' }, NOW).ok).toBe(false);
  });
  it('rejects non-finite numbers and non-objects', () => {
    expect(parseEvent({ ...transfer, bytes: NaN }, NOW).ok).toBe(false);
    expect(parseEvent(null, NOW).ok).toBe(false);
    expect(parseEvent('x', NOW).ok).toBe(false);
  });
  it('validates light events', () => {
    expect(parseEvent({ ...base, ev: 'app_open' }, NOW).ok).toBe(true);
    expect(parseEvent({ ...base, ev: 'peer_found', discoverMs: 1200 }, NOW).ok).toBe(true);
    expect(parseEvent({ ...base, ev: 'peer_found' }, NOW).ok).toBe(false);
    expect(parseEvent({ ...base, ev: 'qr_pair', ok: true }, NOW).ok).toBe(true);
    expect(parseEvent({ ...base, ev: 'qr_pair', ok: 'yes' }, NOW).ok).toBe(false);
    expect(parseEvent({ ...base, ev: 'app_open', discoverMs: 1 }, NOW).ok).toBe(false);
  });
  it('rejects error codes containing free text', () => {
    expect(parseEvent({ ...transfer, outcome: 'failed', errorCode: 'file /home/bob.pdf' }, NOW).ok).toBe(false);
    expect(parseEvent({ ...transfer, outcome: 'failed', errorCode: 'handshake' }, NOW).ok).toBe(true);
  });
});

describe('parseBatch', () => {
  it('accepts up to MAX_BATCH and rejects more, empty or extra keys', () => {
    expect(parseBatch({ events: [transfer] }, NOW).ok).toBe(true);
    expect(parseBatch({ events: Array(MAX_BATCH + 1).fill(transfer) }, NOW).ok).toBe(false);
    expect(parseBatch({ events: [] }, NOW).ok).toBe(false);
    expect(parseBatch({ events: [transfer], extra: 1 }, NOW).ok).toBe(false);
  });
});

describe('errorCodeOf', () => {
  it('maps messages to stable codes', () => {
    expect(errorCodeOf('identity handshake timeout')).toBe('handshake');
    expect(errorCodeOf('connection not ready')).toBe('no_channel');
    expect(errorCodeOf('weird /path/file.txt')).toBe('other');
  });
});
