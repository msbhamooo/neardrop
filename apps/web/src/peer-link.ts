/**
 * WebRTC glue: PeerLink wraps RTCPeerConnection + control/data channels,
 * runs the identity handshake, exposes core-compatible ChannelLike objects
 * and debug info (selected ICE pair).
 */
import {
  parseControl, encodeControl, Handshake,
  type ChannelLike, type FileSource, type Identity, type TransferConfig, type VerifiedPeerLike,
} from '@neardrop/core';
import type { PeerInfo } from './signaling.js';

const STUN_ENV = import.meta.env.VITE_STUN_URL as string | undefined;
/** In local dev (or when empty), use pure-LAN host candidates. STUN is optional. */
// FIX: Add default Google STUN server for better NAT traversal
const DEFAULT_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
const STUN = STUN_ENV ? [{ urls: STUN_ENV }] : DEFAULT_STUN;

export interface PeerDebug {
  selectedPair: string;
  localType: string;
  remoteType: string;
  channels: Array<{ label: string; buffered: number; state: string }>;
}

export class PeerLink {
  pc: RTCPeerConnection;
  control: RTCDataChannel | null = null;
  data: RTCDataChannel[] = [];
  peer: VerifiedPeerLike | null = null;
  connected = false;
  lastDebug: PeerDebug = { selectedPair: '', localType: '', remoteType: '', channels: [] };

  private handshake: Handshake | null = null;
  private controlListeners = new Set<(msg: any) => void>();
  private debugTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public peerId: string,
    public info: PeerInfo,
    private sendSignal: (to: string, data: unknown) => void,
    private identity: Identity,
    private me: { name: string; deviceType: string },
    private onVerified: (link: PeerLink) => void,
    initiator: boolean,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: STUN });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(peerId, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log(`[nd] ICE state with ${peerId}:`, this.pc.iceConnectionState);
    };
    this.pc.onconnectionstatechange = () => {
      console.log(`[nd] connectionState with ${peerId}:`, this.pc.connectionState);
      this.connected = this.pc.connectionState === 'connected';
      if (this.pc.connectionState === 'failed') {
        // last resort: one retry with ICE restart for the initiator
        if (initiator) void this.restartIce();
      }
    };
    if (initiator) {
      const control = this.pc.createDataChannel('control');
      this.wireControl(control);
      void this.makeOffer();
    } else {
      this.pc.ondatachannel = (e) => this.wireChannel(e.channel);
    }
  }

  private async makeOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.debug('[nd] offer created, sending');
    this.sendSignal(this.peerId, { type: 'offer', sdp: this.pc.localDescription?.sdp });
  }

  private async restartIce(): Promise<void> {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      this.sendSignal(this.peerId, { type: 'offer', sdp: this.pc.localDescription?.sdp });
    } catch { /* dead */ }
  }

  wireChannel(ch: RTCDataChannel): void {
    if (ch.label === 'control') {
      this.wireControl(ch);
    } else {
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 1024 * 1024;
      this.data.push(ch);
    }
  }

  private wireControl(ch: RTCDataChannel): void {
    this.control = ch;
    ch.addEventListener('message', (e) => {
      const msg = parseControl(String(e.data));
      console.log(`[nd] control msg from ${this.peerId}:`, msg?.t);
      if (!msg) return;
      if (this.handshake?.handle(msg)) return;
      for (const fn of [...this.controlListeners]) fn(msg);
    });
    ch.addEventListener('open', () => {
      console.log(`[nd] control channel OPEN with ${this.peerId}`);
      this.handshake = new Handshake({ identity: this.identity, name: this.me.name, deviceType: this.me.deviceType });
      this.handshake.start((m) => {
        try { ch.send(encodeControl(m as never)); } catch { /* gone */ }
      });
      this.handshake.result
        .then((peer) => {
          console.log('[nd] handshake verified:', peer.name);
          this.peer = peer;
          this.onVerified(this);
        })
        .catch((err) => { console.error('[nd] handshake failed', err); });
      this.startDebugPoll();
    });
    ch.addEventListener('close', () => {
      console.log(`[nd] control channel CLOSED with ${this.peerId}`);
      this.connected = false;
    });
    ch.addEventListener('error', (err) => {
      console.error(`[nd] control channel ERROR with ${this.peerId}:`, err);
    });
  }

  onControl(fn: (msg: any) => void): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  /** Create the data channels for an outgoing transfer (sender side). */
  createDataChannels(count: number): RTCDataChannel[] {
    const created: RTCDataChannel[] = [];
    for (let i = 0; i < count; i++) {
      const ch = this.pc.createDataChannel(`data-${i}`);
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 1024 * 1024;
      this.data.push(ch);
      created.push(ch);
    }
    return created;
  }

  async handleSignal(data: any): Promise<void> {
    console.debug('[nd] handleSignal', data?.type);
    if (data?.type === 'offer') {
      try {
        // If we already sent an offer (glare condition), tie-break deterministically:
        // the peer with the lexicographically smaller device ID yields and accepts the remote offer.
        if (this.pc.signalingState !== 'stable') {
          const myId = this.identity.deviceId;
          const remoteId = this.peerId;
          if (myId < remoteId) {
            console.debug('[nd] offer glare: we have priority, ignoring incoming offer');
            return;
          }
          console.debug('[nd] offer glare: yielding to peer offer');
          await this.pc.setLocalDescription({ type: 'rollback' });
        }
        await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        console.debug('[nd] remote offer set');
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        console.debug('[nd] answer set');
        this.sendSignal(this.peerId, { type: 'answer', sdp: this.pc.localDescription?.sdp });
        console.debug('[nd] answer handed to signaling');
      } catch (err) {
        console.debug('[nd] answer path error', err);
      }
    } else if (data?.type === 'answer') {
      if (this.pc.signalingState === 'have-local-offer') {
        // FIX: Ensure answer SDP has valid setup attribute (active/passive, not actpass)
        const fixedSdp = this.ensureValidSetupAttribute(data.sdp);
        await this.pc.setRemoteDescription({ type: 'answer', sdp: fixedSdp });
      }
    } else if (data?.type === 'candidate' && data.candidate) {
      try {
        await this.pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
      } catch { /* stale candidate */ }
    }
  }

  /**
   * FIX: Ensure SDP answer has valid setup attribute
   * WebRTC spec requires answerer to use 'active' or 'passive', not 'actpass'
   */
  private ensureValidSetupAttribute(sdp: string): string {
    // Replace actpass with active in answer SDP
    return sdp.replace(/a=setup:actpass/g, 'a=setup:active');
  }

  /** Channels compatible with @neardrop/core. */
  controlChannel(): ChannelLike | null {
    return this.control?.readyState === 'open' ? this.control : null;
  }

  openDataChannels(): ChannelLike[] {
    return this.data.filter((c) => c.readyState === 'open');
  }

  fileSource(file: File | File): FileSource {
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
      this.lastDebug = {
        selectedPair: selected && rtt !== undefined ? `${(rtt * 1000).toFixed(1)}ms rtt` : '\u2014',
        localType: local ? `${local.candidateType}/${local.protocol ?? '?'}` : '\u2014',
        remoteType: remote ? `${remote.candidateType}/${remote.protocol ?? '?'}` : '\u2014',
        channels: [...(this.control ? [this.control] : []), ...this.data].map((c) => ({
          label: c.label,
          buffered: c.bufferedAmount,
          state: c.readyState,
        })),
      };
    } catch { /* pc closed */ }
  }

  /**
   * FIX: Ensure SDP answer has valid setup attribute
   * WebRTC spec requires answerer to use 'active' or 'passive', not 'actpass'
   */
  private ensureValidSetupAttribute(sdp: string): string {
    // Replace actpass with active in answer SDP
    return sdp.replace(/a=setup:actpass/g, 'a=setup:active');
  }

  close(): void {
    if (this.debugTimer) clearInterval(this.debugTimer);
    try { this.pc.close(); } catch { /* noop */ }
  }
}

/** Wait for channels with an optional progress callback; resolves on all open or throws on close. */
export function waitForChannels(link: PeerLink, count: number, timeoutMs = 12_000): Promise<RTCDataChannel[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for data channels'));
    }, timeoutMs);
    const check = () => {
      const open = link.data.filter((c) => c.readyState === 'open');
      if (open.length >= count) {
        cleanup();
        resolve(open.slice(0, count));
      }
    };
    const onState = () => {
      if (link.pc.connectionState === 'failed') {
        cleanup();
        reject(new Error('connection failed'));
      } else check();
    };
    const cleanup = () => {
      clearTimeout(timer);
      link.pc.removeEventListener('connectionstatechange', onState);
      for (const ch of link.data) ch.removeEventListener('open', check);
    };
    link.pc.addEventListener('connectionstatechange', onState);
    for (const ch of link.data) ch.addEventListener('open', check);
    check();
  });
}

export const DEFAULT_TRANSFER_CONFIG: Partial<TransferConfig> = {
  parallelChannels: 4,
  verifyThresholdBytes: 64 * 1024 * 1024,
};
