import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  encodeBase45, decodeBase45, Sha256, toHex, sha256, crc32, encodeFrame, decodeFrame,
  FLAG_FINAL, encodeControl, parseControl, generateIdentity, signBytes, verifyBytes,
  verificationEmoji, parseSdp, buildSdp, packCompact, unpackCompact, encodePayload, decodePayload,
} from '../src/index.js';
import { randomBytes } from './util.js';

describe('base45', () => {
  it('round-trips arbitrary bytes of every small length', () => {
    for (let n = 0; n < 64; n++) {
      const b = randomBytes(n, n + 1);
      expect(Array.from(decodeBase45(encodeBase45(b)))).toEqual(Array.from(b));
    }
  });
  it('rejects garbage', () => {
    expect(() => decodeBase45('not valid base45 é')).toThrow();
  });
});

describe('sha256', () => {
  it('matches node:crypto for many sizes, including incremental updates', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 65537]) {
      const b = randomBytes(n, 7);
      const want = createHash('sha256').update(b).digest('hex');
      expect(toHex(sha256(b))).toBe(want);
      const h = new Sha256();
      for (let i = 0; i < n; i += 37) h.update(b.subarray(i, Math.min(n, i + 37)));
      expect(toHex(h.digest())).toBe(want);
    }
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789')) >>> 0).toBe(0xcbf43926);
  });
});

describe('wire frames and control messages', () => {
  it('round-trips a frame header + payload', () => {
    const payload = randomBytes(1000);
    const f = decodeFrame(encodeFrame(3, 123456, FLAG_FINAL, payload));
    expect(f.fileIndex).toBe(3);
    expect(f.chunkIndex).toBe(123456);
    expect(f.flags & FLAG_FINAL).toBe(FLAG_FINAL);
    expect(Array.from(f.payload)).toEqual(Array.from(payload));
  });
  it('parseControl rejects non-JSON and unknown shapes instead of throwing', () => {
    expect(parseControl('{{{')).toBeNull();
    expect(parseControl('"just a string"')).toBeNull();
    expect(parseControl(encodeControl({ t: 'cancel', id: 'x' }))).toMatchObject({ t: 'cancel', id: 'x' });
  });
});

describe('identity', () => {
  it('signs and verifies, and rejects tampering or a different key', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const msg = new TextEncoder().encode('nonce-123');
    const sig = await signBytes(a, msg);
    expect(await verifyBytes(a.alg, a.publicJwk, msg, sig)).toBe(true);
    expect(await verifyBytes(a.alg, a.publicJwk, new TextEncoder().encode('nonce-124'), sig)).toBe(false);
    expect(await verifyBytes(b.alg, b.publicJwk, msg, sig)).toBe(false);
  });
  it('verification emoji are symmetric and differ between pairs', () => {
    expect(verificationEmoji('aaa', 'bbb')).toEqual(verificationEmoji('bbb', 'aaa'));
    expect(verificationEmoji('aaa', 'bbb')).not.toEqual(verificationEmoji('aaa', 'ccc'));
  });
});

describe('offline QR payload', () => {
  const sdp = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdefghijklmn',
    'a=fingerprint:sha-256 ' + Array.from(randomBytes(32), (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000',
    'a=candidate:1 1 udp 2113937151 192.168.1.20 54321 typ host',
    'a=candidate:2 1 udp 2113937151 abcd1234-ef.local 54322 typ host',
  ].join('\r\n') + '\r\n';

  it('parse -> pack -> unpack preserves everything the connection needs', () => {
    const c = parseSdp(sdp);
    const back = unpackCompact(packCompact(c));
    expect(back.ufrag).toBe('abcd');
    expect(back.pwd).toBe(c.pwd);
    expect(Array.from(back.fingerprint)).toEqual(Array.from(c.fingerprint));
    expect(back.candidates.map((x) => `${x.ip}:${x.port}`)).toEqual(['192.168.1.20:54321', 'abcd1234-ef.local:54322']);
    expect(buildSdp(back)).toContain('a=ice-ufrag:abcd');
  });
  it('encodes to a scannable-size base45 string and decodes back', async () => {
    const c = parseSdp(sdp);
    const text = await encodePayload(c);
    expect(text.length).toBeLessThan(600);
    const back = await decodePayload(text);
    expect(back.pwd).toBe(c.pwd);
    expect(back.candidates).toHaveLength(2);
  });
  it('a truncated or corrupted QR payload fails cleanly', async () => {
    const text = await encodePayload(parseSdp(sdp));
    await expect(decodePayload(text.slice(0, 20))).rejects.toBeTruthy();
  });
});
