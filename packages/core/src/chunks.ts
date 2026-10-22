/** Carve a byte stream into fixed-size chunks; yields views (not copies) — consume before advancing. */
export async function* chunksOf(readable: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = readable.getReader();
  let carry = new Uint8Array(0);
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      let buf: Uint8Array;
      if (carry.length === 0) {
        buf = r.value;
      } else {
        buf = new Uint8Array(carry.length + r.value.length);
        buf.set(carry, 0);
        buf.set(r.value, carry.length);
      }
      let off = 0;
      while (buf.length - off >= size) {
        yield buf.subarray(off, off + size);
        off += size;
      }
      carry = off < buf.length ? buf.slice(off) : new Uint8Array(0);
    }
    if (carry.length > 0) yield carry;
  } finally {
    try { reader.cancel(); } catch { /* already cancelled/closed */ }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Safety net: session aborts (e.g. a channel 'close' firing after the caller
  // moved on — reconnect/resume flows) reject deferreds nobody races anymore.
  // Consume that rejection here so a host never sees an unhandled one; attached
  // consumers still observe it via their own then/race handlers.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
