import type { FileMeta } from './types.js';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Binary data frames (sent on data channels)
//   [0..2)  u16 LE fileIndex
//   [2..6)  u32 LE chunkIndex (per-file sequence; chunk N = bytes [N*chunkSize, ...)
//   [6..8)  u16 LE flags     bit0 = final chunk of this file
//   [8..]   payload
// ---------------------------------------------------------------------------

export const HEADER_BYTES = 8;
export const FLAG_FINAL = 0x0001;
/** Payload is an 8-byte UTF-8 hex/binary fingerprint referencing a previously sent identical chunk (CAS dedup) */
export const FLAG_DEDUP_REF = 0x0002;

export interface Frame {
  fileIndex: number;
  chunkIndex: number;
  flags: number;
  payload: Uint8Array;
}

/**
 * Ultra-fast 64-bit FNV-1a + length + head/tail sample fingerprint (16-byte ASCII key)
 * for sub-file Content-Addressed Chunk Deduplication.
 */
export function chunkFingerprint(data: Uint8Array): Uint8Array {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  const len = data.byteLength;
  // Stride-1 for <=16KB, stride-4 for larger chunks to stay >4 GB/s in JS while hashing all regions
  const step = len <= 16384 ? 1 : 4;
  for (let i = 0; i < len; i += step) {
    const b = data[i]!;
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= b ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  // Always fold the last 32 bytes and first 32 bytes completely
  const tailStart = Math.max(0, len - 32);
  for (let i = tailStart; i < len; i++) {
    h1 ^= data[i]!;
    h1 = Math.imul(h1, 0x01000193);
  }
  const out = new Uint8Array(12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, h1 >>> 0, true);
  dv.setUint32(4, h2 >>> 0, true);
  dv.setUint32(8, len >>> 0, true);
  return out;
}

export function fingerprintKey(fp: Uint8Array): string {
  const dv = new DataView(fp.buffer, fp.byteOffset, fp.byteLength);
  return `${dv.getUint32(0, true).toString(16)}:${dv.getUint32(4, true).toString(16)}:${dv.getUint32(8, true).toString(16)}`;
}

export function encodeFrame(fileIndex: number, chunkIndex: number, flags: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, fileIndex, true);
  dv.setUint32(2, chunkIndex, true);
  dv.setUint16(6, flags, true);
  out.set(payload, HEADER_BYTES);
  return out.buffer;
}

export function decodeFrame(data: ArrayBuffer): Frame {
  if (data.byteLength < HEADER_BYTES) throw new Error('frame too short');
  const dv = new DataView(data);
  return {
    fileIndex: dv.getUint16(0, true),
    chunkIndex: dv.getUint32(2, true),
    flags: dv.getUint16(6, true),
    payload: new Uint8Array(data, HEADER_BYTES, data.byteLength - HEADER_BYTES),
  };
}

// ---------------------------------------------------------------------------
// Control channel messages (JSON strings, ordered+reliable channel)
// ---------------------------------------------------------------------------

export interface AcceptResumeEntry {
  file: number;
  /** last contiguous chunk index already committed by the receiver (-1 = none) */
  lastContiguous: number;
  /** Optional compressed chunk bitmap string for sparse out-of-order resume */
  bitmap?: string;
}

export type Control =
  | { t: 'probe'; size: number }
  | { t: 'probe-ack'; size: number }
  | { t: 'probe-ping'; ts: number }
  | { t: 'probe-pong'; ts: number }
  | { t: 'flow-control'; id: string; diskBacklogBytes: number; diskSpeedBps?: number }
  | { t: 'bitmap-sync'; id: string; file: number; bitmap: string }
  | { t: 'migrate-prepare'; atChunk: number }
  | { t: 'migrate-ack'; atChunk: number }
  | { t: 'hello'; v: number; deviceId: string; name: string; deviceType: string; alg: 'Ed25519' | 'ES256'; pub: JsonWebKey; nonce: string }
  | { t: 'confirm'; sig: string }
  | { t: 'offer-files'; id: string; files: FileMeta[]; totalBytes: number; chunkSize: number; channels: number; compressed: number[] }
  | { t: 'accept'; id: string; resume?: AcceptResumeEntry[] }
  | { t: 'reject'; id: string; reason?: string }
  | { t: 'progress'; id: string; file: number; chunk: number; bytes: number }
  | { t: 'chunk-ack'; id: string; file: number; chunk: number }
  | { t: 'nack'; id: string; file: number; chunk: number }
  | { t: 'file-hash'; id: string; file: number; hash: string }
  | { t: 'file-done'; id: string; file: number }
  | { t: 'done'; id: string }
  | { t: 'cancel'; id: string; reason?: string }
  | { t: 'error'; id: string; message: string };

export function encodeControl(msg: Control): string {
  return JSON.stringify(msg);
}

export function parseControl(text: string): Control | null {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && typeof obj.t === 'string') return obj as Control;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transfer configuration
// ---------------------------------------------------------------------------

export interface TransferConfig {
  /** payload bytes per DataChannel send() — negotiated down to 64KB/16KB for Safari */
  chunkSize: number;
  /** pause a channel when its bufferedAmount exceeds this */
  highWaterBytes: number;
  /** resume a paused channel when bufferedAmount drops below this */
  lowThresholdBytes: number;
  /** use parallel channels when any file exceeds this size */
  parallelThresholdBytes: number;
  /** content-addressed chunk dedup (costs two extra SHA-256 passes; only helps highly repetitive data) */
  dedup: boolean;
  /** max parallel ordered data channels (waterfilling scheduler, headers keep reassembly order) */
  parallelChannels: number;
  /** receiver sends chunk-ack every N contiguous chunks (resume state + keepalive) */
  ackEvery: number;
  /** receiver sends progress at most every N ms */
  progressEveryMs: number;
  /** sender computes SHA-256 for files up to this size (0 disables hashing) */
  verifyThresholdBytes: number;
  /** gzip text-like files via CompressionStream when both sides support it */
  compress: boolean;
  /** receiver aborts the transfer if out-of-order backlog exceeds this (protocol violation guard) */
  maxPendingBytes: number;
}

export const DEFAULT_CONFIG: Required<TransferConfig> = {
  chunkSize: 64 * 1024,
  highWaterBytes: 8 * 1024 * 1024,
  lowThresholdBytes: 1 * 1024 * 1024,
  parallelThresholdBytes: 256 * 1024,
  dedup: false,
  parallelChannels: 8,
  ackEvery: 64,
  progressEveryMs: 200,
  verifyThresholdBytes: 256 * 1024 * 1024,
  compress: true,
  maxPendingBytes: 32 * 1024 * 1024,
};

const COMPRESSIBLE_EXTS = new Set(['txt', 'json', 'xml', 'csv', 'md', 'js', 'ts', 'css', 'html', 'svg', 'log', 'yaml', 'yml', 'toml']);

export function isCompressible(meta: FileMeta): boolean {
  if (meta.type.startsWith('text/')) return true;
  if (meta.type === 'application/json' || meta.type === 'application/xml' || meta.type === 'application/javascript') return true;
  if (meta.type === 'image/svg+xml') return true;
  const ext = meta.name.split('.').pop()?.toLowerCase() ?? '';
  return COMPRESSIBLE_EXTS.has(ext);
}
