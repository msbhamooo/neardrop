import { Emitter, type EventMap } from './events.js';
import type { ChannelLike } from './channel.js';
import { nextLowEvent } from './channel.js';
import {
  type Control, type TransferConfig, type AcceptResumeEntry,
  DEFAULT_CONFIG, encodeControl, encodeFrame, encodeControl as enc, parseControl,
  FLAG_FINAL, FLAG_DEDUP_REF, chunkFingerprint, fingerprintKey, isCompressible,
} from './protocol.js';
import { chunksOf, sleep, defer } from './chunks.js';
import { Sha256, toHex } from './sha256.js';
import { treeHashOfStream, TreeHasher, TREE_ALG } from './treehash.js';
import { SpeedMeter } from './speed.js';
import { TransferBrain } from './brain/transfer-brain.js';
import { ChunkBitmap } from './resumable.js';
import type { FileSource, FileMeta, TransferProgress } from './types.js';

export interface SenderEvents extends EventMap {
  progress: TransferProgress;
  fileSent: { transferId: string; fileIndex: number; name: string };
  complete: { transferId: string; bytes: number };
  cancelled: { reason?: string };
  rejected: void;
  error: { error: Error };
}

interface ChunkItem { fileIndex: number; chunkIndex: number; payload: Uint8Array; final: boolean }

/**
 * HyperStream TransferSender:
 * 1. Waterfilling Least-Buffered Multi-Channel Scheduler (routes around per-stream SCTP HoL blocking)
 * 2. Two-Stage FNV-1a + SHA-256 Sub-File Content-Addressed Deduplication (8,192x reduction on repeated chunks)
 * 3. Speculative Pre-Warm Buffer (warms RAM pipeline while recipient reviews Accept prompt)
 * 4. Selective NACK Ring Buffer for instant single-chunk gap recovery
 */
export class TransferSender extends Emitter<SenderEvents> {
  readonly id: string;
  private files: FileSource[];
  private cfg: Required<TransferConfig>;
  private control: ChannelLike | null = null;
  private data: ChannelLike[] = [];
  private handlerLists = new Map<ChannelLike, Array<[string, EventListener]>>();

  private decision = defer<Control>();
  private doneSignal = defer<void>();
  private abort = defer<never>();
  private failed = false;
  private cancelled = false;
  private finished = false;
  private speed = new SpeedMeter();
  /** Receiver-confirmed progress. The UI shows this, not bytes merely queued on the wire. */
  private acked = new SpeedMeter();
  private ackedBytes = 0;
  private totalBytesKnown = 0;
  private metas: FileMeta[] | null = null;
  private lastProgressAt = 0;
  private rr = 0;
  private currentFileIndex = -1;

  /** Fast FNV-1a pre-filter → set of SHA-256 hex digests already transmitted on this sender */
  private fpToSha = new Map<string, Set<string>>();
  /** Ring buffer of recent encoded frames for instant Selective NACK retransmission */
  private sentRing = new Map<string, ArrayBuffer>();
  private sentRingOrder: string[] = [];
  /** Telemetry counters */
  readonly stats = { dedupChunks: 0, dedupBytesSaved: 0, prewarmedChunks: 0 };
  public readonly brain: TransferBrain;
  private lastPingAt = 0;
  /** Inline per-file hashers; `next` is the next raw byte offset expected (-1 = gap, rehash at the end). */
  private hashers = new Map<number, { hasher: TreeHasher; next: number }>();
  private hashSent = new Set<number>();

  constructor(opts: { id: string; files: FileSource[]; config?: Partial<TransferConfig> }) {
    super();
    this.id = opts.id;
    this.files = opts.files;
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
    this.brain = new TransferBrain({ initialChunkSize: this.cfg.chunkSize });
  }

  /** Wire channels. Safe to call again after a disconnect (resume path). */
  attach({ control, data }: { control: ChannelLike; data: ChannelLike[] }): void {
    this.detach();
    this.control = control;
    this.data = data;
    this.failed = false;
    this.abort = defer<never>();
    this.addHandlers(control, [
      ['message', (e: Event) => {
        const msg = parseControl((e as MessageEvent).data as string);
        if (msg) this.handleControl(msg);
      }],
      ['close', () => this.failIfActive(new Error('control channel closed'))],
      ['error', () => this.failIfActive(new Error('control channel errored'))],
    ]);
    for (const ch of data) {
      ch.bufferedAmountLowThreshold = this.cfg.lowThresholdBytes;
      this.addHandlers(ch, [
        ['close', () => {
          if (this.data.length > 0 && this.data.every((c) => c.readyState !== 'open')) {
            this.failIfActive(new Error('all data channels closed'));
          }
        }],
        ['error', () => this.failIfActive(new Error('data channel errored'))],
      ]);
    }
  }

  private addHandlers(ch: ChannelLike, pairs: Array<[string, EventListener]>): void {
    let list = this.handlerLists.get(ch);
    if (!list) { list = []; this.handlerLists.set(ch, list); }
    for (const [type, fn] of pairs) { ch.addEventListener(type, fn); list.push([type, fn]); }
  }

  detach(): void {
    for (const [ch, list] of this.handlerLists) {
      for (const [type, fn] of list) ch.removeEventListener(type, fn);
    }
    this.handlerLists.clear();
    this.control = null;
    this.data = [];
  }

  private failIfActive(err: Error): void {
    if (this.finished || this.cancelled || this.failed) return;
    this.failed = true;
    this.abort.reject(err);
    this.emit('error', { error: err });
  }

  private guard<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.abort.promise]);
  }

  get bytesSent(): number { return this.speed.bytesTotal; }
  get isCancelled(): boolean { return this.cancelled; }

  handleControl(msg: Control): void {
    switch (msg.t) {
      case 'probe-ping':
        try { this.control?.send(encodeControl({ t: 'probe-pong', ts: msg.ts })); } catch { /* ignore */ }
        break;
      case 'probe-pong': {
        const rtt = Math.max(1, performance.now() - msg.ts);
        this.brain.onFeedback({ rttMs: rtt, elapsedSec: rtt / 1000 });
        break;
      }
      case 'flow-control':
        this.brain.onFeedback({
          diskBacklogBytes: msg.diskBacklogBytes,
          diskSpeedBps: msg.diskSpeedBps,
        });
        break;
      case 'chunk-ack':
        this.brain.onFeedback({
          bytesAcked: this.brain.chunkSize,
          elapsedSec: 0.05,
        });
        break;
      case 'progress': {
        if (msg.bytes > this.ackedBytes) {
          this.acked.add(msg.bytes - this.ackedBytes);
          this.ackedBytes = Math.min(msg.bytes, this.totalBytesKnown || msg.bytes);
          this.emitAckedProgress(Math.max(0, msg.file));
        }
        break;
      }
      case 'accept':
      case 'reject':
        this.decision.resolve(msg);
        break;
      case 'nack': {
        this.brain.onFeedback({ nack: true });
        const frame = this.sentRing.get(`${msg.file}:${msg.chunk}`);
        if (frame) {
          const open = this.data.filter((c) => c.readyState === 'open');
          if (open.length > 0) {
            try { open[0]!.send(frame); } catch { /* ignore */ }
          }
        }
        break;
      }
      case 'done':
        this.finished = true;
        this.doneSignal.resolve();
        break;
      case 'cancel':
        this.cancelled = true;
        this.decision.resolve(msg);
        this.doneSignal.resolve();
        this.emit('cancelled', { reason: msg.reason });
        break;
      case 'error':
        this.failIfActive(new Error(msg.message));
        break;
      default:
        break;
    }
  }

  cancel(reason?: string): void {
    if (this.finished) return;
    this.cancelled = true;
    try { this.control?.send(encodeControl({ t: 'cancel', id: this.id, reason })); } catch { /* channel gone */ }
    this.decision.resolve({ t: 'cancel', id: this.id, reason });
    this.doneSignal.resolve();
    this.emit('cancelled', { reason });
  }

  /**
   * Full send cycle: offer → speculative pre-warm while awaiting accept/reject → pump chunks → await receiver `done`.
   */
  async run(): Promise<'complete' | 'cancelled' | 'rejected'> {
    const control = this.control;
    if (!control) throw new Error('attach({control, data}) before run()');
    this.decision = defer<Control>();
    this.doneSignal = defer<void>();

    if (!this.metas) this.metas = await this.buildMetas();
    const compressed = this.compressedIndexes();
    const totalBytes = this.metas.reduce((n, m) => n + m.size, 0);
    this.totalBytesKnown = totalBytes;
    const useMulti = this.metas.some((m) => m.size > this.cfg.parallelThresholdBytes);

    control.send(encodeControl({
      t: 'offer-files',
      id: this.id,
      files: this.metas,
      totalBytes,
      chunkSize: this.cfg.chunkSize,
      channels: useMulti ? Math.min(this.cfg.parallelChannels, this.data.filter((c) => c.readyState === 'open').length) : 1,
      compressed,
    }));

    // Speculative Pre-Warming: while the human recipient reads the Incoming prompt (1.5-4s),
    // pre-stage up to 16 chunks (4MB) of the first file into memory so burst transmission starts in 0ms.
    const prewarmed: ChunkItem[] = [];
    const prewarmDone = (async () => {
      try {
        const compressedSet = new Set(compressed);
        const gen = this.chunkGenerator(new Map(), new Map(), compressedSet);
        while (prewarmed.length < 16 && !this.cancelled && !this.failed) {
          const next = await gen.next();
          if (next.done) break;
          // Copy slice because chunksOf yields views
          const copy = new Uint8Array(next.value.payload.byteLength);
          copy.set(next.value.payload);
          prewarmed.push({ ...next.value, payload: copy });
          this.stats.prewarmedChunks++;
          if (next.value.final) break;
        }
      } catch { /* ignore prewarm errors */ }
    })();

    const decision = await this.guard(this.decision.promise);
    await prewarmDone.catch(() => {});
    if (decision.t === 'reject') {
      this.finished = true;
      this.emit('rejected', undefined);
      return 'rejected';
    }
    if (decision.t === 'cancel') return 'cancelled';

    const resume = new Map<number, number>(
      ((decision as { resume?: AcceptResumeEntry[] }).resume ?? []).map((r) => [r.file, r.lastContiguous]),
    );
    const resumeBitmaps = new Map<number, ChunkBitmap>();
    for (const r of (decision as { resume?: AcceptResumeEntry[] }).resume ?? []) {
      if (r.bitmap && this.metas![r.file]) {
        const totalChunks = Math.ceil(this.metas![r.file]!.size / this.cfg.chunkSize);
        resumeBitmaps.set(r.file, ChunkBitmap.decodeCompressed(totalChunks, r.bitmap));
      }
    }
    try {
      await this.pump(resume, resumeBitmaps, compressed, totalBytes, resume.size === 0 ? prewarmed : []);
    } catch (err) {
      if (this.cancelled) return 'cancelled';
      throw err;
    }
    if (this.cancelled) return 'cancelled';

    await this.guard(this.doneSignal.promise); // receiver confirms all sinks closed
    if (this.cancelled) return 'cancelled';
    this.finished = true;
    this.emit('complete', { transferId: this.id, bytes: this.speed.bytesTotal });
    return 'complete';
  }

  private async buildMetas(): Promise<FileMeta[]> {
    const metas: FileMeta[] = [];
    for (let i = 0; i < this.files.length; i++) {
      const meta = { ...this.files[i]!.meta };
      // Announce the algorithm only; the hash itself is computed while the bytes stream out and sent
      // as `file-hash` before the final chunk, so the offer reaches the receiver without a pre-read.
      if (this.cfg.verifyThresholdBytes > 0 && meta.size <= this.cfg.verifyThresholdBytes) {
        meta.hashAlg = TREE_ALG;
      }
      metas.push(meta);
    }
    return metas;
  }

  private compressedIndexes(): number[] {
    if (!this.cfg.compress || typeof globalThis.CompressionStream !== 'function') return [];
    return this.metas!
      .map((m, i) => (isCompressible(m) ? i : -1))
      .filter((i) => i >= 0);
  }

  private recordSentFrame(fileIndex: number, chunkIndex: number, frame: ArrayBuffer): void {
    const key = `${fileIndex}:${chunkIndex}`;
    this.sentRing.set(key, frame);
    this.sentRingOrder.push(key);
    if (this.sentRingOrder.length > 64) {
      const oldest = this.sentRingOrder.shift()!;
      this.sentRing.delete(oldest);
    }
  }

  private async pump(
    resume: Map<number, number>,
    resumeBitmaps: Map<number, ChunkBitmap>,
    compressed: number[],
    totalBytes: number,
    prewarmed: ChunkItem[] = [],
  ): Promise<void> {
    const open = this.data.filter((c) => c.readyState === 'open');
    if (open.length === 0) throw new Error('no open data channels');
    const useMulti = this.metas!.some((m) => m.size > this.cfg.parallelThresholdBytes);
    const channels = useMulti ? open.slice(0, this.cfg.parallelChannels) : open.slice(0, 1);
    const dynLow = this.brain.lowThresholdBytes;
    for (const ch of channels) ch.bufferedAmountLowThreshold = dynLow;

    const compressedSet = new Set(compressed);
    const effectiveResume = new Map(resume);
    // If we have pre-warmed uncompressed chunks for file 0, adjust effectiveResume so chunkGenerator continues right after them
    const usePrewarm = prewarmed.length > 0 && !compressedSet.has(0) && !effectiveResume.has(0);
    if (usePrewarm) {
      const lastPrewarmed = prewarmed[prewarmed.length - 1]!;
      effectiveResume.set(0, lastPrewarmed.chunkIndex);
    }

    const sendChunkItem = async (val: ChunkItem) => {
      // Pacing delay during DRAIN phase to relieve receiver storage bottleneck
      if (this.brain.currentPhase === 'DRAIN') {
        await sleep(15);
      }

      // Periodic latency probe ping
      const now = Date.now();
      if (now - this.lastPingAt > 2000) {
        this.lastPingAt = now;
        try { this.control?.send(encodeControl({ t: 'probe-ping', ts: performance.now() })); } catch { /* ignore */ }
      }
      const { fileIndex, chunkIndex, payload, final } = val;
      if (fileIndex !== this.currentFileIndex) {
        if (this.currentFileIndex >= 0) {
          const m = this.metas![this.currentFileIndex]!;
          this.emit('fileSent', { transferId: this.id, fileIndex: this.currentFileIndex, name: m.name });
        }
        this.currentFileIndex = fileIndex;
      }
      const ch = await this.acquire(channels);
      let flags = final ? FLAG_FINAL : 0;
      let wirePayload = payload;

      // Two-stage FNV-1a + SHA-256 Sub-File Content-Addressed Deduplication for uncompressed chunks >= 16KB
      if (this.cfg.dedup && !compressedSet.has(fileIndex) && payload.byteLength >= 16384) {
        const fpKey = fingerprintKey(chunkFingerprint(payload));
        let shaSet = this.fpToSha.get(fpKey);
        if (shaSet) {
          const digestBytes = new Sha256().update(payload).digest();
          const shaHex = toHex(digestBytes);
          if (shaSet.has(shaHex)) {
            flags |= FLAG_DEDUP_REF;
            wirePayload = digestBytes;
            this.stats.dedupChunks++;
            this.stats.dedupBytesSaved += payload.byteLength - digestBytes.byteLength;
          } else {
            shaSet.add(shaHex);
          }
        } else {
          const digestBytes = new Sha256().update(payload).digest();
          shaSet = new Set([toHex(digestBytes)]);
          this.fpToSha.set(fpKey, shaSet);
          if (this.fpToSha.size > 256) {
            const firstKey = this.fpToSha.keys().next().value;
            if (firstKey !== undefined) this.fpToSha.delete(firstKey);
          }
        }
      }

      const frame = encodeFrame(fileIndex, chunkIndex, flags, wirePayload);
      this.recordSentFrame(fileIndex, chunkIndex, frame);
      ch.send(frame);
      this.speed.add(payload.byteLength);
      this.maybeProgress(fileIndex, totalBytes);
    };

    if (usePrewarm) {
      for (const item of prewarmed) {
        if (this.cancelled || this.failed) return;
        await sendChunkItem(item);
      }
    }

    const gen = this.chunkGenerator(effectiveResume, resumeBitmaps, compressedSet, usePrewarm && prewarmed[prewarmed.length - 1]!.final ? 1 : 0);
    let item = await gen.next();
    while (!item.done) {
      if (this.cancelled || this.failed) return;
      await sendChunkItem(item.value);
      item = await gen.next();
    }
    if (this.currentFileIndex >= 0) {
      const m = this.metas![this.currentFileIndex]!;
      this.emit('fileSent', { transferId: this.id, fileIndex: this.currentFileIndex, name: m.name });
    }
  }

  /**
   * Waterfilling Least-Buffered Channel Scheduler:
   * Always selects the open channel with the minimum `bufferedAmount` below `highWaterBytes`,
   * routing around per-stream SCTP head-of-line blocking automatically.
   */
  private async acquire(channels: ChannelLike[]): Promise<ChannelLike> {
    const highWater = Math.max(this.cfg.highWaterBytes, this.brain.highWaterBytes);
    for (;;) {
      if (this.cancelled) throw new CANCELLED();
      let best: ChannelLike | null = null;
      let bestBuf = Infinity;
      const len = channels.length;
      const startIdx = this.rr++ % len;
      for (let n = 0; n < len; n++) {
        const ch = channels[(startIdx + n) % len]!;
        if (ch.readyState !== 'open') continue;
        if (ch.bufferedAmount > highWater) continue;
        if (ch.bufferedAmount < bestBuf) {
          best = ch;
          bestBuf = ch.bufferedAmount;
          if (bestBuf === 0) break;
        }
      }
      if (best) return best;
      if (channels.every((c) => c.readyState !== 'open')) throw new Error('all data channels closed');
      await Promise.race([Promise.all(channels.map(nextLowEvent)), sleep(150)]);
    }
  }

  private async *chunkGenerator(
    resume: Map<number, number>,
    resumeBitmaps: Map<number, ChunkBitmap>,
    compressed: Set<number>,
    startFileIndex = 0,
  ): AsyncGenerator<ChunkItem> {
    const cs = this.cfg.chunkSize;
    for (let i = startFileIndex; i < this.files.length; i++) {
      const f = this.files[i]!;
      const isCompressed = compressed.has(i);
      const fileBitmap = resumeBitmaps.get(i);
      const lastContig = resume.get(i) ?? -1;
      const start = !isCompressed && lastContig >= 0 ? (lastContig + 1) * cs : 0;
      let chunkIndex = start / cs;
      let src = f.stream(start);
      if (isCompressed && typeof globalThis.CompressionStream === 'function') {
        src = src.pipeThrough(new globalThis.CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      }
      const wantsHash = this.metas?.[i]?.hashAlg === TREE_ALG && !this.hashSent.has(i);
      let hs = wantsHash ? this.hashers.get(i) : undefined;
      if (wantsHash && (!hs || start === 0)) {
        hs = { hasher: new TreeHasher(), next: 0 };
        this.hashers.set(i, hs);
      }
      // compressed payloads are not the raw bytes the receiver hashes; gaps fall back to a full rehash
      if (hs && isCompressed) hs.next = -1;
      // hash at yield time so a generator abandoned mid-file (pre-warm) leaves `next` exactly at what went out
      const hashOut = async (item: ChunkItem) => {
        if (!hs || hs.next < 0) return;
        if (item.chunkIndex * cs !== hs.next) { hs.next = -1; return; }
        await hs.hasher.update(item.payload);
        hs.next += item.payload.byteLength;
      };
      let pendingItem: ChunkItem | null = null;
      for await (const payload of chunksOf(src, cs)) {
        const currentIdx = chunkIndex++;
        // If recipient already verified this chunk in a previous attempt, skip streaming it!
        if (fileBitmap && fileBitmap.has(currentIdx)) {
          continue;
        }
        if (pendingItem) { await hashOut(pendingItem); yield pendingItem; }
        pendingItem = { fileIndex: i, chunkIndex: currentIdx, payload, final: false };
      }
      if (pendingItem) await hashOut(pendingItem);
      if (wantsHash) await this.sendFileHash(i, hs!);
      if (pendingItem) {
        yield { ...pendingItem, final: true };
      } else {
        // zero-byte file or all chunks already received
        yield { fileIndex: i, chunkIndex, payload: new Uint8Array(0), final: true };
      }
    }
  }

  /** Sent before the file's final chunk so the receiver normally has it by the time it finishes. */
  private async sendFileHash(fileIndex: number, hs: { hasher: TreeHasher; next: number }): Promise<void> {
    if (this.hashSent.has(fileIndex)) return;
    const size = this.metas![fileIndex]!.size;
    const hash = hs.next === size
      ? await hs.hasher.digestHex()
      : await treeHashOfStream(this.files[fileIndex]!.stream(0));
    this.hashSent.add(fileIndex);
    this.hashers.delete(fileIndex);
    try { this.control?.send(encodeControl({ t: 'file-hash', id: this.id, file: fileIndex, hash })); } catch { /* gone */ }
  }

  private maybeProgress(fileIndex: number, totalBytes: number): void {
    const t = Date.now();
    if (t - this.lastProgressAt < this.cfg.progressEveryMs) return;
    this.lastProgressAt = t;
    this.totalBytesKnown = totalBytes;
    this.emitAckedProgress(fileIndex);
  }

  /** Progress as confirmed by the receiver, so both screens agree. */
  private emitAckedProgress(fileIndex: number): void {
    const total = this.totalBytesKnown;
    const remaining = Math.max(0, total - this.ackedBytes);
    const bps = this.acked.bytesPerSecond;
    this.emit('progress', {
      transferId: this.id,
      direction: 'send',
      fileIndex,
      fileName: this.metas?.[fileIndex]?.name ?? '',
      bytes: this.ackedBytes,
      totalBytes: total,
      speed: bps,
      eta: bps > 0 ? remaining / bps : Infinity,
    });
  }
}

class CANCELLED extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * Probe the SCTP max usable control message size: 256KB → 64KB → 16KB.
 * Some browsers (notably older Safari/iOS) throw or drop on oversized sends.
 * The receiving side answers automatically via TransferReceiver.handleControl.
 */
export async function negotiateChunkSize(
  control: ChannelLike,
  wanted = DEFAULT_CONFIG.chunkSize,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  if (wanted <= 64 * 1024) return wanted;
  const ladder = [...new Set([wanted, 64 * 1024, 16 * 1024])].sort((a, b) => b - a);
  for (const size of ladder) {
    if (size <= 64 * 1024) return size;
    if (await probeOnce(control, size, opts.timeoutMs ?? 600)) return size;
  }
  return 64 * 1024;
}

function probeOnce(control: ChannelLike, size: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      control.removeEventListener('message', onMsg as EventListener);
      clearTimeout(timer);
      resolve(ok);
    };
    const onMsg = (e: Event) => {
      const msg = parseControl((e as MessageEvent).data as string);
      if (msg && msg.t === 'probe-ack' && msg.size === size) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    control.addEventListener('message', onMsg as EventListener);
    try {
      const base = enc({ t: 'probe', size });
      const pad = Math.max(0, size - base.length - 14); // room for "pad":"xxxx"
      control.send(pad > 0 ? enc({ t: 'probe', size, pad: 'x'.repeat(pad) } as Control) : base);
    } catch {
      finish(false);
    }
  });
}
