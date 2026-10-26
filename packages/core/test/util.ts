import type { ChannelLike } from '../src/channel.js';
import type { ByteSink, FileSource, SinkHandle } from '../src/types.js';

export interface MockOptions {
  /** bytes the simulated link drains per tick (default: effectively unlimited) */
  bytesPerTick?: number;
  tickMs?: number;
  /** mutate the n-th binary frame (1-based) in flight, to simulate corruption */
  corruptFrame?: number;
}

class MockChannel extends EventTarget implements ChannelLike {
  readyState: ChannelLike['readyState'] = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  stats = { maxBufferedSeen: 0, frames: 0 };
  peer!: MockChannel;
  private draining = false;
  private queue: Array<string | ArrayBuffer> = [];

  constructor(readonly label: string, private opts: MockOptions) {
    super();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error(`channel ${this.label} not open`);
    let payload: string | ArrayBuffer;
    if (typeof data === 'string') payload = data;
    else if (data instanceof ArrayBuffer) payload = data.slice(0);
    else payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (typeof payload !== 'string') {
      this.stats.frames++;
      if (this.opts.corruptFrame === this.stats.frames) {
        const u = new Uint8Array(payload);
        if (u.length > 12) u[u.length - 1] ^= 0xff;
      }
      this.bufferedAmount += payload.byteLength;
      this.stats.maxBufferedSeen = Math.max(this.stats.maxBufferedSeen, this.bufferedAmount);
    }
    this.queue.push(payload);
    if (!this.draining) {
      this.draining = true;
      setTimeout(() => this.drain(), this.opts.tickMs ?? 0);
    }
  }

  private drain(): void {
    let budget = this.opts.bytesPerTick ?? Number.POSITIVE_INFINITY;
    const wasAbove = this.bufferedAmount > this.bufferedAmountLowThreshold;
    while (this.queue.length && budget > 0) {
      const item = this.queue.shift()!;
      if (typeof item !== 'string') {
        budget -= item.byteLength;
        this.bufferedAmount -= item.byteLength;
      }
      if (this.peer.readyState === 'open') this.peer.dispatchEvent(new MessageEvent('message', { data: item }));
    }
    if (wasAbove && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
    if (this.queue.length) setTimeout(() => this.drain(), this.opts.tickMs ?? 0);
    else this.draining = false;
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    if (this.peer.readyState !== 'closed') this.peer.close();
  }
}

export function mockPair(label: string, opts: MockOptions = {}): { a: MockChannel; b: MockChannel } {
  const a = new MockChannel(`${label}:a`, opts);
  const b = new MockChannel(`${label}:b`, opts);
  a.peer = b;
  b.peer = a;
  return { a, b };
}

export class MemoryFile implements FileSource {
  meta: FileSource['meta'];
  constructor(name: string, readonly bytes: Uint8Array, type = 'application/octet-stream') {
    this.meta = { name, size: bytes.length, type };
  }
  stream(start = 0): ReadableStream<Uint8Array> {
    const bytes = this.bytes;
    let pos = start;
    return new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pos >= bytes.length) return ctrl.close();
        const end = Math.min(bytes.length, pos + 256 * 1024);
        ctrl.enqueue(bytes.slice(pos, end));
        pos = end;
      },
    });
  }
}

export class MemorySink implements ByteSink {
  parts: Uint8Array[] = [];
  closed = false;
  aborted = false;
  write(chunk: Uint8Array): void { this.parts.push(chunk.slice()); }
  close(): void { this.closed = true; }
  abort(): void { this.aborted = true; }
  get bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export class CountingSink implements ByteSink {
  bytes = 0;
  write(chunk: Uint8Array): void { this.bytes += chunk.length; }
  close(): void { /* noop */ }
}

export function sinkHandle(sink: ByteSink, startBytes = 0): SinkHandle {
  return { sink, startBytes };
}

export function randomBytes(n: number, seed = 1): Uint8Array {
  // deterministic xorshift so failures are reproducible
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
