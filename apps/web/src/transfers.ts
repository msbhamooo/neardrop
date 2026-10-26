/**
 * Session orchestration: peer discovery → PeerLink (WebRTC) → identity handshake
 * → transfers (core Sender/Receiver). Owns all app state as preact signals.
 *
 * TransferHost abstracts "a peer with channels", so online (signaling) sessions and
 * offline (QR) sessions share the same send/receive wiring.
 */
import { signal } from '@preact/signals';
import {
  TransferSender, TransferReceiver, negotiateChunkSize, parseControl, encodeControl,
  type ChannelLike, type FileMeta, type FileSource, type OfferMeta,
  type TransferProgress, type TransferSender as Sender, type VerifiedPeerLike,
} from '@neardrop/core';
import { PeerLink, waitForChannels, DEFAULT_TRANSFER_CONFIG } from './peer-link.js';
import { signalClient, activeRoomCode, type PeerInfo, type SignalEnvelope } from './signaling.js';
import { session, deviceType } from './identity.js';
import { isPaired, pairedDevices } from './paired.js';
import { makeSink, receiverPersistHooks, lookupPartials, received } from './sinks.js';
import { encodeGeohash } from './geohash.js';

export interface PeerView {
  info: PeerInfo;
  link: PeerLink | null;
}

export interface TransferFileView {
  name: string;
  size: number;
  done: boolean;
  verified: boolean;
}

export type TransferStatus = 'offering' | 'active' | 'done' | 'cancelled' | 'error' | 'rejected';

/** Largest payload per DataChannel message: Chrome's SCTP limit is 262144 bytes including our 8-byte header. */
const MAX_CHUNK = 240 * 1024;

export interface TransferView {
  id: string;
  peerId: string;
  peerName: string;
  direction: 'send' | 'receive';
  status: TransferStatus;
  files: TransferFileView[];
  bytes: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

export interface IncomingView {
  transferId: string;
  senderName: string;
  senderId: string;
  paired: boolean;
  files: FileMeta[];
}

/** Anything that provides channels + a verified peer identity. PeerLink conforms. */
export interface TransferHost {
  peerId: string;
  peer: VerifiedPeerLike | null;
  control: ChannelLike | null;
  data: ChannelLike[];
  /** true when the user already consented by scanning the QR code (offline session) */
  consented?: boolean;
}

export const peers = signal<Map<string, PeerView>>(new Map());
export const transfers = signal<Map<string, TransferView>>(new Map());
export const incoming = signal<IncomingView | null>(null);
export const toast = signal<{ text: string; error?: boolean } | null>(null);
export const pendingShare = signal<File[] | null>(null);

const retryInfo = new Map<string, { host: TransferHost; files: File[] }>();
const geoCache = { hash: '' as string, at: 0 };

export function humanizeError(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes('identity handshake timeout') ||
    lower.includes('handshake failed') ||
    lower.includes('handshake incomplete') ||
    lower.includes('handshake cancelled')
  ) {
    return 'Connecting took a moment. Retrying automatically…';
  }
  if (lower.includes('connection not ready')) {
    return "Couldn't connect directly to that device. Try the same Wi-Fi network, or ask the site owner to enable the relay.";
  }
  if (lower.includes('datachannel') || lower.includes('data channels never opened')) {
    return 'Connection adjusted. Reconnecting…';
  }
  if (lower.includes('ice') || lower.includes('stun')) {
    return 'Reconnecting to device…';
  }
  if (lower.includes('rejected') || lower.includes('declined')) {
    return 'Transfer was declined.';
  }
  if (lower.includes('cancelled') || lower.includes('canceled')) {
    return 'Transfer stopped.';
  }
  if (lower.includes('offline') || lower.includes('network')) {
    return 'Connection changed. Trying again…';
  }
  if (lower.includes('rate-limited')) {
    return 'Please wait a moment before trying again.';
  }
  return raw.replace(/^error:\s*/i, '').trim() || 'Something went wrong. Trying again…';
}

export function showToast(text: string, error = false): void {
  const friendly = error ? humanizeError(text) : text;
  toast.value = { text: friendly, error };
  setTimeout(() => {
    if (toast.value?.text === friendly) toast.value = null;
  }, 3200);
}

function upsert(view: Partial<TransferView> & { id: string }): void {
  const map = new Map(transfers.value);
  map.set(view.id, { ...map.get(view.id), ...view } as TransferView);
  transfers.value = map;
}

const randomId = (): string => Math.random().toString(36).slice(2, 10);

export function fileSourceOf(file: File): FileSource {
  return {
    meta: { name: file.name, size: file.size, type: file.type || 'application/octet-stream' },
    stream: (start?: number) => (start && start > 0 ? (file.slice(start) as Blob).stream() : (file as Blob).stream()),
  };
}

/** Wait until every channel in the list is open (QR sessions pre-create channels). */
export function waitAllOpen(channels: ChannelLike[], timeoutMs = 10_000): Promise<ChannelLike[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const open = channels.filter((c) => c.readyState === 'open');
      if (open.length > 0) resolve(open);
      else reject(new Error('data channels never opened'));
    }, timeoutMs);
    const check = () => {
      if (channels.every((c) => c.readyState === 'open')) {
        clearTimeout(timer);
        resolve(channels);
      }
    };
    for (const ch of channels) ch.addEventListener('open', check);
    check();
  });
}

class Session {
  private links = new Map<string, PeerLink>();
  private senders = new Map<string, Sender>();
  private receivers = new Map<string, TransferReceiver>();
  private unsubs = new Set<() => void>();

  start(): void {
    this.unsubs.add(signalClient.on((msg) => this.onSignalMessage(msg)));
    signalClient.onOpen(() => this.join());
    signalClient.start();
  }

  stop(): void {
    signalClient.stop();
    for (const off of this.unsubs) off();
    for (const link of this.links.values()) link.close();
  }

  setRoomCode(code?: string): void {
    const clean = code?.trim().toUpperCase().replace(/[\s_.,]+/g, '-').replace(/[^A-Z0-9-]/g, '').slice(0, 24);
    const next = clean && clean.length >= 3 ? clean : undefined;
    activeRoomCode.value = next;
    try {
      const url = new URL(location.href);
      if (next) url.searchParams.set('room', next);
      else url.searchParams.delete('room');
      history.replaceState(null, '', url.pathname + url.search);
    } catch { /* ignore */ }
    signalClient.send({ t: 'set-room', roomCode: next });
  }

  private async join(): Promise<void> {
    const s = session.value;
    if (!s) return;
    let geo: string | undefined;
    if (s.settings.geoEnabled) {
      if (geoCache.hash && Date.now() - geoCache.at < 5 * 60_000) {
        geo = geoCache.hash;
      } else {
        geo = await new Promise<string | undefined>((resolve) => {
          const t = setTimeout(() => resolve(undefined), 2500);
          navigator.geolocation?.getCurrentPosition(
            (pos) => {
              clearTimeout(t);
              geoCache.hash = encodeGeohash(pos.coords.latitude, pos.coords.longitude, 8);
              geoCache.at = Date.now();
              resolve(geoCache.hash);
            },
            () => {
              clearTimeout(t);
              resolve(undefined);
            },
            { enableHighAccuracy: false, timeout: 2200, maximumAge: 60_000 },
          );
        });
      }
    }
    const pairedIds = [...pairedDevices.value.keys()];
    signalClient.send({
      t: 'join',
      id: s.identity.deviceId,
      name: s.settings.name,
      deviceType,
      geo,
      roomCode: activeRoomCode.value,
      pairedIds,
      visibility: s.settings.visibility,
    });
  }

  private onSignalMessage(msg: SignalEnvelope): void {
    switch (msg.t) {
      case 'welcome': {
        if (typeof msg.roomCode === 'string' || msg.roomCode === undefined) {
          activeRoomCode.value = msg.roomCode;
        }
        const incomingList = (msg.peers as PeerInfo[] | undefined) ?? [];
        const map = new Map(peers.value);
        for (const p of incomingList) map.set(p.id, { info: p, link: this.links.get(p.id) ?? null });
        for (const id of map.keys()) if (!incomingList.some((p) => p.id === id)) map.delete(id);
        peers.value = map;
        return;
      }
      case 'peer-joined': {
        const peer = msg.peer as PeerInfo;
        const map = new Map(peers.value);
        map.set(peer.id, { info: peer, link: this.links.get(peer.id) ?? null });
        peers.value = map;
        return;
      }
      case 'peer-left': {
        const id = String(msg.id);
        this.links.get(id)?.close();
        this.links.delete(id);
        const map = new Map(peers.value);
        map.delete(id);
        peers.value = map;
        return;
      }
      case 'signal': {
        const from = String(msg.from);
        let entry = peers.value.get(from);
        if (!entry) {
          const fallbackInfo: PeerInfo = (msg as { fromPeer?: PeerInfo }).fromPeer ?? {
            id: from,
            name: 'Nearby Device',
            deviceType: 'other',
            sameNetwork: true,
            via: 'lan',
          };
          entry = { info: fallbackInfo, link: null };
          const map = new Map(peers.value);
          map.set(from, entry);
          peers.value = map;
        }
        const link = this.ensureLink(entry.info, false);
        void link.handleSignal(msg.data);
        return;
      }
      case 'error': {
        console.debug('[nd] server error:', msg.code, msg.message);
        if (msg.code === 'rate-limited') showToast('Slow down — rate limited', true);
        return;
      }
      default:
        return;
    }
  }

  private ensureLink(info: PeerInfo, initiator: boolean): PeerLink {
    const existing = this.links.get(info.id);
    if (existing && !existing.closed && !existing.handshakeFailed) {
      return existing;
    }
    existing?.close();
    const s = session.value!;
    const link = new PeerLink(
      info.id,
      info,
      (to, data) => signalClient.send({ t: 'signal', to, data }),
      s.identity,
      { name: s.settings.name, deviceType },
      (l) => void this.onVerified(l),
      initiator,
    );
    this.links.set(info.id, link);
    link.onControl((m) => this.onControlMessage(link, m));
    return link;
  }

  private async onVerified(link: PeerLink): Promise<void> {
    const map = new Map(peers.value);
    const entry = map.get(link.peerId);
    if (entry) {
      map.set(link.peerId, { ...entry, info: { ...entry.info, name: link.peer?.name ?? entry.info.name } });
      peers.value = map;
    }
  }

  /** Register an offline (QR) session so incoming offers use the same wiring. */
  registerOfflineHost(host: TransferHost): void {
    host.control?.addEventListener('message', (e) => {
      const msg = parseControl(String((e as MessageEvent).data));
      if (msg) this.onControlMessage(host, msg);
    });
  }

  private onControlMessage(host: TransferHost, msg: ReturnType<typeof parseControl>): void {
    if (!msg) return;
    if (msg.t === 'probe') {
      // answer chunk-size probes before any receiver exists (session-level)
      try { host.control?.send(encodeControl({ t: 'probe-ack', size: msg.size })); } catch { /* gone */ }
      return;
    }
    if (msg.t === 'offer-files') {
      const existing = this.receivers.get(msg.id);
      if (existing) {
        existing.handleControl(msg); // re-offer after reconnect → auto accept w/ resume
        upsert({ id: msg.id, status: 'active' });
        return;
      }
      void this.onIncomingOffer(host, msg as OfferMeta);
      return;
    }
    if ('id' in msg && typeof msg.id === 'string') {
      const rec = this.receivers.get(msg.id);
      if (rec) rec.handleControl(msg);
      const snd = this.senders.get(msg.id);
      if (snd) snd.handleControl(msg);
    }
  }

  private async onIncomingOffer(host: TransferHost, offer: OfferMeta): Promise<void> {
    const senderId = host.peer?.deviceId ?? host.peerId;
    const senderName = host.peer?.name ?? (peers.value.get(host.peerId)?.info.name ?? 'Unknown device');
    const settings = session.value?.settings;

    const receiver = new TransferReceiver({
      sinkFor: (fileIndex, meta, resume) => makeSink(offer.id, fileIndex, meta, senderId, resume),
      ...receiverPersistHooks(offer.id, senderId),
      config: { chunkSize: offer.chunkSize },
    });
    receiver.attach({ control: host.control!, data: host.data });
    this.receivers.set(offer.id, receiver);
    this.wireReceiverEvents(receiver, offer.id, senderId, senderName);

    // Initialize transfer view with the offered files
    upsert({
      id: offer.id,
      peerId: senderId,
      peerName: senderName,
      direction: 'receive',
      status: 'active',
      files: (offer.files ?? []).map((f) => ({ name: f.name, size: f.size, done: false, verified: false })),
      bytes: 0,
      totalBytes: offer.totalBytes ?? 0,
      speed: 0,
      eta: Infinity,
    });

    receiver.handleControl({ t: 'offer-files', ...offer });

    const partials = await lookupPartials(senderId);
    if (partials.size > 0) {
      const hints: Array<{ file: number; startBytes: number }> = [];
      offer.files.forEach((meta, i) => {
        const start = partials.get(`${meta.name}\u0000${meta.size}`);
        if (start && start > 0) hints.push({ file: i, startBytes: start });
      });
      if (hints.length) receiver.setResumeHint(hints);
    }

    const consented = host.consented === true;
    if (settings?.visibility === 'off' && !consented) {
      receiver.userReject('receiving is off');
      upsert({ id: offer.id, status: 'rejected' });
      return;
    }
    if (settings?.visibility === 'contacts' && !isPaired(senderId) && !consented) {
      receiver.userReject('contacts only');
      upsert({ id: offer.id, status: 'rejected' });
      return;
    }
    if (consented) {
      void receiver.userAccept(); // previously paired QR session: skip the sheet
      upsert({ id: offer.id, status: 'active' });
      return;
    }
    incoming.value = {
      transferId: offer.id,
      senderName,
      senderId,
      paired: isPaired(senderId),
      files: offer.files,
    };
  }

  private wireReceiverEvents(receiver: TransferReceiver, id: string, senderId: string, senderName: string): void {
    const base = (): TransferView => ({
      id,
      peerId: senderId,
      peerName: senderName,
      direction: 'receive',
      status: 'active' as TransferStatus,
      files: (receiver.meta?.files ?? []).map((f) => ({ name: f.name, size: f.size, done: false, verified: false })),
      bytes: 0,
      totalBytes: receiver.meta?.totalBytes ?? 0,
      speed: 0,
      eta: Infinity,
    });
    receiver.on('offer', () => upsert(base()));
    receiver.on('progress', (p: TransferProgress) => {
      upsert({ id, bytes: p.bytes, totalBytes: p.totalBytes, speed: p.speed, eta: p.eta, status: 'active' });
    });
    receiver.on('fileDone', (f) => {
      const map = new Map(transfers.value);
      const view = map.get(id);
      if (!view) return;
      map.set(id, { ...view, files: view.files.map((v, i) => (i === f.fileIndex ? { ...v, done: true, verified: f.verified } : v)) });
      transfers.value = map;
      const rec = received.get(`${id}:${f.fileIndex}`);
      if (rec) rec.verified = f.verified;
    });
    receiver.on('complete', () => {
      upsert({ id, status: 'done' });
      showToast('Received ✓');
    });
    receiver.on('cancelled', () => upsert({ id, status: 'cancelled' }));
    receiver.on('error', (e) => {
      upsert({ id, status: 'error' });
      showToast(String((e as { error: Error }).error?.message ?? 'receive error'), true);
    });
  }

  acceptIncoming(): void {
    const inc = incoming.value;
    if (!inc) return;
    incoming.value = null;
    void this.receivers.get(inc.transferId)?.userAccept();
  }

  rejectIncoming(): void {
    const inc = incoming.value;
    if (!inc) return;
    incoming.value = null;
    this.receivers.get(inc.transferId)?.userReject('declined');
    upsert({ id: inc.transferId, status: 'rejected' });
  }

  cancelTransfer(id: string): void {
    this.senders.get(id)?.cancel('cancelled by user');
    this.receivers.get(id)?.cancel('cancelled by user');
  }

  /** Any connected link (for the debug panel). */
  activeLink(): PeerLink | null {
    for (const link of this.links.values()) {
      if (link.connected) return link;
    }
    return null;
  }

  /** Active transfer sender (for TransferBrain telemetry in debug panel). */
  activeSender(): Sender | null {
    for (const sender of this.senders.values()) {
      return sender;
    }
    return null;
  }

  retryTransfer(id: string): void {
    const info = retryInfo.get(id);
    if (!info) return;
    void this.sendToHost(info.host, info.files, id);
  }

  /** User tapped an avatar → connect + send. */
  connectionKind(peerId: string): 'direct' | 'relay' | 'connecting' {
    return this.links.get(peerId)?.connectionKind() ?? 'connecting';
  }

  connectPeer(peerId: string): PeerLink | null {
    const entry = peers.value.get(peerId);
    if (!entry) return null;
    return this.ensureLink(entry.info, true);
  }

  async sendFiles(peerId: string, files: File[], reuseId?: string): Promise<void> {
    const entry = peers.value.get(peerId);
    if (!entry) return;
    const link = this.ensureLink(entry.info, true);
    await this.sendToHost(link, files, reuseId);
  }

  async sendFilesToAll(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const allPeers = [...peers.value.keys()];
    if (allPeers.length === 0) {
      showToast('No devices nearby yet — join a Room Code or wait for a peer', true);
      return;
    }
    await Promise.allSettled(allPeers.map((peerId) => this.sendFiles(peerId, files)));
  }

  /** Core send path shared by online + offline sessions. */
  async sendToHost(host: TransferHost, files: File[], reuseId?: string): Promise<void> {
    if (files.length === 0) return;
    const id = reuseId ?? `xfer-${randomId()}${randomId()}`;
    retryInfo.set(id, { host, files: [...files] });
    const totalBytes = files.reduce((n, f) => n + (Number.isFinite(f.size) ? f.size : 0), 0);
    const initialPeerName = host.peer?.name ?? (peers.value.get(host.peerId)?.info.name ?? 'peer');
    upsert({
      id,
      peerId: host.peerId,
      peerName: initialPeerName,
      direction: 'send',
      status: 'offering',
      files: files.map((f) => ({ name: f.name, size: Number.isFinite(f.size) ? f.size : 0, done: false, verified: false })),
      bytes: 0,
      totalBytes,
      speed: 0,
      eta: Infinity,
    });
    try {
      await this.waitVerified(host);
      const peerName = host.peer?.name ?? initialPeerName;
      upsert({ id, peerName });

      let channels: ChannelLike[];
      if (host instanceof PeerLink) {
        host.createDataChannels(4);
        channels = await waitForChannels(host, 1, 6000).catch(() => host.openDataChannels());
      } else {
        channels = await waitAllOpen(host.data);
      }
      const control = host.control;
      if (!control || control.readyState !== 'open' || channels.length === 0) throw new Error('connection not ready');
      const chunkSize = host instanceof PeerLink && host.usingRelayFallback
        ? 64 * 1024
        : await negotiateChunkSize(control, MAX_CHUNK);

      const sender = new TransferSender({
        id,
        files: files.map((f) => fileSourceOf(f)),
        config: { ...DEFAULT_TRANSFER_CONFIG, chunkSize },
      });
      sender.attach({ control, data: channels });
      this.senders.set(id, sender);

      const removeControlListener = host instanceof PeerLink
        ? host.onControl((m) => {
            if (m?.id === id) sender.handleControl(m);
          })
        : (() => {
            const fn = (e: Event) => {
              const m = parseControl(String((e as MessageEvent).data));
              if (m && 'id' in m && m.id === id) sender.handleControl(m);
            };
            host.control?.addEventListener('message', fn);
            return () => host.control?.removeEventListener('message', fn);
          })();

      sender.on('progress', (p: TransferProgress) => {
        upsert({ id, bytes: p.bytes, totalBytes: p.totalBytes, speed: p.speed, eta: p.eta, status: 'active' });
      });
      sender.on('fileSent', (f) => {
        const map = new Map(transfers.value);
        const view = map.get(id);
        if (!view) return;
        map.set(id, { ...view, files: view.files.map((v, i) => (i === f.fileIndex ? { ...v, done: true } : v)) });
        transfers.value = map;
      });
      sender.on('complete', () => {
        removeControlListener();
        upsert({ id, status: 'done', bytes: totalBytes });
        showToast('Sent ✓');
      });
      sender.on('cancelled', () => {
        removeControlListener();
        upsert({ id, status: 'cancelled' });
      });
      sender.on('rejected', () => {
        removeControlListener();
        upsert({ id, status: 'rejected' });
        showToast('Declined by receiver');
      });
      sender.on('error', (e) => {
        removeControlListener();
        upsert({ id, status: 'error' });
        showToast(String((e as { error: Error }).error?.message ?? 'send error'), true);
      });

      await sender.run();
    } catch (err) {
      upsert({ id, status: 'error' });
      showToast(err instanceof Error ? err.message : 'send failed', true);
    }
  }

  private waitVerified(host: TransferHost): Promise<void> {
    if (host.peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (host.peer) {
          clearInterval(timer);
          resolve();
        } else if (host instanceof PeerLink && host.closed) {
          clearInterval(timer);
          reject(new Error('connection closed'));
        } else if (Date.now() - t0 > 15_000) {
          clearInterval(timer);
          reject(new Error('identity handshake timeout'));
        }
      }, 80);
    });
  }
}

export const sessionBus = new Session();
