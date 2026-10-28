import { describe, expect, it } from 'vitest';
import { handleEvents } from '../src/events.js';

const ev = {
  ev: 'app_open', ts: Date.now() - 1000, browser: 'chrome', os: 'linux', deviceKind: 'desktop',
  dailyId: '123e4567-e89b-42d3-a456-426614174000', appVersion: '0.1.0',
};

function fakeEnv(allow = true) {
  const writes: unknown[][] = [];
  const keys: string[] = [];
  const env = {
    DB: {
      prepare: () => ({ bind: (...a: unknown[]) => { writes.push(a); return {}; } }),
      batch: async () => [],
    },
    RATE: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allow }; } },
  };
  return { env: env as never, writes, keys };
}
const post = (body: unknown) =>
  new Request('https://x/api/events', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /api/events', () => {
  it('stores a valid batch and never writes the IP', async () => {
    const { env, writes, keys } = fakeEnv();
    const res = await handleEvents(post({ events: [ev, ev] }), env, '203.0.113.9');
    expect(res.status).toBe(204);
    expect(writes).toHaveLength(2);
    expect(JSON.stringify(writes)).not.toContain('203.0.113.9');
    expect(keys).toEqual(['203.0.113.9']);
  });
  it('rejects unknown fields, bad JSON, and non-POST', async () => {
    const { env, writes } = fakeEnv();
    expect((await handleEvents(post({ events: [{ ...ev, filename: 'a.pdf' }] }), env, 'ip')).status).toBe(400);
    expect((await handleEvents(post('{nope'), env, 'ip')).status).toBe(400);
    expect((await handleEvents(new Request('https://x/api/events'), env, 'ip')).status).toBe(405);
    expect(writes).toHaveLength(0);
  });
  it('rate limits per IP', async () => {
    const { env, writes } = fakeEnv(false);
    expect((await handleEvents(post({ events: [ev] }), env, 'ip')).status).toBe(429);
    expect(writes).toHaveLength(0);
  });
  it('rejects oversized bodies', async () => {
    const { env } = fakeEnv();
    expect((await handleEvents(post('x'.repeat(70_000)), env, 'ip')).status).toBe(413);
  });
});
