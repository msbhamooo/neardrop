import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createSignalingServer, type SignalingServer } from '../src/create-server.js';
import { TokenBucket } from '../src/ratelimit.js';

let server: SignalingServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

type Msg = { t: string; [k: string]: any };

async function client(port: number, ip: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-forwarded-for': ip } });
  const inbox: Msg[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const waitFor = async (pred: (m: Msg) => boolean, ms = 1500): Promise<Msg | undefined> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    return undefined;
  };
  const join = (id: string, roomCode?: string) =>
    send({ t: 'join', id: `device-${id}`, name: id, deviceType: 'laptop', roomCode });
  return { ws, inbox, send, join, waitFor };
}

const start = async () => (server = await createSignalingServer({ port: 0, trustProxy: true, heartbeatMs: 60_000 }));

describe('signaling visibility', () => {
  it('same network sees each other', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    const b = await client(s.port, '10.0.0.1');
    a.join('A'); b.join('B');
    expect(await a.waitFor((m) => m.t === 'peer-joined' && m.peer.id === 'device-B')).toBeTruthy();
  });

  it('strangers on different networks do NOT see each other (no global lobby)', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    const b = await client(s.port, '203.0.113.9');
    a.join('A'); b.join('B');
    await a.waitFor((m) => m.t === 'welcome');
    await b.waitFor((m) => m.t === 'welcome');
    expect(await a.waitFor((m) => m.t === 'peer-joined', 400)).toBeUndefined();
    const welcomeB = b.inbox.find((m) => m.t === 'welcome')!;
    expect(welcomeB.peers).toEqual([]);
  });

  it('a shared room code connects different networks, and a wrong code does not', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    const b = await client(s.port, '203.0.113.9');
    const c = await client(s.port, '198.51.100.7');
    a.join('A', 'HILL-SHOE-RING');
    b.join('B', 'HILL-SHOE-RING');
    c.join('C', 'HILL-SHOE-LAMP');
    expect(await a.waitFor((m) => m.t === 'peer-joined' && m.peer.id === 'device-B')).toBeTruthy();
    expect(await a.waitFor((m) => m.t === 'peer-joined' && m.peer.id === 'device-C', 400)).toBeUndefined();
  });

  it('relays signals only to a peer the sender can see', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    const b = await client(s.port, '10.0.0.1');
    const evil = await client(s.port, '203.0.113.9');
    a.join('A'); b.join('B'); evil.join('E');
    await b.waitFor((m) => m.t === 'peer-joined');
    a.send({ t: 'signal', to: 'device-B', data: { sdp: 'x' } });
    expect(await b.waitFor((m) => m.t === 'signal' && m.from === 'device-A')).toBeTruthy();
    evil.send({ t: 'signal', to: 'device-A', data: { sdp: 'spoof' } });
    expect(await a.waitFor((m) => m.t === 'signal' && m.from === 'device-E', 400)).toBeUndefined();
  });
});

describe('signaling hardening', () => {
  it('rejects malformed JSON and bad joins without crashing', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    a.ws.send('{{not json');
    a.send({ t: 'join', id: '', name: '', deviceType: 'toaster' });
    expect(await a.waitFor((m) => m.t === 'error')).toBeTruthy();
    const b = await client(s.port, '10.0.0.1');
    b.join('B');
    expect(await b.waitFor((m) => m.t === 'welcome')).toBeTruthy();
  });

  it('refuses signals before joining', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    a.send({ t: 'signal', to: 'device-B', data: {} });
    expect(await a.waitFor((m) => m.t === 'error')).toBeTruthy();
  });

  it('closes sockets that flood it', async () => {
    const s = await start();
    const a = await client(s.port, '10.0.0.1');
    a.join('A');
    const closed = new Promise<boolean>((res) => { a.ws.on('close', () => res(true)); setTimeout(() => res(false), 4000); });
    for (let i = 0; i < 3000; i++) a.send({ t: 'signal', to: 'nobody', data: i });
    expect(await closed).toBe(true);
  });

  it('serves ICE config at /api/ice, including TURN only when configured', async () => {
    delete process.env.TURN_URL;
    const s = await start();
    let j = await (await fetch(`http://127.0.0.1:${s.port}/api/ice`)).json() as any;
    expect(j.iceServers.some((x: any) => String(x.urls).includes('turn'))).toBe(false);
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.TURN_SECRET = 's3cret';
    j = await (await fetch(`http://127.0.0.1:${s.port}/api/ice`)).json() as any;
    const turn = j.iceServers.find((x: any) => JSON.stringify(x.urls).includes('turn:'));
    expect(turn.username).toMatch(/^\d+$/);
    expect(turn.credential).toBeTruthy();
    delete process.env.TURN_URL; delete process.env.TURN_SECRET;
  });
});

describe('TokenBucket', () => {
  it('allows a burst then throttles', () => {
    const b = new TokenBucket(5, 0);
    expect([1, 2, 3, 4, 5, 6].map(() => b.take())).toEqual([true, true, true, true, true, false]);
  });
});
