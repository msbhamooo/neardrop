import { RoomRegistry, type Peer } from './rooms.js';
import { TokenBucket } from './ratelimit.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

/**
 * Transport-agnostic HTTP long-poll signaling hub. Runtime-neutral (no node:http, no ws):
 * the Node server and the Cloudflare Durable Object both feed it request bodies and relay its
 * JSON replies, so there is exactly one implementation of join / set-room / signal behavior.
 */
interface HttpSession {
  peer: Peer;
  queue: ServerMessage[];
  waiter: ((msgs: ServerMessage[]) => void) | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
  lastSeenMs: number;
  bucket: TokenBucket;
}

export interface HubReply {
  status: number;
  body: unknown;
}

export interface HubOptions {
  /** drop sessions that have not polled for this long */
  sessionTimeoutMs?: number;
  maxPayload?: number;
  log?: (...args: unknown[]) => void;
}

export class HttpSignalHub {
  readonly rooms: RoomRegistry;
  private sessions = new Map<string, HttpSession>();
  private readonly sessionTimeoutMs: number;
  private readonly maxPayload: number;
  private readonly log: (...args: unknown[]) => void;

  constructor(opts: HubOptions & { rooms?: RoomRegistry } = {}) {
    this.rooms = opts.rooms ?? new RoomRegistry();
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 35_000;
    this.maxPayload = opts.maxPayload ?? 512 * 1024;
    this.log = opts.log ?? (() => undefined);
  }

  /** Number of connected peers (all transports sharing `rooms`). */
  count(): number {
    return this.rooms.count();
  }

  /** Remove sessions that stopped polling and tell their neighbours. */
  sweep(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenMs > this.sessionTimeoutMs) {
        if (session.waitTimer) clearTimeout(session.waitTimer);
        this.sessions.delete(id);
        this.rooms.remove(session.peer);
        this.rooms.broadcastVisible(session.peer, { t: 'peer-left', id: session.peer.id });
        this.log('http-leave (timeout)', id.slice(0, 8), `peers=${this.rooms.count()}`);
      }
    }
  }

  close(): void {
    for (const s of this.sessions.values()) {
      if (s.waitTimer) clearTimeout(s.waitTimer);
      s.waiter?.([]);
    }
    this.sessions.clear();
  }

  private handleMessage(ip: string, msg: ClientMessage, currentPeerId?: string): { peerId?: string; err?: ServerMessage } {
    const rooms = this.rooms;
    switch (msg.t) {
      case 'ping': {
        if (currentPeerId) this.sessions.get(currentPeerId)?.peer.sendFn?.({ t: 'pong' });
        return { peerId: currentPeerId };
      }
      case 'join': {
        const join = RoomRegistry.normalizeJoin(msg);
        if (!join) return { peerId: currentPeerId, err: { t: 'error', code: 'bad-message', message: 'bad join payload' } };
        let session = this.sessions.get(join.id);
        if (!session) {
          const peer: Peer = {
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
          const created: HttpSession = {
            peer,
            queue: [],
            waiter: null,
            waitTimer: null,
            lastSeenMs: Date.now(),
            bucket: new TokenBucket(600, 300),
          };
          peer.sendFn = (outMsg: ServerMessage) => {
            if (created.waiter) {
              if (created.waitTimer) {
                clearTimeout(created.waitTimer);
                created.waitTimer = null;
              }
              const w = created.waiter;
              created.waiter = null;
              const drained = created.queue.splice(0);
              drained.push(outMsg);
              w(drained);
            } else if (created.queue.length < 512) {
              created.queue.push(outMsg);
            }
          };
          this.sessions.set(join.id, created);
          session = created;
        } else {
          session.peer.name = join.name;
          session.peer.deviceType = join.deviceType;
          session.peer.geo = join.geo;
          session.peer.roomCode = join.roomCode;
          session.peer.pairedIds = join.pairedIds ? new Set(join.pairedIds) : undefined;
          session.peer.room = rooms.roomForIp(ip);
          session.peer.alive = true;
          session.lastSeenMs = Date.now();
        }
        rooms.add(session.peer);
        const others = rooms.visiblePeers(session.peer);
        const me = session.peer;
        rooms.send(me, { t: 'welcome', peers: others.map((o) => rooms.toPeerInfo(o, me)), roomCode: me.roomCode });
        for (const other of others) rooms.send(other, { t: 'peer-joined', peer: rooms.toPeerInfo(me, other) });
        this.log('http-join', me.id.slice(0, 8), 'room', me.room.slice(0, 11), `peers=${rooms.count()}`);
        return { peerId: me.id };
      }
      case 'set-room': {
        const s = currentPeerId ? this.sessions.get(currentPeerId) : undefined;
        if (!s) return { peerId: currentPeerId, err: { t: 'error', code: 'not-joined', message: 'join first' } };
        const peer = s.peer;
        const before = new Set(rooms.visiblePeers(peer));
        peer.roomCode = RoomRegistry.normalizeRoomCode(msg.roomCode);
        const after = new Set(rooms.visiblePeers(peer));
        for (const oldPeer of before) if (!after.has(oldPeer)) rooms.send(oldPeer, { t: 'peer-left', id: peer.id });
        for (const newPeer of after) rooms.send(newPeer, { t: 'peer-joined', peer: rooms.toPeerInfo(peer, newPeer) });
        rooms.send(peer, { t: 'welcome', peers: [...after].map((o) => rooms.toPeerInfo(o, peer)), roomCode: peer.roomCode });
        return { peerId: currentPeerId };
      }
      case 'signal': {
        const s = currentPeerId ? this.sessions.get(currentPeerId) : undefined;
        if (!s) return { peerId: currentPeerId, err: { t: 'error', code: 'not-joined', message: 'join first' } };
        if (!s.bucket.take()) return { peerId: currentPeerId, err: { t: 'error', code: 'rate-limited', message: 'slow down' } };
        if (typeof msg.to !== 'string' || typeof msg.data === 'undefined') {
          return { peerId: currentPeerId, err: { t: 'error', code: 'bad-message', message: 'bad signal payload' } };
        }
        const to = rooms.getById(msg.to);
        if (!to || !rooms.visible(s.peer, to)) {
          return { peerId: currentPeerId, err: { t: 'error', code: 'unknown-peer', message: 'peer not connected' } };
        }
        rooms.send(to, { t: 'signal', from: s.peer.id, fromPeer: rooms.toPeerInfo(s.peer, to), data: msg.data });
        return { peerId: currentPeerId };
      }
      default:
        return { peerId: currentPeerId, err: { t: 'error', code: 'bad-message', message: 'unknown message type' } };
    }
  }

  /**
   * Handle one POST /api/signal. `isClosed` lets the caller tell us the HTTP client went away so a
   * pending long-poll is released instead of holding the next message hostage.
   */
  handle(ip: string, bodyText: string, onClose?: (cb: () => void) => void): Promise<HubReply> {
    if (bodyText.length > this.maxPayload * 2) {
      return Promise.resolve({ status: 413, body: { ok: false, error: 'payload too large' } });
    }
    let payload: { peerId?: string; messages?: ClientMessage[]; waitMs?: number };
    try {
      payload = bodyText ? (JSON.parse(bodyText) as typeof payload) : {};
    } catch {
      return Promise.resolve({ status: 400, body: { ok: false, error: 'invalid JSON' } });
    }

    let peerId = typeof payload.peerId === 'string' ? payload.peerId : undefined;
    const inlineErrors: ServerMessage[] = [];
    if (Array.isArray(payload.messages)) {
      for (const m of payload.messages) {
        if (!m || typeof m !== 'object') continue;
        const out = this.handleMessage(ip, m, peerId);
        if (out.peerId) peerId = out.peerId;
        if (out.err) inlineErrors.push(out.err);
      }
    }
    const session = peerId ? this.sessions.get(peerId) : undefined;
    if (!session) return Promise.resolve({ status: 200, body: { ok: true, needJoin: true, messages: inlineErrors } });
    session.lastSeenMs = Date.now();
    session.peer.alive = true;

    if (session.queue.length > 0 || inlineErrors.length > 0 || !payload.waitMs || payload.waitMs <= 0) {
      return Promise.resolve({ status: 200, body: { ok: true, messages: [...session.queue.splice(0), ...inlineErrors] } });
    }

    // Long-poll for up to 12s so pushes arrive immediately over plain HTTP.
    const waitMs = Math.min(Number(payload.waitMs) || 10_000, 12_000);
    if (session.waiter) {
      if (session.waitTimer) {
        clearTimeout(session.waitTimer);
        session.waitTimer = null;
      }
      const prev = session.waiter;
      session.waiter = null;
      prev([]);
    }

    return new Promise<HubReply>((resolve) => {
      let finished = false;
      const finish = (messages: ServerMessage[]) => {
        if (finished) return;
        finished = true;
        if (session.waitTimer) {
          clearTimeout(session.waitTimer);
          session.waitTimer = null;
        }
        if (session.waiter === finish) session.waiter = null;
        resolve({ status: 200, body: { ok: true, messages } });
      };
      session.waiter = finish;
      session.waitTimer = setTimeout(() => finish(session.queue.splice(0)), waitMs);
      onClose?.(() => {
        if (finished) return;
        finished = true;
        if (session.waitTimer) {
          clearTimeout(session.waitTimer);
          session.waitTimer = null;
        }
        if (session.waiter === finish) session.waiter = null;
        resolve({ status: 499, body: { ok: false } });
      });
    });
  }
}
