import { describe, it, expect } from 'vitest';
import { makeRoomCode } from '../../../apps/web/src/roomcode.js';

describe('room codes', () => {
  it('are three speakable words, safe for the server and URLs', () => {
    for (let i = 0; i < 500; i++) {
      const c = makeRoomCode();
      expect(c).toMatch(/^[A-Z]+-[A-Z]+-[A-Z]+$/);
      expect(c.length).toBeLessThanOrEqual(24);
    }
  });
  it('are not repeating (crypto-random)', () => {
    const seen = new Set(Array.from({ length: 300 }, makeRoomCode));
    expect(seen.size).toBeGreaterThan(290);
  });
});
