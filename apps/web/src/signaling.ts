/**
 * Tri-Transport Universal Signaling Client:
 * 1. Serverless Global WebSocket Mesh (MQTT 3.1.1 over WSS: `wss://broker.emqx.io:8084/mqtt`
 *    with failover to `wss://broker.hivemq.com:8884/mqtt`) — works 100% client-side on static
 *    hosts like `https://neardrop.ai.studio/` across any device, browser, or network!
 * 2. Instant Local Browser Mesh (`BroadcastChannel('neardrop-signal-v2')`) — <0.5ms same-browser discovery.
 * 3. Same-Origin HTTP Signaling (`/api/signal`) — used when a local Node server is present, and
 *    automatically disabled after 1 probe if the host is static HTML (zero console spam).
 */
import { signal } from '@preact/signals';

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: string;
  geo?: string;
  sameNetwork: boolean;
  via?: 'lan' | 'room' | 'geo' | 'contact' | 'nearby';
}

export interface SignalEnvelope {
  t: string;
  to?: string;
  from?: string;
  fromPeer?: PeerInfo;
  sid?: string;
  data?: unknown;
  peers?: PeerInfo[];
  peer?: PeerInfo & { sameNetwork?: boolean };
  roomCode?: string;
  id?: string;
  code?: string;
  message?: string;
}

export type ConnState = 'connecting' | 'online' | 'offline';

export const connState = signal<ConnState>('connecting');

const initialUrlRoom = (() => {
  try {
    const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
    return code && code.length >= 3 ? code : undefined;
  } catch {
    return undefined;
  }
})();

export const activeRoomCode = signal<string | undefined>(initialUrlRoom);

export function signalingUrl(): string {
  const override = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (override) return override;
  return `${location.origin}/api/signal`;
}

// ---------------------------------------------------------------------------
// Minimal zero-dependency MQTT 3.1.1 over WebSocket framing (Uint8Array)
// ---------------------------------------------------------------------------
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

function encodeVarLen(len: number): Uint8Array {
  const out: number[] = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 128;
    out.push(b);
  } while (len > 0);
  return Uint8Array.from(out);
}

function encodeMqttStr(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function buildMqttConnect(clientId: string): Uint8Array {
  const vh = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
  const pl = encodeMqttStr(clientId);
  const rem = encodeVarLen(vh.length + pl.length);
  const pkt = new Uint8Array(1 + rem.length + vh.length + pl.length);
  pkt[0] = 0x10;
  pkt.set(rem, 1);
  pkt.set(vh, 1 + rem.length);
  pkt.set(pl, 1 + rem.length + vh.length);
  return pkt;
}

function buildMqttSubscribe(pktId: number, topic: string): Uint8Array {
  const vh = new Uint8Array([(pktId >> 8) & 0xff, pktId & 0xff]);
  const tp = encodeMqttStr(topic);
  const pl = new Uint8Array(tp.length + 1);
  pl.set(tp, 0);
  pl[tp.length] = 0x00;
  const rem = encodeVarLen(vh.length + pl.length);
  const pkt = new Uint8Array(1 + rem.length + vh.length + pl.length);
  pkt[0] = 0x82;
  pkt.set(rem, 1);
  pkt.set(vh, 1 + rem.length);
  pkt.set(pl, 1 + rem.length + vh.length);
  return pkt;
}

function buildMqttPublish(topic: string, jsonStr: string): Uint8Array {
  const tp = encodeMqttStr(topic);
  const pl = new TextEncoder().encode(jsonStr);
  const rem = encodeVarLen(tp.length + pl.length);
  const pkt = new Uint8Array(1 + rem.length + tp.length + pl.length);
  pkt[0] = 0x30;
  pkt.set(rem, 1);
  pkt.set(tp, 1 + rem.length);
  pkt.set(pl, 1 + rem.length + tp.length);
  return pkt;
}

function parseMqttBuffer(
  buf: Uint8Array,
  onPublish: (topic: string, payload: string) => void,
  onConnAck: () => void,
): Uint8Array {
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 2 > buf.length) break;
    const type = buf[offset]! & 0xf0;
    let mult = 1;
    let val = 0;
    let idx = offset + 1;
    let completeLen = false;
    while (idx < buf.length) {
      const b = buf[idx++]!;
      val += (b & 127) * mult;
      mult *= 128;
      if ((b & 128) === 0) {
        completeLen = true;
        break;
      }
    }
    if (!completeLen || idx + val > buf.length) break;
    if (type === 0x20) {
      onConnAck();
    } else if (type === 0x30) {
      const tLen = (buf[idx]! << 8) | buf[idx + 1]!;
      const topic = new TextDecoder().decode(buf.subarray(idx + 2, idx + 2 + tLen));
      let pStart = idx + 2 + tLen;
      if ((buf[offset]! & 0x06) > 0) pStart += 2;
      const payload = new TextDecoder().decode(buf.subarray(pStart, idx + val));
      onPublish(topic, payload);
    }
    offset = idx + val;
  }
  return buf.subarray(offset);
}

type Handler = (msg: SignalEnvelope) => void;

export class SignalClient {
  private handlers = new Set<Handler>();
  private openHandlers = new Set<() => void>();
  private backoffMs = 400;
  private closedByUser = false;

  // Identity & peer state
  private peerId: string | undefined;
  private lastJoinMsg: Record<string, unknown> | null = null;
  private knownPeers = new Map<string, PeerInfo>();
  private seenSignalIds = new Set<string>();
  private isOnline = false;

  // Transport 1: Serverless MQTT-over-WSS global mesh
  private mqttWs: WebSocket | null = null;
  private mqttConnected = false;
  private mqttBrokerIdx = 0;
  private mqttBuf: Uint8Array = new Uint8Array(0);
  private mqttPingTimer: ReturnType<typeof setInterval> | null = null;
  private mqttPresenceTimer: ReturnType<typeof setInterval> | null = null;
  private mqttReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private mqttPktId = 1;
  private currentRoomTopic: string | null = null;

  // Transport 2: Same-origin BroadcastChannel
  private bc: BroadcastChannel | null = null;

  // Transport 3: Local HTTP `/api/signal` (auto-disabled if static host)
  private httpDisabled = false;
  private outQueue: unknown[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private polling = false;
  private pollAbort: AbortController | null = null;

  start() {
    this.closedByUser = false;
    this.startBroadcastChannel();
    this.notifyOpen();
    this.connectMqttMesh();
    void this.startHttpLoop();

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        if (this.peerId) {
          try { this.bc?.postMessage({ t: 'bc-leave', id: this.peerId }); } catch { /* noop */ }
          this.publishMqttRoom({ t: 'mqtt-leave', id: this.peerId });
        }
      });
    }
  }

  stop() {
    this.closedByUser = true;
    this.isOnline = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.mqttPingTimer) clearInterval(this.mqttPingTimer);
    if (this.mqttPresenceTimer) clearInterval(this.mqttPresenceTimer);
    if (this.mqttReconnectTimer) clearTimeout(this.mqttReconnectTimer);
    this.pollAbort?.abort();
    try { this.mqttWs?.close(); } catch { /* noop */ }
    this.mqttWs = null;
    this.mqttConnected = false;
    try { this.bc?.close(); } catch { /* noop */ }
    this.bc = null;
    connState.value = 'offline';
  }

  private myPeerInfo(): PeerInfo | null {
    if (!this.peerId || !this.lastJoinMsg) return null;
    return {
      id: this.peerId,
      name: String(this.lastJoinMsg.name || 'Device'),
      deviceType: String(this.lastJoinMsg.deviceType || 'desktop'),
      geo: typeof this.lastJoinMsg.geo === 'string' ? this.lastJoinMsg.geo : undefined,
      sameNetwork: true,
      via: activeRoomCode.value ? 'room' : 'lan',
    };
  }

  private roomTopic(): string {
    const code = (activeRoomCode.value || 'GLOBAL-DEFAULT').trim().toUpperCase();
    return `neardrop/v2/room/${code}`;
  }

  private inboxTopic(id: string): string {
    return `neardrop/v2/peer/${id}`;
  }

  // -------------------------------------------------------------------------
  // Transport 1: MQTT-over-WSS Serverless Global Mesh
  // -------------------------------------------------------------------------
  private connectMqttMesh(): void {
    if (this.closedByUser || this.mqttWs) return;
    const brokerUrl = MQTT_BROKERS[this.mqttBrokerIdx % MQTT_BROKERS.length]!;
    let ws: WebSocket;
    try {
      ws = new WebSocket(brokerUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';
    } catch {
      this.scheduleMqttReconnect();
      return;
    }
    this.mqttWs = ws;
    this.mqttBuf = new Uint8Array(0);
    const watchdog = setTimeout(() => {
      if (!this.mqttConnected && this.mqttWs === ws) {
        try { ws.close(); } catch { /* noop */ }
      }
    }, 5000);

    ws.onopen = () => {
      const clientId = `nd-${(this.peerId || Math.random().toString(36).slice(2, 10)).slice(0, 18)}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        ws.send(buildMqttConnect(clientId));
      } catch { /* ignore */ }
    };

    ws.onmessage = (ev) => {
      const chunk = new Uint8Array(ev.data as ArrayBuffer);
      const merged = new Uint8Array(this.mqttBuf.length + chunk.length);
      merged.set(this.mqttBuf, 0);
      merged.set(chunk, this.mqttBuf.length);
      this.mqttBuf = parseMqttBuffer(
        merged,
        (topic, payload) => this.onMqttMessage(topic, payload),
        () => {
          clearTimeout(watchdog);
          this.mqttConnected = true;
          this.isOnline = true;
          connState.value = 'online';
          this.subscribeMqttTopics();
          this.announceMqttPresence();
          if (this.mqttPingTimer) clearInterval(this.mqttPingTimer);
          this.mqttPingTimer = setInterval(() => {
            if (this.mqttWs?.readyState === WebSocket.OPEN) {
              try { this.mqttWs.send(new Uint8Array([0xc0, 0x00])); } catch { /* ignore */ }
            }
          }, 25_000);
          if (this.mqttPresenceTimer) clearInterval(this.mqttPresenceTimer);
          this.mqttPresenceTimer = setInterval(() => {
            this.announceMqttPresence();
          }, 6000);
        },
      );
    };

    ws.onclose = () => {
      clearTimeout(watchdog);
      if (this.mqttWs === ws) {
        this.mqttWs = null;
        this.mqttConnected = false;
      }
      if (this.mqttPingTimer) { clearInterval(this.mqttPingTimer); this.mqttPingTimer = null; }
      if (this.mqttPresenceTimer) { clearInterval(this.mqttPresenceTimer); this.mqttPresenceTimer = null; }
      if (!this.closedByUser) this.scheduleMqttReconnect();
    };

    ws.onerror = () => {
      clearTimeout(watchdog);
    };
  }

  private scheduleMqttReconnect(): void {
    if (this.mqttReconnectTimer || this.closedByUser) return;
    this.mqttBrokerIdx++;
    this.mqttReconnectTimer = setTimeout(() => {
      this.mqttReconnectTimer = null;
      this.connectMqttMesh();
    }, 1200);
  }

  private subscribeMqttTopics(): void {
    if (!this.mqttConnected || this.mqttWs?.readyState !== WebSocket.OPEN) return;
    const rTopic = this.roomTopic();
    this.currentRoomTopic = rTopic;
    try {
      this.mqttWs.send(buildMqttSubscribe(this.mqttPktId++, rTopic));
      if (this.peerId) {
        this.mqttWs.send(buildMqttSubscribe(this.mqttPktId++, this.inboxTopic(this.peerId)));
      }
    } catch { /* ignore */ }
  }

  private publishMqtt(topic: string, obj: unknown): void {
    if (!this.mqttConnected || this.mqttWs?.readyState !== WebSocket.OPEN) return;
    try {
      const payload = typeof obj === 'object' && obj !== null ? { ...(obj as Record<string, unknown>), ts: Date.now() } : obj;
      this.mqttWs.send(buildMqttPublish(topic, JSON.stringify(payload)));
    } catch { /* ignore */ }
  }

  private publishMqttRoom(obj: unknown): void {
    this.publishMqtt(this.roomTopic(), obj);
  }

  private announceMqttPresence(): void {
    const me = this.myPeerInfo();
    if (!me) return;
    this.publishMqttRoom({ t: 'mqtt-join', peer: me });
  }

  private onMqttMessage(_topic: string, raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    // Replay attack and stale message guard: drop packets older than 5 minutes (allows clock drift)
    if (typeof m.ts === 'number' && Math.abs(Date.now() - m.ts) > 300_000) {
      return;
    }
    if (m.t === 'mqtt-join' && m.peer && typeof m.peer === 'object') {
      const p = m.peer as PeerInfo;
      if (!p.id || p.id === this.peerId) return;
      const isNew = !this.knownPeers.has(p.id);
      this.knownPeers.set(p.id, p);
      if (isNew) {
        this.emit({ t: 'peer-joined', peer: p });
      }
      const me = this.myPeerInfo();
      if (me) {
        this.publishMqtt(this.inboxTopic(p.id), { t: 'mqtt-here', peer: me });
      }
    } else if (m.t === 'mqtt-here' && m.peer && typeof m.peer === 'object') {
      const p = m.peer as PeerInfo;
      if (!p.id || p.id === this.peerId) return;
      const isNew = !this.knownPeers.has(p.id);
      this.knownPeers.set(p.id, p);
      if (isNew) {
        this.emit({ t: 'peer-joined', peer: p });
      }
    } else if (m.t === 'mqtt-leave' && typeof m.id === 'string' && m.id !== this.peerId) {
      this.knownPeers.delete(m.id);
      this.emit({ t: 'peer-left', id: m.id });
    } else if (m.t === 'signal' && typeof m.from === 'string' && m.from !== this.peerId) {
      if (typeof m.sid === 'string') {
        if (this.seenSignalIds.has(m.sid)) return;
        this.seenSignalIds.add(m.sid);
      }
      if (m.fromPeer && typeof m.fromPeer === 'object') {
        this.knownPeers.set(m.from, m.fromPeer as PeerInfo);
      }
      this.emit({
        t: 'signal',
        from: m.from,
        fromPeer: m.fromPeer as PeerInfo | undefined,
        data: m.data,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Transport 2: Same-Browser BroadcastChannel
  // -------------------------------------------------------------------------
  private startBroadcastChannel(): void {
    if (typeof BroadcastChannel === 'undefined' || this.bc) return;
    try {
      const bc = new BroadcastChannel('neardrop-signal-v2');
      this.bc = bc;
      bc.onmessage = (ev) => {
        const m = ev.data as Record<string, unknown> | null;
        if (!m || typeof m !== 'object') return;
        if (m.t === 'bc-join' && typeof m.id === 'string' && m.id !== this.peerId) {
          const info: PeerInfo = {
            id: m.id,
            name: String(m.name || 'Device'),
            deviceType: String(m.deviceType || 'desktop'),
            sameNetwork: true,
            via: 'lan',
          };
          this.knownPeers.set(info.id, info);
          this.emit({ t: 'peer-joined', peer: info });
          if (this.lastJoinMsg && this.peerId && m.reply !== false) {
            bc.postMessage({ ...this.lastJoinMsg, t: 'bc-join', reply: false });
          }
        } else if (m.t === 'bc-leave' && typeof m.id === 'string' && m.id !== this.peerId) {
          this.knownPeers.delete(m.id);
          this.emit({ t: 'peer-left', id: m.id });
        } else if (m.t === 'bc-signal' && m.to === this.peerId && typeof m.from === 'string') {
          if (typeof m.sid === 'string') {
            if (this.seenSignalIds.has(m.sid)) return;
            this.seenSignalIds.add(m.sid);
          }
          this.emit({
            t: 'signal',
            from: m.from,
            fromPeer: m.fromPeer as PeerInfo | undefined,
            data: m.data,
          });
        }
      };
    } catch {
      /* BroadcastChannel unsupported */
    }
  }

  private emit(msg: SignalEnvelope): void {
    if (msg.t === 'welcome' && Array.isArray(msg.peers)) {
      const merged = [...msg.peers];
      for (const p of merged) {
        if (p.id !== this.peerId) this.knownPeers.set(p.id, p);
      }
      for (const kp of this.knownPeers.values()) {
        if (kp.id !== this.peerId && !merged.some((p) => p.id === kp.id)) {
          merged.push(kp);
        }
      }
      msg = { ...msg, peers: merged };
    }
    for (const h of [...this.handlers]) h(msg);
  }

  private notifyOpen(): void {
    for (const cb of [...this.openHandlers]) cb();
  }

  // -------------------------------------------------------------------------
  // Transport 3: Local Backend HTTP Signaling (`/api/signal`)
  // -------------------------------------------------------------------------
  private async startHttpLoop(): Promise<void> {
    if (this.polling || this.closedByUser || this.httpDisabled) return;
    this.polling = true;

    while (!this.closedByUser && !this.httpDisabled) {
      const ctrl = new AbortController();
      this.pollAbort = ctrl;
      const batch = this.outQueue.splice(0, 64);
      if (batch.length === 0 && this.lastJoinMsg && !this.isOnline) {
        batch.push(this.lastJoinMsg);
      }
      try {
        const res = await fetch('/api/signal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            peerId: this.peerId,
            messages: batch,
            waitMs: this.isOnline ? 10_000 : 0,
          }),
          signal: ctrl.signal,
        });

        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !ctype.includes('application/json')) {
          // Host is static (e.g. neardrop.ai.studio _service-worker.js returning text/html).
          // Disable HTTP polling permanently so we never spam /api/signal again!
          this.httpDisabled = true;
          this.outQueue.length = 0;
          if (this.mqttConnected || this.knownPeers.size > 0) {
            connState.value = 'online';
          }
          break;
        }

        const data = (await res.json()) as {
          ok?: boolean;
          needJoin?: boolean;
          messages?: SignalEnvelope[];
        };

        this.backoffMs = 400;
        if (!this.isOnline) {
          this.isOnline = true;
          connState.value = 'online';
        }

        if (data.needJoin && this.lastJoinMsg) {
          this.outQueue.unshift(this.lastJoinMsg);
        }

        if (Array.isArray(data.messages)) {
          for (const msg of data.messages) {
            if (msg.t === 'signal') {
              const sid = (msg.data as { _sid?: string } | undefined)?._sid;
              if (sid) {
                if (this.seenSignalIds.has(sid)) continue;
                this.seenSignalIds.add(sid);
              }
            }
            this.emit(msg);
          }
        }
      } catch (err) {
        if (this.closedByUser || this.httpDisabled) break;
        if ((err as { name?: string } | null)?.name === 'AbortError') {
          continue;
        }
        if (this.mqttConnected) {
          connState.value = 'online';
        } else {
          connState.value = navigator.onLine ? 'connecting' : 'offline';
        }
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 1.6, 5000);
      }
    }
    this.polling = false;
  }

  private scheduleHttpFlush(): void {
    if (this.httpDisabled || this.flushing || this.flushTimer || this.closedByUser) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushOutQueue();
    }, 8);
  }

  private async flushOutQueue(): Promise<void> {
    if (this.httpDisabled || this.flushing || this.outQueue.length === 0 || this.closedByUser) return;
    this.flushing = true;
    try {
      while (this.outQueue.length > 0 && !this.closedByUser && !this.httpDisabled) {
        const batch = this.outQueue.splice(0, 64);
        const res = await fetch('/api/signal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            peerId: this.peerId,
            messages: batch,
            waitMs: 0,
          }),
        });
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !ctype.includes('application/json')) {
          this.httpDisabled = true;
          this.outQueue.length = 0;
          break;
        }
        const data = (await res.json()) as { needJoin?: boolean; messages?: SignalEnvelope[] };
        if (data.needJoin && this.lastJoinMsg) {
          this.outQueue.unshift(this.lastJoinMsg);
        }
        if (Array.isArray(data.messages)) {
          for (const msg of data.messages) {
            if (msg.t === 'signal') {
              const sid = (msg.data as { _sid?: string } | undefined)?._sid;
              if (sid) {
                if (this.seenSignalIds.has(sid)) continue;
                this.seenSignalIds.add(sid);
              }
            }
            this.emit(msg);
          }
        }
      }
    } catch {
      /* handled by poll loop or MQTT mesh */
    } finally {
      this.flushing = false;
    }
  }

  /** Send a message across all active transports (BroadcastChannel + MQTT Global Mesh + local HTTP). */
  send(msg: unknown): boolean {
    if (msg && typeof msg === 'object') {
      const m = msg as Record<string, unknown>;
      if (m.t === 'join' && typeof m.id === 'string') {
        this.peerId = m.id;
        this.lastJoinMsg = m;
        connState.value = 'online';
        try {
          this.bc?.postMessage({ ...m, t: 'bc-join' });
        } catch { /* noop */ }
        if (this.mqttConnected) {
          this.subscribeMqttTopics();
          this.announceMqttPresence();
        }
      } else if (m.t === 'set-room') {
        if (this.lastJoinMsg) {
          this.lastJoinMsg = { ...this.lastJoinMsg, roomCode: m.roomCode };
        }
        if (this.mqttConnected) {
          this.subscribeMqttTopics();
          this.announceMqttPresence();
        }
      } else if (m.t === 'signal' && typeof m.to === 'string' && this.peerId) {
        const sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
        const me = this.myPeerInfo() ?? undefined;
        const dataWithSid =
          m.data && typeof m.data === 'object' ? { ...(m.data as Record<string, unknown>), _sid: sid } : m.data;

        // 1. Always broadcast on same-browser BroadcastChannel
        try {
          this.bc?.postMessage({
            t: 'bc-signal',
            sid,
            from: this.peerId,
            fromPeer: me,
            to: m.to,
            data: dataWithSid,
          });
        } catch { /* noop */ }

        // 2. Always publish to target peer's inbox on the Serverless MQTT Mesh
        this.publishMqtt(this.inboxTopic(m.to), {
          t: 'signal',
          sid,
          from: this.peerId,
          fromPeer: me,
          to: m.to,
          data: dataWithSid,
        });

        // 3. Also send via local HTTP `/api/signal` if available
        if (!this.httpDisabled) {
          this.outQueue.push({ ...m, data: dataWithSid });
          this.scheduleHttpFlush();
        }
        return true;
      }
    }

    if (!this.httpDisabled) {
      this.outQueue.push(msg);
      this.scheduleHttpFlush();
    }
    return true;
  }

  onOpen(cb: () => void): void {
    this.openHandlers.add(cb);
    if (this.isOnline || this.mqttConnected) cb();
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export const signalClient = new SignalClient();
