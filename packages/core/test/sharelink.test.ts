import { describe, it, expect } from 'vitest';
import { makeShareSecret, shareRoom, shareUrl, parseShareHash, shareNeedsPassword } from '../../../apps/web/src/sharelink.js';

describe('share links', () => {
  it('secrets are 20 unambiguous chars and not repeating', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = makeShareSecret();
      expect(s).toMatch(/^[A-HJKMNP-Z2-9]{20}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(500);
  });

  it('the room is deterministic, server-safe, and does not reveal the secret', () => {
    const s = makeShareSecret();
    const room = shareRoom(s);
    expect(shareRoom(s)).toBe(room);
    expect(room).toMatch(/^S-[0-9A-F]{20}$/);
    expect(room.length).toBeLessThanOrEqual(24);
    expect(room).not.toContain(s.slice(0, 6));
    expect(shareRoom(makeShareSecret())).not.toBe(room);
  });

  it('the secret lives only in the URL fragment', () => {
    const s = makeShareSecret();
    const url = new URL(shareUrl('https://drop.example', '/', s));
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/');
    expect(parseShareHash(url.hash)).toBe(s);
  });

  it('parse accepts lowercase from a retyped link but rejects malformed or foreign hashes', () => {
    const s = makeShareSecret();
    expect(parseShareHash(`#/r/${s.toLowerCase()}`)).toBe(s);
    for (const bad of ['', '#', '#/r/', '#/r/SHORT', `#/r/${s}X`, `#/x/${s}`, `#/r/${'0'.repeat(20)}`, `#/r/${s}/../../`]) {
      expect(parseShareHash(bad)).toBeNull();
    }
  });

  it('a password changes the room, is never in the link, and is flagged for the receiver', () => {
    const s = makeShareSecret();
    expect(shareRoom(s, 'hunter22')).not.toBe(shareRoom(s));
    expect(shareRoom(s, 'hunter22')).toBe(shareRoom(s, 'hunter22'));
    expect(shareRoom(s, 'hunter23')).not.toBe(shareRoom(s, 'hunter22'));
    const url = new URL(shareUrl('https://drop.example', '/', s, true));
    expect(url.hash).toBe(`#/r/${s}/p`);
    expect(url.href).not.toContain('hunter');
    expect(shareNeedsPassword(url.hash)).toBe(true);
    expect(shareNeedsPassword(`#/r/${s}`)).toBe(false);
    expect(parseShareHash(url.hash)).toBe(s);
  });
});
