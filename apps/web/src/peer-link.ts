/**
 * WebRTC glue: PeerLink wraps RTCPeerConnection + control/data channels,
 * runs the identity handshake, exposes core-compatible ChannelLike objects
 * and debug info (selected ICE pair).
 */
import {
  parseControl, encodeControl, Handshake, ConnectionBrain,
  type ChannelLike, type FileSource, type Identity, type TransferConfig, type VerifiedPeerLike,
} from '@neardrop/core';
import type { PeerInfo } from './signaling.js';
import { session } from './identity.js';

const STUN_ENV = import.meta.env.VITE_STUN_URL as string | undefined;
const TURN_ENV = import.meta.env.VITE_TURN_URL as string | undefined;
const TURN_USER_ENV = import.meta.env.VITE_TURN_USER as string | undefined;
const TURN_CRED_ENV = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
  },
];

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = STUN_ENV ? [{ urls: STUN_ENV }] : [...DEFAULT_ICE_SERVERS];
  const s = session.value?.settings;
  const turnUrl = s?.turnUrl?.trim() || TURN_ENV;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: s?.turnUsername?.trim() || TURN_USER_ENV,
      credential: s?.turnCredential?.trim() || TURN_CRED_ENV,
    });
  }
  return servers;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * Fallback ChannelLike implementation over the WebSocket signaling relay.
 * Activated automatically when direct WebRTC + TURN cannot traverse a strict symmetric NAT or UDP firewall.
 */
export class WsRelayChannel extends EventTarget implements ChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 256 * 1024;

  constructor(
    public readonly label: string,
    private sendRelay: (label: string, payload: { text?: string; bin?: string }) => void,
  ) {
    super();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') return;
    if (typeof data === 'string') {
      this.sendRelay(this.label, { text: data });
    } else {
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sendRelay(this.label, { bin: bytesToBase64(view) });
    }
  }

  deliver(payload: { text?: string; bin?: string }): void {
    if (this.readyState !== 'open') return;
    const data = payload.text !== undefined ? payload.text : payload.bin ? base64ToArrayBuffer(payload.bin) : null;
    if (data !== null) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

/**
 * Dual-path control channel:
 * - Always `'open'` from `t = 0ms` via signaling relay (`WsRelayChannel('control')`).
 * - Simultaneously sends and receives over direct WebRTC `RTCDataChannel('control')` as soon as it opens.
 * - Deduplicates stateful control packets so sending over both paths is 100% safe and zero-latency.
 */
class DualControlChannel extends EventTarget implements ChannelLike {
  readonly label = 'control';
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 256 * 1024;
  private rtc: RTCDataChannel | null = null;
  private seen = new Map<string, number>();

  constructor(private relay: WsRelayChannel) {
    super();
    this.relay.addEventListener('message', (e) => this.onIncoming((e as MessageEvent).data));
  }

  attachRtc(ch: RTCDataChannel): void {
    this.rtc = ch;
    ch.addEventListener('message', (e) => this.onIncoming((e as MessageEvent).data));
  }

  private onIncoming(raw: unknown): void {
    if (this.readyState === 'closed') return;
    if (typeof raw === 'string') {
      const parsed = parseControl(raw);
      const t = parsed?.t;
      // Handshake and probe messages are naturally idempotent; deduplicate stateful transfer control frames
      if (t && t !== 'hello' && t !== 'confirm' && t !== 'probe' && t !== 'probe-ack') {
        const now = Date.now();
        const prev = this.seen.get(raw);
        if (prev !== undefined && now - prev < 5000) return;
        this.seen.set(raw, now);
        if (this.seen.size > 256) {
          for (const [k, ts] of this.seen) {
            if (now - ts >= 5000) this.seen.delete(k);
          }
        }
      }
    }
    this.dispatchEvent(new MessageEvent('message', { data: raw }));
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') return;
    let sentRtc = false;
    if (this.rtc && this.rtc.readyState === 'open') {
      try {
        this.rtc.send(data as never);
        sentRtc = true;
      } catch {
        /* fall through to relay */
      }
    }
    // Always mirror small control strings over the signaling relay so handshake/offer/accept
    // never stall even if WebRTC SCTP is still negotiating or half-open.
    if (!sentRtc || (typeof data === 'string' && data.length <= 16384)) {
      try {
        this.relay.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.relay.close();
    try { this.rtc?.close(); } catch { /* noop */ }
    this.dispatchEvent(new Event('close'));
  }
}

export interface PeerDebug {
  selectedPair: string;
  localType: string;
  remoteType: string;
  channels: Array<{ label: string; buffered: number; state: string }>;
}

export class PeerLink {
  pc: RTCPeerConnection;
  control: DualControlChannel;
  /** Receiver-facing data channel list (contains unified ingress channel open from t=0ms) */
  data: ChannelLike[] = [];
  /** Direct WebRTC data channels for high-speed P2P sending when open */
  rtcData: RTCDataChannel[] = [];
  peer: VerifiedPeerLike | null = null;
  connected = true;
  usingRelayFallback = false;
  handshakeFailed = false;
  closed = false;
  public readonly brain = new ConnectionBrain();
  lastDebug: PeerDebug = { selectedPair: 'signaling+webrtc', localType: 'hybrid', remoteType: 'hybrid', channels: [] };

  private handshake: Handshake;
  private controlListeners = new Set<(msg: any) => void>();
  private debugTimer: ReturnType<typeof setInterval> | null = null;
  private relayFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private relayChannels = new Map<string, WsRelayChannel>();
  private relayData: WsRelayChannel;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    public peerId: string,
    public info: PeerInfo,
    private sendSignal: (to: string, data: unknown) => void,
    private identity: Identity,
    private me: { name: string; deviceType: string },
    private onVerified: (link: PeerLink) => void,
    initiator: boolean,
  ) {
    this.handshake = new Handshake({ identity: this.identity, name: this.me.name, deviceType: this.me.deviceType });
    this.handshake.result
      .then((peer) => {
        if (this.closed) return;
        this.peer = peer;
        this.connected = true;
        this.handshakeFailed = false;
        this.onVerified(this);
      })
      .catch((err) => {
        if (this.closed) return;
        this.handshakeFailed = true;
        console.warn('[nd] handshake incomplete:', err instanceof Error ? err.message : String(err));
      });

    // 1. Pre-create instant signaling relay channels at t = 0ms so handshake and control start immediately!
    const relayControl = this.getOrCreateRelayChannel('control');
    this.relayData = this.getOrCreateRelayChannel('data-0');
    this.data = [this.relayData];
    this.control = new DualControlChannel(relayControl);
    this.wireControl(this.control);

    // Register instant Relay path with ConnectionBrain
    this.brain.registerTransport({
      id: 'relay',
      type: 'relay',
      controlChannel: relayControl,
      dataChannels: [this.relayData],
      isReady: true,
      priorityWeight: 1,
    });

    // 2. Simultaneously negotiate direct WebRTC P2P data channels in parallel
    this.pc = new RTCPeerConnection({
      iceServers: buildIceServers(),
      iceCandidatePoolSize: 4,
    });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(peerId, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        this.usingRelayFallback = true;
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'connected') {
        this.connected = true;
      } else if (this.pc.connectionState === 'failed') {
        this.usingRelayFallback = true;
        if (initiator) void this.restartIce();
      }
    };
    this.pc.ondatachannel = (e) => this.wireChannel(e.channel);

    if (initiator) {
      const rtcCtrl = this.pc.createDataChannel('control');
      this.control.attachRtc(rtcCtrl);
      this.createDataChannels(4);
      void this.makeOffer();
    }
  }

  private getOrCreateRelayChannel(label: string): WsRelayChannel {
    let ch = this.relayChannels.get(label);
    if (!ch) {
      ch = new WsRelayChannel(label, (lbl, payload) => {
        this.sendSignal(this.peerId, { type: 'ws-relay', label: lbl, payload });
      });
      this.relayChannels.set(label, ch);
    }
    return ch;
  }

  private async makeOffer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal(this.peerId, { type: 'offer', sdp: this.pc.localDescription?.sdp });
    } catch { /* ignore */ }
  }

  private async restartIce(): Promise<void> {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      this.sendSignal(this.peerId, { type: 'offer', sdp: this.pc.localDescription?.sdp });
    } catch { /* dead */ }
  }

  wireChannel(ch: RTCDataChannel): void {
    if (ch.label === 'control') {
      this.control.attachRtc(ch);
    } else {
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 1024 * 1024;
      if (!this.rtcData.includes(ch)) this.rtcData.push(ch);
      // Register direct P2P transport with ConnectionBrain
      this.brain.registerTransport({
        id: 'webrtc-p2p',
        type: this.info.sameNetwork ? 'p2p-lan' : 'p2p-direct',
        controlChannel: this.control,
        dataChannels: this.rtcData,
        isReady: this.rtcData.some((c) => c.readyState === 'open'),
        priorityWeight: 2,
      });
      ch.addEventListener('open', () => {
        this.brain.evaluatePaths('webrtc datachannel opened');
      });
      // Forward all incoming WebRTC binary frames into the unified `relayData` ingress channel
      // so TransferReceiver receives 100% of frames even if RTCDataChannels open after `offer-files`.
      ch.addEventListener('message', (e) => {
        this.relayData.dispatchEvent(new MessageEvent('message', { data: (e as MessageEvent).data }));
      });
    }
  }

  private wireControl(ch: DualControlChannel): void {
    ch.addEventListener('message', (e) => {
      const msg = parseControl(String((e as MessageEvent).data));
      if (!msg) return;
      if (this.handshake.handle(msg)) return;
      for (const fn of [...this.controlListeners]) fn(msg);
    });
    // Start handshake immediately at t = 0ms!
    this.handshake.start((m) => {
      try { this.control.send(encodeControl(m as never)); } catch { /* gone */ }
    });
    this.startDebugPoll();
  }

  onControl(fn: (msg: any) => void): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  /** Create or return data channels for an outgoing transfer. */
  createDataChannels(count: number): ChannelLike[] {
    const existing = this.rtcData.filter((c) => c.readyState === 'open' || c.readyState === 'connecting');
    for (let i = existing.length; i < count; i++) {
      try {
        const ch = this.pc.createDataChannel(`data-${i}`);
        ch.binaryType = 'arraybuffer';
        ch.bufferedAmountLowThreshold = 1024 * 1024;
        this.rtcData.push(ch);
        ch.addEventListener('message', (e) => {
          this.relayData.dispatchEvent(new MessageEvent('message', { data: (e as MessageEvent).data }));
        });
      } catch {
        break;
      }
    }
    return this.openDataChannels();
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc.remoteDescription || this.pendingCandidates.length === 0) return;
    const queue = this.pendingCandidates.splice(0, this.pendingCandidates.length);
    for (const c of queue) {
      try {
        await this.pc.addIceCandidate(c);
      } catch { /* ignore stale candidate */ }
    }
  }

  async handleSignal(data: any): Promise<void> {
    if (data?.type === 'ws-relay-init') {
      return;
    }
    if (data?.type === 'ws-relay' && typeof data.label === 'string' && data.payload) {
      const ch = this.getOrCreateRelayChannel(data.label);
      ch.deliver(data.payload);
      return;
    }
    if (data?.type === 'offer') {
      try {
        if (this.pc.signalingState !== 'stable') {
          const myId = this.identity.deviceId;
          const remoteId = this.peerId;
          if (myId < remoteId) return;
          await this.pc.setLocalDescription({ type: 'rollback' });
        }
        await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await this.flushPendingCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal(this.peerId, { type: 'answer', sdp: this.pc.localDescription?.sdp });
      } catch (err) {
        console.debug('[nd] answer path error', err);
      }
    } else if (data?.type === 'answer') {
      try {
        if (this.pc.signalingState === 'have-local-offer') {
          const fixedSdp = this.ensureValidSetupAttribute(data.sdp);
          await this.pc.setRemoteDescription({ type: 'answer', sdp: fixedSdp });
          await this.flushPendingCandidates();
        }
      } catch (err) {
        console.debug('[nd] setRemoteDescription(answer) error', err);
      }
    } else if (data?.type === 'candidate' && data.candidate) {
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(data.candidate as RTCIceCandidateInit);
      } else {
        try {
          await this.pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
        } catch { /* stale candidate */ }
      }
    }
  }

  private ensureValidSetupAttribute(sdp: string): string {
    return sdp.replace(/a=setup:actpass/g, 'a=setup:active');
  }

  /** Channels compatible with @neardrop/core. */
  controlChannel(): ChannelLike | null {
    return this.control.readyState === 'open' ? this.control : null;
  }

  /** Returns open WebRTC data channels if available, otherwise the always-open signaling relay data channel. */
  openDataChannels(): ChannelLike[] {
    const openRtc = this.rtcData.filter((c) => c.readyState === 'open');
    if (openRtc.length > 0) {
      this.usingRelayFallback = false;
      return openRtc;
    }
    this.usingRelayFallback = true;
    return [this.relayData];
  }

  fileSource(file: File): FileSource {
    return {
      meta: { name: file.name, size: file.size, type: file.type || 'application/octet-stream' },
      stream: (start?: number) =>
        start && start > 0 ? (file.slice(start) as File).stream() : (file as Blob).stream(),
    };
  }

  startDebugPoll(): void {
    if (this.debugTimer) return;
    this.debugTimer = setInterval(() => void this.collectDebug(), 1000);
  }

  private async collectDebug(): Promise<void> {
    try {
      const openRtc = this.rtcData.filter((c) => c.readyState === 'open');
      if (openRtc.length === 0) {
        this.lastDebug = {
          selectedPair: 'instant-relay',
          localType: 'relay/http+bc',
          remoteType: 'relay/http+bc',
          channels: [
            { label: 'control', buffered: 0, state: this.control.readyState },
            { label: 'data-0', buffered: 0, state: this.relayData.readyState },
          ],
        };
        return;
      }
      const stats = await this.pc.getStats();
      let selected: RTCIceCandidatePairStats | undefined;
      const candidates = new Map<string, any>();
      stats.forEach((s: any) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') selected = s;
        if (s.type === 'local-candidate' || s.type === 'remote-candidate') candidates.set(s.id, s);
      });
      const local = selected ? candidates.get(selected.localCandidateId) : undefined;
      const remote = selected ? candidates.get(selected.remoteCandidateId) : undefined;
      const rtt = selected?.currentRoundTripTime;
      if (rtt !== undefined) {
        this.brain.updateMetrics('webrtc-p2p', {
          rttMs: rtt * 1000,
          bytesDelivered: selected?.bytesSent ?? 0,
          intervalSec: 1,
        });
      }
      this.lastDebug = {
        selectedPair: selected && rtt !== undefined ? `${(rtt * 1000).toFixed(1)}ms rtt` : 'p2p-active',
        localType: local ? `${local.candidateType}/${local.protocol ?? '?'}` : 'webrtc',
        remoteType: remote ? `${remote.candidateType}/${remote.protocol ?? '?'}` : 'webrtc',
        channels: [this.control, ...openRtc].map((c) => ({
          label: c.label,
          buffered: c.bufferedAmount,
          state: c.readyState,
        })),
      };
    } catch { /* pc closed */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handshake.cancel();
    if (this.debugTimer) clearInterval(this.debugTimer);
    if (this.relayFallbackTimer) clearTimeout(this.relayFallbackTimer);
    this.brain.destroy();
    this.control.close();
    for (const ch of this.relayChannels.values()) ch.close();
    try { this.pc.close(); } catch { /* noop */ }
  }
}

/** Wait briefly for direct WebRTC data channels to open; falls back to always-open relayData channel immediately. */
export function waitForChannels(link: PeerLink, count: number, timeoutMs = 600): Promise<ChannelLike[]> {
  const openRtc = link.rtcData.filter((c) => c.readyState === 'open');
  if (openRtc.length >= count) {
    return Promise.resolve(openRtc.slice(0, count));
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(link.openDataChannels());
    }, timeoutMs);
    const check = () => {
      const ready = link.rtcData.filter((c) => c.readyState === 'open');
      if (ready.length >= count) {
        cleanup();
        resolve(ready.slice(0, count));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      for (const ch of link.rtcData) ch.removeEventListener('open', check);
    };
    for (const ch of link.rtcData) ch.addEventListener('open', check);
    check();
  });
}

export const DEFAULT_TRANSFER_CONFIG: Partial<TransferConfig> = {
  parallelChannels: 8,
  verifyThresholdBytes: 64 * 1024 * 1024,
};
