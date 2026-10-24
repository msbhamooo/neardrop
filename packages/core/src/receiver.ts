import { Emitter, type EventMap } from './events.js';
import type { ChannelLike } from './channel.js';
import {
  type Control, type TransferConfig, type AcceptResumeEntry,
  DEFAULT_CONFIG, encodeControl, parseControl, decodeFrame,
  FLAG_FINAL, FLAG_DEDUP_REF, chunkFingerprint, fingerprintKey,
} from './protocol.js';
import { defer } from './chunks.js';
import { Sha256, toHex } from './sha256.js';
import { SpeedMeter } from './speed.js';
import type { FileMeta, FileResult, SinkHandle, TransferProgress } from './types.js';

export interface OfferMeta {
  id: string;
  files: FileMeta[];
  totalBytes: number;
  chunkSize: number;
  channels: number;
  compressed: number[];
}

export interface ReceiverEvents extends EventMap {
  offer: { meta: OfferMeta };
  progress: TransferProgress;
  fileDone: FileResult;
  complete: { transferId: string; bytes: number };
  cancelled: { reason?: string };
  error: { error: Error };
}

export type SinkFactory = (
  fileIndex: number,
  meta: FileMeta,
  resume: { startBytes: number } | null,
) => Promise<SinkHandle | null>;

interface Assembler {
  meta: FileMeta;
  compressed: boolean;
  sink: import('./types.js').ByteSink;
  hasher: Sha256 | null;
  /** next expected chunk index */
  expected: number;
  pending: Map<number, { payload: Uint8Array; flags: number }>;
  pendingBytes: number;
  rawBytes: number;
  wireBytes: number;
  startBytes: number;
  done: boolean;
  ackCounter: number;
  /** abort for decompression wrapper */
  onRaw?: (n: number) => void;
}

/**
 * HyperStream TransferReceiver:
 * - Resolves 32-byte SHA-256 `FLAG_DEDUP_REF` frames against a Content-Addressed Chunk Cache
 * - Reassembles out-of-order multi-channel frames with bounded backlog
 * - Verifies end-to-end SHA-256 integrity
 */
export class TransferReceiver extends Emitter<ReceiverEvents> {
  meta: OfferMeta | null = null;
  private cfg: Required<TransferConfig>;
  private control: ChannelLike | null = null;
  private data: ChannelLike[] = [];
  private handlerLists = new Map<ChannelLike, Array<[string, EventListener]>>();

  private assemblers: Array<Assembler | null> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private speed = new SpeedMeter();
  private finished = false;
  private failed = false;
  private userConsented = false;
  private filesDone = 0;
  private lastProgressAt = 0;
  private sinkFor: SinkFactory;
  private onPersist?: (fileIndex: number, wireBytesContiguous: number) => void;
  private onForget?: (fileIndex: number) => void;
  private abort = defer<never>();
  /** app-provided persisted partial positions (IndexedDB cache) for crash resume */
  private resumeHint = new Map<number, number>();
  /** Content-Addressed Chunk Cache: FNV-1a key → (SHA-256 hex → payload) */
  private casFpSet = new Set<string>();
  private casBySha = new Map<string, Uint8Array>();

  readonly stats = { maxPendingBytes: 0, maxPendingEntries: 0, dedupHits: 0 };

  constructor(opts: {
    control?: ChannelLike;
    data?: ChannelLike[];
    sinkFor: SinkFactory;
    onPersist?: (fileIndex: number, wireBytesContiguous: number) => void;
    onForget?: (fileIndex: number) => void;
    config?: Partial<TransferConfig>;
  }) {
    super();
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
    this.sinkFor = opts.sinkFor;
    this.onPersist = opts.onPersist;
    this.onForget = opts.onForget;
    if (opts.control && opts.data) this.attach({ control: opts.control, data: opts.data });
  }

  attach({ control, data }: { control: ChannelLike; data: ChannelLike[] }): void {
    this.detach();
    this.control = control;
    this.data = data;
    this.failed = false;
    this.abort = defer<never>();
    this.addHandler(control, 'message', (e: Event) => {
      const msg = parseControl((e as MessageEvent).data as string);
      if (msg) this.handleControl(msg);
    });
    this.addHandler(control, 'close', () => this.failIfActive(new Error('control channel closed')));
    for (const ch of data) {
      this.addHandler(ch, 'message', (e: Event) => {
        const buf = (e as MessageEvent).data as ArrayBuffer;
        // serialize: sink writes are async and must stay ordered
        this.queue = this.queue.then(() => this.processFrame(buf)).catch((err) => {
          this.failIfActive(err instanceof Error ? err : new Error(String(err)));
        });
      });
      this.addHandler(ch, 'close', () => {
        if (this.data.length > 0 && this.data.every((c) => c.readyState !== 'open')) {
          this.failIfActive(new Error('all data channels closed'));
        }
      });
    }
  }

  private addHandler(ch: ChannelLike, type: string, fn: EventListener): void {
    ch.addEventListener(type, fn);
    let list = this.handlerLists.get(ch);
    if (!list) { list = []; this.handlerLists.set(ch, list); }
    list.push([type, fn]);
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
    if (this.finished || this.failed) return;
    this.failed = true;
    void this.abortSinks();
    this.abort.reject(err);
    this.emit('error', { error: err });
  }

  private async abortSinks(): Promise<void> {
    for (const a of this.assemblers) {
      if (a && !a.done) { try { await a.sink.abort?.('transfer aborted'); } catch { /* best effort */ } }
    }
  }

  get bytesReceived(): number { return this.speed.bytesTotal; }

  handleControl(msg: Control): void {
    switch (msg.t) {
      case 'probe':
        // echo receipt of a `size`-byte control message back (chunk size negotiation)
        try { this.control?.send(encodeControl({ t: 'probe-ack', size: msg.size })); } catch { /* gone */ }
        return;
      case 'offer-files': {
        const meta: OfferMeta = {
          id: msg.id, files: msg.files, totalBytes: msg.totalBytes,
          chunkSize: msg.chunkSize, channels: msg.channels, compressed: msg.compressed,
        };
        if (this.meta && this.meta.id === meta.id) {
          // re-offer after reconnect: compressed files restart from 0 — drop their assemblers
          for (const i of this.meta.compressed) {
            const a = this.assemblers[i];
            if (a && !a.done) { try { void a.sink.abort?.('restart'); } catch { /* noop */ } }
            this.assemblers[i] = null;
          }
          this.meta = meta;
          this.userAccept(); // consent already given; resume what persisted
          return;
        }
        this.meta = meta;
        this.assemblers = new Array(meta.files.length).fill(null);
        this.emit('offer', { meta });
        return;
      }
      case 'file-hash': {
        if (this.meta && this.meta.files[msg.file]) {
          this.meta.files[msg.file]!.hash = msg.hash;
        }
        return;
      }
      case 'cancel':
        this.finished = true;
        void this.abortSinks();
        this.emit('cancelled', { reason: msg.reason });
        return;
      case 'error':
        this.failIfActive(new Error(msg.message));
        return;
      default:
        return;
    }
  }

  /**
   * Supply persisted partial positions (bytes at chunk boundaries) BEFORE userAccept()
   * so a fresh receiver after an app restart can tell the sender where to resume.
   * Only meaningful for uncompressed files; sink factory must honor the requested start.
   */
  setResumeHint(entries: Array<{ file: number; startBytes: number }>): void {
    this.resumeHint = new Map(entries.map((e) => [e.file, e.startBytes]));
  }

  /** Call after the user accepted the incoming sheet (or when policy auto-accepts). */
  async userAccept(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    this.userConsented = true;
    const resume: AcceptResumeEntry[] = [];
    for (let i = 0; i < this.assemblers.length; i++) {
      const a = this.assemblers[i];
      if (a && !a.done && !a.compressed && a.expected > 0) {
        resume.push({ file: i, lastContiguous: a.expected - 1 });
      } else if (!a && !this.meta!.compressed.includes(i)) {
        const hintBytes = this.resumeHint.get(i) ?? 0;
        if (hintBytes > 0) resume.push({ file: i, lastContiguous: hintBytes / meta.chunkSize - 1 });
      }
    }
    try {
      this.control?.send(encodeControl({ t: 'accept', id: meta.id, resume }));
    } catch (err) {
      this.failIfActive(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Reject an incoming offer (user declined or policy). */
  userReject(reason?: string): void {
    if (!this.meta) return;
    try { this.control?.send(encodeControl({ t: 'reject', id: this.meta.id, reason })); } catch { /* gone */ }
    this.finished = true;
  }

  /** Cancel an in-flight receive (local user action). */
  cancel(reason?: string): void {
    if (!this.meta || this.finished) return;
    try { this.control?.send(encodeControl({ t: 'cancel', id: this.meta.id, reason })); } catch { /* gone */ }
    this.finished = true;
    void this.abortSinks();
    this.emit('cancelled', { reason });
  }

  private resolvePayload(a: Assembler, rawPayload: Uint8Array, flags: number): Uint8Array {
    if (flags & FLAG_DEDUP_REF) {
      const shaHex = toHex(rawPayload);
      const cached = this.casBySha.get(shaHex);
      if (!cached) throw new Error(`missing CAS chunk reference ${shaHex.slice(0, 12)}`);
      this.stats.dedupHits++;
      return cached;
    }
    if (!a.compressed && rawPayload.byteLength >= 16384) {
      const fpKey = fingerprintKey(chunkFingerprint(rawPayload));
      const shaHex = toHex(new Sha256().update(rawPayload).digest());
      if (!this.casBySha.has(shaHex)) {
        const copy = new Uint8Array(rawPayload.byteLength);
        copy.set(rawPayload);
        this.casFpSet.add(fpKey);
        this.casBySha.set(shaHex, copy);
        if (this.casBySha.size > 256) {
          const oldest = this.casBySha.keys().next().value;
          if (oldest !== undefined) this.casBySha.delete(oldest);
        }
      }
    }
    return rawPayload;
  }

  private async processFrame(buffer: ArrayBuffer): Promise<void> {
    if (this.finished || this.failed || !this.meta) return;
    const { fileIndex, chunkIndex, flags, payload: rawPayload } = decodeFrame(buffer);
    if (fileIndex >= this.meta.files.length) return;
    let a = this.assemblers[fileIndex];
    if (!a) a = await this.startFile(fileIndex);
    if (!a || a.done) return;

    const payload = this.resolvePayload(a, rawPayload, flags);

    if (chunkIndex < a.expected) return; // duplicate (resume overlap)
    if (chunkIndex === a.expected) {
      await this.writeChunk(a, fileIndex, payload, flags);
      while (a.pending.has(a.expected)) {
        const p = a.pending.get(a.expected)!;
        a.pending.delete(a.expected);
        a.pendingBytes -= p.payload.byteLength;
        await this.writeChunk(a, fileIndex, p.payload, p.flags);
        if (a.done) break;
      }
    } else {
      a.pending.set(chunkIndex, { payload, flags });
      a.pendingBytes += payload.byteLength;
      if (a.pending.size === 16) {
        this.trySend({ t: 'nack', id: this.meta.id, file: fileIndex, chunk: a.expected });
      }
      if (a.pendingBytes > this.cfg.maxPendingBytes) {
        throw new Error(`out-of-order backlog exceeded ${this.cfg.maxPendingBytes} bytes — protocol violation`);
      }
    }
    this.stats.maxPendingBytes = Math.max(this.stats.maxPendingBytes, a.pendingBytes);
    this.stats.maxPendingEntries = Math.max(this.stats.maxPendingEntries, a.pending.size);
  }

  private async startFile(fileIndex: number): Promise<Assembler | null> {
    const meta = this.meta!.files[fileIndex]!;
    const compressed = this.meta!.compressed.includes(fileIndex);
    const hintBytes = this.resumeHint.get(fileIndex) ?? 0;
    const resumeReq = !compressed && hintBytes > 0 ? { startBytes: hintBytes } : null;
    const handle = await this.sinkFor(fileIndex, meta, resumeReq);
    if (!handle) {
      this.failIfActive(new Error(`cannot create sink for ${meta.name}`));
      return null;
    }
    const expectedStart = Math.floor(handle.startBytes / this.meta!.chunkSize);
    const a: Assembler = {
      meta,
      compressed,
      sink: handle.sink,
      hasher: meta.hash ? new Sha256() : null,
      expected: handle.startBytes > 0 ? expectedStart : 0,
      pending: new Map(),
      pendingBytes: 0,
      rawBytes: handle.startBytes,
      wireBytes: handle.startBytes,
      startBytes: handle.startBytes,
      done: false,
      ackCounter: 0,
    };
    if (compressed) a.sink = decompressingSink(handle.sink, a);
    this.assemblers[fileIndex] = a;
    return a;
  }

  private async writeChunk(a: Assembler, fileIndex: number, payload: Uint8Array, flags: number): Promise<void> {
    a.wireBytes += payload.byteLength;
    if (!a.compressed) a.hasher?.update(payload);
    await a.sink.write(payload);
    a.expected++;
    this.speed.add(payload.byteLength);

    a.ackCounter += payload.byteLength;
    if (!a.compressed && a.ackCounter >= this.cfg.ackEvery * this.meta!.chunkSize) {
      a.ackCounter = 0;
      this.trySend({ t: 'chunk-ack', id: this.meta!.id, file: fileIndex, chunk: a.expected - 1 });
      this.onPersist?.(fileIndex, a.expected * this.meta!.chunkSize);
    }
    this.maybeProgress(fileIndex);

    if (flags & FLAG_FINAL) {
      await this.finishFile(a, fileIndex);
    }
  }

  private async finishFile(a: Assembler, fileIndex: number): Promise<void> {
    a.done = true;
    await a.sink.close();
    let verified = false;
    if (a.hasher && a.meta.hash) {
      const got = a.hasher.digestHex();
      verified = got === a.meta.hash;
      if (!verified) {
        this.trySend({ t: 'error', id: this.meta!.id, message: `SHA-256 mismatch for ${a.meta.name}` });
        this.failIfActive(new Error(`SHA-256 mismatch for ${a.meta.name}`));
        return;
      }
    }
    this.onForget?.(fileIndex);
    this.filesDone++;
    this.emit('fileDone', {
      transferId: this.meta!.id,
      fileIndex,
      name: a.meta.name,
      size: a.rawBytes,
      verified,
    });
    this.trySend({ t: 'file-done', id: this.meta!.id, file: fileIndex });
    if (this.filesDone >= this.meta!.files.length) {
      this.trySend({ t: 'done', id: this.meta!.id });
      this.finished = true;
      this.emit('complete', { transferId: this.meta!.id, bytes: this.speed.bytesTotal });
    }
  }

  private maybeProgress(fileIndex: number): void {
    const t = Date.now();
    if (t - this.lastProgressAt < this.cfg.progressEveryMs) return;
    this.lastProgressAt = t;
    const bytes = this.assemblers.reduce((n, a) => n + (a ? a.rawBytes : 0), 0);
    if (!this.meta) return;
    this.trySend({ t: 'progress', id: this.meta.id, file: fileIndex, chunk: -1, bytes });
    this.emit('progress', {
      transferId: this.meta.id,
      direction: 'receive',
      fileIndex,
      fileName: this.meta.files[fileIndex]?.name ?? '',
      bytes,
      totalBytes: this.meta.totalBytes,
      speed: this.speed.bytesPerSecond,
      eta: this.speed.eta(this.meta.totalBytes),
    });
  }

  private trySend(msg: Control): void {
    try { this.control?.send(encodeControl(msg)); } catch { /* channel gone; failIfActive handles close */ }
  }
}

/**
 * Wraps a ByteSink with a gzip DecompressionStream and hashes the DEcompressed bytes.
 * `assembler.onRaw` receives the raw byte count for progress reporting.
 */
function decompressingSink(inner: import('./types.js').ByteSink, a: Assembler): import('./types.js').ByteSink {
  const ds = new globalThis.DecompressionStream('gzip');
  const writer = ds.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array<ArrayBufferLike>>;
  const reader = ds.readable.getReader() as ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>;
  const drained = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      a.hasher?.update(r.value);
      a.rawBytes += r.value.byteLength;
      await inner.write(r.value);
    }
  })();
  return {
    write: (chunk) => writer.write(chunk),
    close: async () => {
      await writer.close();
      await drained;
      await inner.close();
    },
    abort: async (reason) => {
      try { await writer.abort(reason); } catch { /* noop */ }
      try { await reader.cancel(reason); } catch { /* noop */ }
      try { await inner.abort?.(reason); } catch { /* noop */ }
      void drained.catch(() => {});
    },
  };
}
