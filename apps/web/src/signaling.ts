/**
 * Signaling client: WebSocket with reconnect/backoff.
 * URL derivation:
 *   - localhost dev → ws://localhost:3001
 *   - deployed behind the gateway/proxy → wss(s)://host/?XTransformPort=3001 (path must be '/')
 *   - VITE_SIGNALING_URL env override wins over everything
 */
import { signal } from '@preact/signals';

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: string;
  geo?: string;
  sameNetwork: boolean;
}

export interface SignalEnvelope {
  t: string;
  to?: string;
  from?: string;
  data?: unknown;
  peers?: PeerInfo[];
  peer?: PeerInfo & { sameNetwork?: boolean };
  id?: string;
  code?: string;
  message?: string;
}

export type ConnState = 'connecting' | 'online' | 'offline';

export const connState = signal<ConnState>('connecting');

export function signalingUrl(): string {
  const override = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (override) return override;
  const { protocol, hostname, host } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) {
    return `ws://${hostname}:3001`;
  }
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/?XTransformPort=3001`;
}

type Handler = (msg: SignalEnvelope) => void;

export class SignalClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private backoffMs = 400;
  private closedByUser = false;
  private joinPending: (() => void) | null = null;

  start() {
    this.closedByUser = false;
    void this.connect();
  }

  stop() {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
    connState.value = 'offline';
  }

  private connect(): void {
    // hard-reset: never leave a zombie CONNECTING socket behind
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      try { this.ws.close(); } catch { /* noop */ }
    } else if (this.ws) {
      return; // already open
    }
    this.ws = null;
    connState.value = 'connecting';
    const url = signalingUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // watchdog: a socket stuck in CONNECTING (server briefly gone, black-holed TCP)
    // never fires open/close — treat it as failed after 4s and try again.
    const watchdog = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* noop */ }
        if (this.ws === ws) this.ws = null;
        this.scheduleReconnect();
      }
    }, 4000);
    ws.onopen = () => {
      clearTimeout(watchdog);
      this.backoffMs = 400;
      connState.value = 'online';
      this.joinPending?.();
      this.joinPending = null;
    };
    ws.onmessage = (e) => {
      let msg: SignalEnvelope;
      try {
        msg = JSON.parse(String(e.data)) as SignalEnvelope;
      } catch {
        return;
      }
      for (const h of [...this.handlers]) h(msg);
    };
    ws.onclose = () => {
      clearTimeout(watchdog);
      if (this.ws === ws) this.ws = null;
      connState.value = 'offline';
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      clearTimeout(watchdog);
      if (this.ws === ws) this.ws = null;
      connState.value = navigator.onLine ? 'connecting' : 'offline';
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    connState.value = navigator.onLine ? 'connecting' : 'offline';
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.7, 8000);
  }

  /** Send once the socket is open (queues briefly if reconnecting). */
  send(msg: unknown): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  onOpen(cb: () => void): void {
    if (this.ws?.readyState === WebSocket.OPEN) cb();
    else this.joinPending = cb;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export const signalClient = new SignalClient();
