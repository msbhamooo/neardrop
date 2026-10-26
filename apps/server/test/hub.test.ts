import { describe, it, expect } from 'vitest';
import { HttpSignalHub } from '../src/hub.js';

type Msg = { t: string; [k: string]: any };
const post = async (hub: HttpSignalHub, ip: string, body: object) => {
  const r = await hub.handle(ip, JSON.stringify(body));
  return r.body as { ok: boolean; messages?: Msg[]; needJoin?: boolean };
};
const join = (id: string, roomCode?: string) => ({ t: 'join', id: `device-${id}`, name: id, deviceType: 'laptop', roomCode });

describe('HttpSignalHub (shared by Node server and Cloudflare Durable Object)', () => {
  it('same network sees each other; a push wakes a waiting long-poll', async () => {
    const hub = new HttpSignalHub();
    const a = await post(hub, '10.0.0.1', { messages: [join('A')] });
    expect(a.messages?.some((m) => m.t === 'welcome')).toBe(true);
    const waiting = hub.handle('10.0.0.1', JSON.stringify({ peerId: 'device-A', waitMs: 5000 }));
    await post(hub, '10.0.0.1', { messages: [join('B')] });
    const woke = (await waiting).body as { messages: Msg[] };
    expect(woke.messages.some((m) => m.t === 'peer-joined' && m.peer.id === 'device-B')).toBe(true);
  });

  it('different networks are invisible unless they share a room code', async () => {
    const hub = new HttpSignalHub();
    await post(hub, '10.0.0.1', { messages: [join('A')] });
    const b = await post(hub, '203.0.113.9', { messages: [join('B')] });
    expect(b.messages?.find((m) => m.t === 'welcome')?.peers).toEqual([]);
    await post(hub, '10.0.0.1', { peerId: 'device-A', messages: [{ t: 'set-room', roomCode: 'HILL-SHOE-RING' }] });
    const c = await post(hub, '203.0.113.9', { peerId: 'device-B', messages: [{ t: 'set-room', roomCode: 'HILL-SHOE-RING' }] });
    expect(c.messages?.find((m) => m.t === 'welcome')?.peers.map((p: any) => p.id)).toEqual(['device-A']);
  });

  it('relays a signal only to a visible peer', async () => {
    const hub = new HttpSignalHub();
    await post(hub, '10.0.0.1', { messages: [join('A')] });
    await post(hub, '10.0.0.1', { messages: [join('B')] });
    await post(hub, '203.0.113.9', { messages: [join('E')] });
    await post(hub, '10.0.0.1', { peerId: 'device-A', messages: [{ t: 'signal', to: 'device-B', data: { x: 1 } }] });
    const b = await post(hub, '10.0.0.1', { peerId: 'device-B' });
    expect(b.messages?.some((m) => m.t === 'signal' && m.from === 'device-A')).toBe(true);
    const spoof = await post(hub, '203.0.113.9', { peerId: 'device-E', messages: [{ t: 'signal', to: 'device-A', data: {} }] });
    expect(spoof.messages?.some((m) => m.t === 'error')).toBe(true);
    const a = await post(hub, '10.0.0.1', { peerId: 'device-A' });
    expect(a.messages?.some((m) => m.t === 'signal' && m.from === 'device-E')).toBe(false);
  });

  it('asks unknown clients to re-join, rejects bad JSON and sweeps silent sessions', async () => {
    const hub = new HttpSignalHub({ sessionTimeoutMs: 1000 });
    expect((await post(hub, '10.0.0.1', { peerId: 'device-ghost' })).needJoin).toBe(true);
    expect((await hub.handle('10.0.0.1', '{{nope')).status).toBe(400);
    await post(hub, '10.0.0.1', { messages: [join('A')] });
    expect(hub.count()).toBe(1);
    hub.sweep(Date.now() + 5000);
    expect(hub.count()).toBe(0);
  });
});
