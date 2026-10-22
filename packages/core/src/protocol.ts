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

export interface Frame {
  fileIndex: number;
  chunkIndex: number;
  flags: number;
  payload: Uint8Array;
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
}

export type Control =
  | { t: 'probe'; size: number }
  | { t: 'probe-ack'; size: number }
  | { t: 'hello'; v: number; deviceId: string; name: string; deviceType: string; alg: 'Ed25519' | 'ES256'; pub: JsonWebKey; nonce: string }
  | { t: 'confirm'; sig: string }
  | { t: 'offer-files'; id: string; files: FileMeta[]; totalBytes: number; chunkSize: number; channels: number; compressed: number[] }
  | { t: 'accept'; id: string; resume?: AcceptResumeEntry[] }
  | { t: 'reject'; id: string; reason?: string }
  | { t: 'progress'; id: string; file: number; chunk: number; bytes: number }
  | { t: 'chunk-ack'; id: string; file: number; chunk: number }
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
  /** max parallel ordered data channels (round-robin, headers keep reassembly order) */
  parallelChannels: number;
  /** receiver sends chunk-ack every N contiguous chunks (resume state + keepalive) */
  ackEvery: number;
  /** receiver sends progress at most every N ms */
  progressEveryMs: number;
  /** sender precomputes SHA-256 for files up to this size (0 disables hashing) */
  verifyThresholdBytes: number;
  /** gzip text-like files via CompressionStream when both sides support it */
  compress: boolean;
  /** receiver aborts the transfer if out-of-order backlog exceeds this (protocol violation guard) */
  maxPendingBytes: number;
}

export const DEFAULT_CONFIG: Required<TransferConfig> = {
  chunkSize: 256 * 1024,
  highWaterBytes: 8 * 1024 * 1024,
  lowThresholdBytes: 1 * 1024 * 1024,
  parallelThresholdBytes: 50 * 1024 * 1024,
  parallelChannels: 4,
  ackEvery: 64,
  progressEveryMs: 250,
  verifyThresholdBytes: 64 * 1024 * 1024,
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
