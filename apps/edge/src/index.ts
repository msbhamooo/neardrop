/**
 * NearDrop on Cloudflare: one Worker serves the PWA (static assets) and the signaling API.
 * Signaling state lives in a single Durable Object, the same HttpSignalHub the Node server uses.
 * The Worker never sees file bytes: it only relays small signaling messages.
 */
import { DurableObject } from 'cloudflare:workers';
import { HttpSignalHub } from '../../server/src/hub.js';

export interface Env {
  ASSETS: Fetcher;
  SIGNAL_HUB: DurableObjectNamespace<SignalHub>;
  TURN_URL?: string;
  TURN_SECRET?: string;
  TURN_USER?: string;
  TURN_CRED?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export class SignalHub extends DurableObject<Env> {
  private hub = new HttpSignalHub({ sessionTimeoutMs: 35_000 });

  async fetch(request: Request): Promise<Response> {
    this.hub.sweep();
    const ip = request.headers.get('x-nd-client-ip') ?? 'unknown';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: true, peers: this.hub.count() }), { headers: JSON_HEADERS });
    }
    const body = await request.text();
    const reply = await this.hub.handle(ip, body, (cb) => request.signal.addEventListener('abort', cb, { once: true }));
    return new Response(JSON.stringify(reply.body), { status: reply.status === 499 ? 200 : reply.status, headers: JSON_HEADERS });
  }
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** STUN always; TURN relay only when configured (direct P2P is still tried first by ICE). */
async function iceServers(env: Env): Promise<unknown[]> {
  const servers: unknown[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  const url = env.TURN_URL?.trim();
  if (!url) return servers;
  const urls = url.split(',').map((u) => u.trim()).filter(Boolean);
  if (env.TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + 3600);
    servers.push({ urls, username, credential: await hmacSha1Base64(env.TURN_SECRET, username) });
  } else {
    servers.push({ urls, username: env.TURN_USER, credential: env.TURN_CRED });
  }
  return servers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, runtime: 'cloudflare' }), { headers: JSON_HEADERS });
    }
    if (pathname === '/api/ice') {
      return new Response(JSON.stringify({ iceServers: await iceServers(env) }), { headers: JSON_HEADERS });
    }
    if (pathname === '/api/signal' || pathname.startsWith('/api/signal/')) {
      // One global hub: devices on the same network are matched by hashed IP inside it.
      const stub = env.SIGNAL_HUB.get(env.SIGNAL_HUB.idFromName('global'));
      const headers = new Headers(request.headers);
      headers.set('x-nd-client-ip', request.headers.get('cf-connecting-ip') ?? 'unknown');
      return stub.fetch(new Request(request, { headers }));
    }
    // Everything else is the PWA (SPA fallback is configured in wrangler.jsonc).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
