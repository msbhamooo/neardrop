/**
 * NearDrop signaling server — factory (testable).
 * Relay-only: rooms keyed by hashed client IP, optional geohash proximity,
 * heartbeat eviction, per-socket rate limiting. No SDP logging, no storage.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve as resolvePath } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomRegistry, type Peer } from './rooms.js';
import { HttpSignalHub } from './hub.js';
import { TokenBucket } from './ratelimit.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

export interface SignalingOptions {
  port?: number;
  trustProxy?: boolean;
  heartbeatMs?: number;
  log?: boolean;
  maxPayload?: number;
  staticDir?: string;
}

export interface SignalingServer {
  httpServer: Server;
  wss: WebSocketServer;
  rooms: RoomRegistry;
  port: number;
  close(): Promise<void>;
}


const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export function createSignalingServer(opts: SignalingOptions = {}): Promise<SignalingServer> {
  const {
    port = 0,
    trustProxy = process.env.TRUST_PROXY === '1',
    heartbeatMs = 15_000,
    log = process.env.LOG === '1',
    maxPayload = 512 * 1024,
    staticDir,
  } = opts;

  const resolvedStaticDir = staticDir ? resolvePath(staticDir) : undefined;
  const hub = new HttpSignalHub({ sessionTimeoutMs: Math.max(heartbeatMs * 2.5, 35_000), maxPayload, log: (...a) => logger(...a) });
  const rooms = hub.rooms;
  const buckets = new WeakMap<WebSocket, TokenBucket>();
  const peers = new WeakMap<WebSocket, Peer>();
  const joined = new WeakMap<WebSocket, boolean>();
  const strikes = new WeakMap<WebSocket, number>();

  const clientIp = (req: IncomingMessage): string => {
    const xff = req.headers['x-forwarded-for'];
    if (trustProxy && typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const logger = (...args: unknown[]): void => {
    if (log) console.log('[signaling]', ...args);
  };

  const sendError = (ws: WebSocket, code: string, message: string): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', code, message } as ServerMessage));
  };

  const handleApiSignal = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, peers: rooms.count() }));
      return;
    }
    let body = '';
    let aborted = false;
    let closeCb: (() => void) | null = null;
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > maxPayload * 2) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'payload too large' }));
        req.destroy();
      }
    });
    req.on('close', () => closeCb?.());
    req.on('end', () => {
      if (aborted) return;
      void hub
        .handle(clientIp(req), body, (cb) => { closeCb = cb; })
        .then((reply) => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        });
    });
  };

  const httpServer = createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, peers: rooms.count(), uptime: process.uptime() }));
      return;
    }
    if (pathname === '/api/ice') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ iceServers: buildIceServers() }));
      return;
    }
    if (pathname === '/api/signal' || pathname.startsWith('/api/signal/')) {
      handleApiSignal(req, res);
      return;
    }
    if (resolvedStaticDir) {
      const targetPath = pathname === '/' ? '/index.html' : pathname;
      const file = join(resolvedStaticDir, targetPath);
      if (!file.startsWith(resolvedStaticDir)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(file);
        const ext = extname(file);
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': ext === '.html' || file.endsWith('sw.js') || file.endsWith('registerSW.js')
            ? 'no-cache, no-store, must-revalidate'
            : 'public,max-age=31536000,immutable',
        });
        res.end(data);
        return;
      } catch {
        try {
          const data = await readFile(join(resolvedStaticDir, 'index.html'));
          res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache, no-store, must-revalidate' });
          res.end(data);
          return;
        } catch {
          res.writeHead(404).end('NearDrop web build missing — run `pnpm build` first');
          return;
        }
      }
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    buckets.set(ws, new TokenBucket(600, 300));
    strikes.set(ws, 0);
    joined.set(ws, false);

    ws.on('pong', () => {
      const peer = peers.get(ws);
      if (peer) peer.alive = true;
    });

    ws.on('message', (data) => {
      const bucket = buckets.get(ws);
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return sendError(ws, 'bad-message', 'invalid JSON');
      }
      if (msg.t !== 'ping' && bucket && !bucket.take()) {
        const s = (strikes.get(ws) ?? 0) + 1;
        strikes.set(ws, s);
        sendError(ws, 'rate-limited', 'slow down');
        if (s >= 5) ws.terminate();
        return;
      }
      switch (msg.t) {
        case 'ping': {
          const peer = peers.get(ws);
          if (peer) rooms.send(peer, { t: 'pong' });
          return;
        }
        case 'join': {
          if (joined.get(ws)) return sendError(ws, 'bad-message', 'already joined');
          const join = RoomRegistry.normalizeJoin(msg);
          if (!join) return sendError(ws, 'bad-message', 'bad join payload');
          const peer: Peer = {
            ws,
            id: join.id,
            name: join.name,
            deviceType: join.deviceType,
            geo: join.geo,
            roomCode: join.roomCode,
            pairedIds: join.pairedIds ? new Set(join.pairedIds) : undefined,
            room: rooms.roomForIp(ip),
            alive: true,
            strikes: 0,
          };
          peers.set(ws, peer);
          rooms.add(peer);
          joined.set(ws, true);
          const others = rooms.visiblePeers(peer);
          rooms.send(peer, {
            t: 'welcome',
            peers: others.map((o) => rooms.toPeerInfo(o, peer)),
            roomCode: peer.roomCode,
          });
          for (const other of others) {
            rooms.send(other, { t: 'peer-joined', peer: rooms.toPeerInfo(peer, other) });
          }
          logger('join', peer.id.slice(0, 8), 'room', peer.room.slice(0, 11), peer.roomCode ? `code=${peer.roomCode}` : '', `peers=${rooms.count()}`);
          return;
        }
        case 'set-room': {
          const peer = peers.get(ws);
          if (!peer) return sendError(ws, 'not-joined', 'join first');
          const before = new Set(rooms.visiblePeers(peer));
          peer.roomCode = RoomRegistry.normalizeRoomCode(msg.roomCode);
          const after = new Set(rooms.visiblePeers(peer));
          for (const oldPeer of before) {
            if (!after.has(oldPeer)) {
              rooms.send(oldPeer, { t: 'peer-left', id: peer.id });
            }
          }
          for (const newPeer of after) {
            rooms.send(newPeer, { t: 'peer-joined', peer: rooms.toPeerInfo(peer, newPeer) });
          }
          rooms.send(peer, {
            t: 'welcome',
            peers: [...after].map((o) => rooms.toPeerInfo(o, peer)),
            roomCode: peer.roomCode,
          });
          return;
        }
        case 'signal': {
          const from = peers.get(ws);
          if (!from) return sendError(ws, 'not-joined', 'join first');
          if (typeof msg.to !== 'string' || typeof msg.data === 'undefined') {
            return sendError(ws, 'bad-message', 'bad signal payload');
          }
          const to = rooms.getById(msg.to);
          if (!to || !rooms.visible(from, to)) {
            return sendError(ws, 'unknown-peer', 'peer not visible');
          }
          rooms.send(to, { t: 'signal', from: from.id, fromPeer: rooms.toPeerInfo(from, to), data: msg.data }); // opaque relay — never logged
          return;
        }
        default:
          sendError(ws, 'bad-message', 'unknown message type');
      }
    });

    ws.on('close', () => {
      const peer = peers.get(ws);
      if (peer) {
        rooms.remove(peer);
        rooms.broadcastVisible(peer, { t: 'peer-left', id: peer.id });
        logger('leave', peer.id.slice(0, 8), `peers=${rooms.count()}`);
      }
    });

    ws.on('error', () => { /* close handler cleans up */ });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    hub.sweep(now);
    for (const ws of wss.clients) {
      const peer = peers.get(ws);
      if (peer && !peer.alive) {
        ws.terminate();
        continue;
      }
      if (peer) peer.alive = false;
      try {
        ws.ping();
      } catch {
        /* dying socket */
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      logger(`listening on :${actualPort} (TRUST_PROXY=${trustProxy ? '1' : '0'}, heartbeat=${heartbeatMs}ms)`);
      resolve({
        httpServer,
        wss,
        rooms,
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            hub.close();
            for (const client of wss.clients) client.terminate();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}

/**
 * Optional TURN relay so cross-network transfers still connect behind symmetric/carrier NAT.
 * Direct P2P is always tried first by ICE; the relay is only used when nothing else works.
 * Either static TURN_USER/TURN_CRED, or TURN_SECRET for coturn's time-limited REST credentials.
 */
function buildIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  const url = process.env.TURN_URL?.trim();
  if (!url) return servers;
  const urls = url.split(',').map((u) => u.trim()).filter(Boolean);
  const secret = process.env.TURN_SECRET;
  if (secret) {
    const username = String(Math.floor(Date.now() / 1000) + 3600);
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls, username, credential });
  } else {
    servers.push({ urls, username: process.env.TURN_USER, credential: process.env.TURN_CRED });
  }
  return servers;
}
