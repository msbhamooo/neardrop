import { Emitter, type EventMap } from './events.js';
import type { ChannelLike } from './channel.js';
import { nextLowEvent } from './channel.js';
import {
  type Control, type TransferConfig, type AcceptResumeEntry,
  DEFAULT_CONFIG, encodeControl, encodeFrame, encodeControl as enc, parseControl,
  FLAG_FINAL, isCompressible,
} from './protocol.js';
import { chunksOf, sleep, defer } from './chunks.js';
import { Sha256, sha256HexOfStream } from './sha256.js';
import { SpeedMeter } from './speed.js';
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
 * Sends files over a control channel + N ordered data channels.
 * Streaming: never loads a whole file into memory. Backpressure: pauses a channel when
 * bufferedAmount > highWaterBytes, resumes on `bufferedamountlow`. Parallel channels are
 * round-robined for large files; the 8-byte frame header restores order at the receiver.
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
  private metas: FileMeta[] | null = null;
  private lastProgressAt = 0;
  private rr = 0;
  private currentFileIndex = -1;

  constructor(opts: { id: string; files: FileSource[]; config?: Partial<TransferConfig> }) {
    super();
    this.id = opts.id;
    this.files = opts.files;
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
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
      case 'accept':
      case 'reject':
        this.decision.resolve(msg);
        break;
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
   * Full send cycle: offer → await accept/reject → pump chunks → await receiver `done`.
   * Re-call after a reconnect to resume (receiver reports its contiguous position).
   */
  async run(): Promise<'complete' | 'cancelled' | 'rejected'> {
    const control = this.control;
    if (!control) throw new Error('attach({control, data}) before run()');
    this.decision = defer<Control>();
    this.doneSignal = defer<void>();

    if (!this.metas) this.metas = await this.buildMetas();
    const compressed = this.compressedIndexes();
    const totalBytes = this.metas.reduce((n, m) => n + m.size, 0);
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

    const decision = await this.guard(this.decision.promise);
    if (decision.t === 'reject') {
      this.finished = true;
      this.emit('rejected', undefined);
      return 'rejected';
    }
    if (decision.t === 'cancel') return 'cancelled';

    const resume = new Map<number, number>(
      ((decision as { resume?: AcceptResumeEntry[] }).resume ?? []).map((r) => [r.file, r.lastContiguous]),
    );
    try {
      await this.pump(resume, compressed, totalBytes);
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
      if (this.cfg.verifyThresholdBytes > 0 && meta.size <= this.cfg.verifyThresholdBytes) {
        meta.hash = await sha256HexOfStream(this.files[i]!.stream(0));
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

  private async pump(resume: Map<number, number>, compressed: number[], totalBytes: number): Promise<void> {
    const open = this.data.filter((c) => c.readyState === 'open');
    if (open.length === 0) throw new Error('no open data channels');
    const useMulti = this.metas!.some((m) => m.size > this.cfg.parallelThresholdBytes);
    const channels = useMulti ? open.slice(0, this.cfg.parallelChannels) : open.slice(0, 1);
    for (const ch of channels) ch.bufferedAmountLowThreshold = this.cfg.lowThresholdBytes;

    const gen = this.chunkGenerator(resume, new Set(compressed));
    let item = await gen.next();
    while (!item.done) {
      if (this.cancelled || this.failed) return;
      const { fileIndex, chunkIndex, payload, final } = item.value;
      if (fileIndex !== this.currentFileIndex) {
        if (this.currentFileIndex >= 0) {
          const m = this.metas![this.currentFileIndex]!;
          this.emit('fileSent', { transferId: this.id, fileIndex: this.currentFileIndex, name: m.name });
        }
        this.currentFileIndex = fileIndex;
      }
      const ch = await this.acquire(channels);
      ch.send(encodeFrame(fileIndex, chunkIndex, final ? FLAG_FINAL : 0, payload));
      this.speed.add(payload.byteLength);
      this.maybeProgress(fileIndex, totalBytes);
      item = await gen.next();
    }
    if (this.currentFileIndex >= 0) {
      const m = this.metas![this.currentFileIndex]!;
      this.emit('fileSent', { transferId: this.id, fileIndex: this.currentFileIndex, name: m.name });
    }
  }

  private async acquire(channels: ChannelLike[]): Promise<ChannelLike> {
    for (;;) {
      if (this.cancelled) throw new CANCELLED();
      for (let n = 0; n < channels.length; n++) {
        const ch = channels[this.rr++ % channels.length]!;
        if (ch.readyState !== 'open') continue;
        if (ch.bufferedAmount > this.cfg.highWaterBytes) continue;
        return ch;
      }
      if (channels.every((c) => c.readyState !== 'open')) throw new Error('all data channels closed');
      await Promise.race([Promise.all(channels.map(nextLowEvent)), sleep(150)]);
    }
  }

  private async *chunkGenerator(resume: Map<number, number>, compressed: Set<number>): AsyncGenerator<ChunkItem> {
    const cs = this.cfg.chunkSize;
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i]!;
      const isCompressed = compressed.has(i);
      const lastContig = resume.get(i) ?? -1;
      const start = !isCompressed && lastContig >= 0 ? (lastContig + 1) * cs : 0;
      let chunkIndex = start / cs;
      let src = f.stream(start);
      if (isCompressed && typeof globalThis.CompressionStream === 'function') {
        src = src.pipeThrough(new globalThis.CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      }
      let pendingItem: ChunkItem | null = null;
      for await (const payload of chunksOf(src, cs)) {
        if (pendingItem) yield pendingItem;
        pendingItem = { fileIndex: i, chunkIndex: chunkIndex++, payload, final: false };
      }
      if (pendingItem) {
        yield { ...pendingItem, final: true };
      } else {
        // zero-byte file: one empty final chunk so the receiver can complete it
        yield { fileIndex: i, chunkIndex, payload: new Uint8Array(0), final: true };
      }
    }
  }

  private maybeProgress(fileIndex: number, totalBytes: number): void {
    const t = Date.now();
    if (t - this.lastProgressAt < this.cfg.progressEveryMs) return;
    this.lastProgressAt = t;
    this.emit('progress', {
      transferId: this.id,
      direction: 'send',
      fileIndex,
      fileName: this.metas![fileIndex]?.name ?? '',
      bytes: this.speed.bytesTotal,
      totalBytes,
      speed: this.speed.bytesPerSecond,
      eta: this.speed.eta(totalBytes),
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
  const ladder = [...new Set([wanted, 64 * 1024, 16 * 1024])].sort((a, b) => b - a);
  for (const size of ladder) {
    if (await probeOnce(control, size, opts.timeoutMs ?? 2500)) return size;
  }
  return 16 * 1024;
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
