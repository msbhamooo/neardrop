/**
 * Block-tree file hash: SHA-256 over the concatenated SHA-256 digests of consecutive 1 MiB blocks.
 *
 * Why not one running SHA-256 over the file: browsers have no incremental native SHA-256, so a
 * streaming hash has to be pure JS (~70 MB/s), which capped whole transfers near 7 MB/s. Hashing
 * fixed blocks lets us use the native `crypto.subtle.digest` (~450 MB/s) per block, while sender and
 * receiver still agree on one value regardless of the transfer chunk size.
 * Without WebCrypto (insecure http contexts) it falls back to the pure-JS implementation: same
 * result, slower.
 */
import { sha256, toHex } from './sha256.js';

export const TREE_BLOCK = 1 << 20;
export const TREE_ALG = 'tree-1m';

async function digestBlock(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    // copy into a fresh ArrayBuffer-backed view: digest() rejects SharedArrayBuffer-backed input
    const view = bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();
    return new Uint8Array(await subtle.digest('SHA-256', view as BufferSource));
  }
  return sha256(bytes);
}

export class TreeHasher {
  private block = new Uint8Array(TREE_BLOCK);
  private len = 0;
  private digests: Uint8Array[] = [];

  async update(data: Uint8Array): Promise<void> {
    let off = 0;
    while (off < data.length) {
      const take = Math.min(TREE_BLOCK - this.len, data.length - off);
      this.block.set(data.subarray(off, off + take), this.len);
      this.len += take;
      off += take;
      if (this.len === TREE_BLOCK) {
        this.digests.push(await digestBlock(this.block));
        this.len = 0;
      }
    }
  }

  async digestHex(): Promise<string> {
    if (this.len > 0 || this.digests.length === 0) {
      this.digests.push(await digestBlock(this.block.subarray(0, this.len)));
      this.len = 0;
    }
    const all = new Uint8Array(this.digests.length * 32);
    this.digests.forEach((d, i) => all.set(d, i * 32));
    return toHex(await digestBlock(all));
  }
}

export async function treeHashOfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hasher = new TreeHasher();
  const reader = stream.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      await hasher.update(r.value);
    }
  } finally {
    try { reader.cancel(); } catch { /* noop */ }
  }
  return hasher.digestHex();
}
