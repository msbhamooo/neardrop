/**
 * NearDrop signaling server — factory (testable).
 * Relay-only: rooms keyed by hashed client IP, optional geohash proximity,
 * heartbeat eviction, per-socket rate limiting. No SDP logging, no storage.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomRegistry, type Peer } from './rooms.js';
import { TokenBucket } from './ratelimit.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

export interface SignalingOptions {
  port?: number;
  trustProxy?: boolean;
  heartbeatMs?: number;
  log?: boolean;
  maxPayload?: number;
}

export interface SignalingServer {
  httpServer: Server;
  wss: WebSocketServer;
  rooms: RoomRegistry;
  port: number;
  close(): Promise<void>;
}

export function createSignalingServer(opts: SignalingOptions = {}): Promise<SignalingServer> {
  const {
    port = 0,
    trustProxy = process.env.TRUST_PROXY === '1',
    heartbeatMs = 15_000,
    log = process.env.LOG === '1',
    maxPayload = 32 * 1024,
  } = opts;

  const rooms = new RoomRegistry();
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

  const httpServer = createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, peers: rooms.count(), uptime: process.uptime() }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    buckets.set(ws, new TokenBucket(40, 12));
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
        if (s >= 3) ws.terminate();
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
            room: rooms.roomForIp(ip),
            alive: true,
            strikes: 0,
          };
          peers.set(ws, peer);
          rooms.add(peer);
          joined.set(ws, true);
          const others = rooms.visiblePeers(peer);
          rooms.send(peer, { t: 'welcome', peers: others.map((o) => rooms.toPeerInfo(o, peer)) });
          rooms.broadcastVisible(peer, { t: 'peer-joined', peer: rooms.toPeerInfo(peer, peer) });
          logger('join', peer.id.slice(0, 8), 'room', peer.room.slice(0, 11), `peers=${rooms.count()}`);
          return;
        }
        case 'signal': {
          const from = peers.get(ws);
          if (!from) return sendError(ws, 'not-joined', 'join first');
          if (typeof msg.to !== 'string' || typeof msg.data === 'undefined') {
            return sendError(ws, 'bad-message', 'bad signal payload');
          }
          const to = rooms.getById(msg.to);
          if (!to || !rooms.visible(to, from)) {
            logger('relay blocked', (from.id || '').slice(0, 8), '→', String(msg.to).slice(0, 8), `(visible=${!!to})`);
            return sendError(ws, 'unknown-peer', 'peer not visible');
          }
          logger('relay', from.id.slice(0, 8), '→', to.id.slice(0, 8), (msg.data as { type?: string } | undefined)?.type ?? '?');
          rooms.send(to, { t: 'signal', from: from.id, data: msg.data }); // opaque relay — never logged
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
            for (const client of wss.clients) client.terminate();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}
