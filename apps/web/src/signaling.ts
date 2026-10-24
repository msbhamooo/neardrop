/**
 * Universal Signaling Client:
 * - Primary: HTTP Long-Polling + Batched Instant POST (`/api/signal`) — passes through
 *   every reverse proxy, CDN, Cloud Run ingress, and AI Studio gateway (`*.ai.studio`)
 *   without triggering WebSocket handshake 502 errors or `_websocket-interceptor.js`.
 * - Parallel Local Mesh: `BroadcastChannel('neardrop-signal-v1')` for <1ms same-device discovery.
 * - Optional WebSocket override when `VITE_SIGNALING_URL` explicitly specifies `ws://` or `wss://`.
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

type Handler = (msg: SignalEnvelope) => void;

export class SignalClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private openHandlers = new Set<() => void>();
  private backoffMs = 400;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // HTTP signaling state
  private peerId: string | undefined;
  private lastJoinMsg: Record<string, unknown> | null = null;
  private outQueue: unknown[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private polling = false;
  private pollAbort: AbortController | null = null;
  private isOnline = false;

  // Same-origin BroadcastChannel for instant multi-tab / offline local discovery
  private bc: BroadcastChannel | null = null;
  private bcPeers = new Map<string, PeerInfo>();

  start() {
    this.closedByUser = false;
    this.startBroadcastChannel();
    const override = import.meta.env.VITE_SIGNALING_URL as string | undefined;
    if (override && (override.startsWith('ws://') || override.startsWith('wss://'))) {
      this.connectWs(override);
    } else {
      void this.startHttpLoop();
    }
  }

  stop() {
    this.closedByUser = true;
    this.isOnline = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pollAbort?.abort();
    this.pollAbort = null;
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
    try { this.bc?.close(); } catch { /* noop */ }
    this.bc = null;
    connState.value = 'offline';
  }

  private startBroadcastChannel(): void {
    if (typeof BroadcastChannel === 'undefined' || this.bc) return;
    try {
      const bc = new BroadcastChannel('neardrop-signal-v1');
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
          this.bcPeers.set(info.id, info);
          this.emit({ t: 'peer-joined', peer: info });
          if (this.lastJoinMsg && this.peerId && m.reply !== false) {
            bc.postMessage({ ...this.lastJoinMsg, t: 'bc-join', reply: false });
          }
        } else if (m.t === 'bc-signal' && m.to === this.peerId && typeof m.from === 'string') {
          this.emit({ t: 'signal', from: m.from, data: m.data });
        }
      };
    } catch {
      /* BroadcastChannel unsupported */
    }
  }

  private emit(msg: SignalEnvelope): void {
    if (msg.t === 'welcome' && Array.isArray(msg.peers) && this.bcPeers.size > 0) {
      const merged = [...msg.peers];
      for (const bp of this.bcPeers.values()) {
        if (bp.id !== this.peerId && !merged.some((p) => p.id === bp.id)) {
          merged.push(bp);
        }
      }
      msg = { ...msg, peers: merged };
    }
    for (const h of [...this.handlers]) h(msg);
  }

  private notifyOpen(): void {
    for (const cb of [...this.openHandlers]) cb();
  }

  private async startHttpLoop(): Promise<void> {
    if (this.polling || this.closedByUser) return;
    this.polling = true;
    connState.value = 'connecting';

    // Immediately trigger join callback so `this.lastJoinMsg` is queued for the very first POST
    this.notifyOpen();

    while (!this.closedByUser) {
      const ctrl = new AbortController();
      this.pollAbort = ctrl;
      const batch = this.outQueue.splice(0, 64);
      if (!this.isOnline && batch.length === 0 && this.lastJoinMsg) {
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
          throw new Error(`HTTP ${res.status}`);
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
            this.emit(msg);
          }
        }
      } catch (err) {
        if (this.closedByUser) break;
        if ((err as { name?: string } | null)?.name === 'AbortError') {
          continue;
        }
        this.isOnline = false;
        // If we have local BroadcastChannel peers, stay online for local tab transfers
        connState.value = this.bcPeers.size > 0 ? 'online' : (navigator.onLine ? 'connecting' : 'offline');
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 1.6, 5000);
      }
    }
    this.polling = false;
  }

  private scheduleHttpFlush(): void {
    if (this.flushing || this.flushTimer || this.closedByUser) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushOutQueue();
    }, 8);
  }

  private async flushOutQueue(): Promise<void> {
    if (this.flushing || this.outQueue.length === 0 || this.closedByUser) return;
    this.flushing = true;
    try {
      while (this.outQueue.length > 0 && !this.closedByUser) {
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
        if (res.ok && ctype.includes('application/json')) {
          const data = (await res.json()) as { needJoin?: boolean; messages?: SignalEnvelope[] };
          if (!this.isOnline) {
            this.isOnline = true;
            connState.value = 'online';
          }
          if (data.needJoin && this.lastJoinMsg) {
            this.outQueue.unshift(this.lastJoinMsg);
          }
          if (Array.isArray(data.messages)) {
            for (const msg of data.messages) this.emit(msg);
          }
        }
      }
    } catch {
      /* Poll loop handles backoff and reconnection */
    } finally {
      this.flushing = false;
    }
  }

  private connectWs(url: string): void {
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      try { this.ws.close(); } catch { /* noop */ }
    } else if (this.ws) {
      return;
    }
    this.ws = null;
    connState.value = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleWsReconnect(url);
      return;
    }
    this.ws = ws;
    const watchdog = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* noop */ }
        if (this.ws === ws) this.ws = null;
        this.scheduleWsReconnect(url);
      }
    }, 4000);
    ws.onopen = () => {
      clearTimeout(watchdog);
      this.backoffMs = 400;
      this.isOnline = true;
      connState.value = 'online';
      this.notifyOpen();
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as SignalEnvelope;
        this.emit(msg);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      clearTimeout(watchdog);
      if (this.ws === ws) this.ws = null;
      this.isOnline = false;
      connState.value = 'offline';
      if (!this.closedByUser) this.scheduleWsReconnect(url);
    };
    ws.onerror = () => {
      clearTimeout(watchdog);
      // Let onclose handle the single reconnect schedule
    };
  }

  private scheduleWsReconnect(url: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    connState.value = navigator.onLine ? 'connecting' : 'offline';
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connectWs(url);
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.7, 8000);
  }

  /** Send a message to the signaling server (and BroadcastChannel when applicable). */
  send(msg: unknown): boolean {
    if (msg && typeof msg === 'object') {
      const m = msg as Record<string, unknown>;
      if (m.t === 'join' && typeof m.id === 'string') {
        this.peerId = m.id;
        this.lastJoinMsg = m;
        try {
          this.bc?.postMessage({ ...m, t: 'bc-join' });
        } catch { /* noop */ }
      } else if (m.t === 'set-room') {
        if (this.lastJoinMsg) {
          this.lastJoinMsg = { ...this.lastJoinMsg, roomCode: m.roomCode };
        }
      } else if (m.t === 'signal' && typeof m.to === 'string' && this.peerId) {
        if (this.bcPeers.has(m.to)) {
          try {
            this.bc?.postMessage({ t: 'bc-signal', from: this.peerId, to: m.to, data: m.data });
          } catch { /* noop */ }
        }
      }
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    }

    this.outQueue.push(msg);
    this.scheduleHttpFlush();
    return true;
  }

  onOpen(cb: () => void): void {
    this.openHandlers.add(cb);
    if (this.isOnline) cb();
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export const signalClient = new SignalClient();
