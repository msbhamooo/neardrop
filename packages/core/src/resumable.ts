/**
 * Resumable Transfer Protocol Engine
 *
 * Implements:
 * 1. Sparse Range ChunkBitmap: Tracks verified chunks across out-of-order multi-channel streams.
 * 2. Stable Transfer Identity: Cryptographically deterministic transfer IDs derived from file metadata.
 * 3. Range-Encoded Checkpoints: Enables 10GB–100GB+ transfers to survive disconnections, tab reloads,
 *    transport migrations, and device sleeping by resuming ONLY missing chunks.
 */

import { Sha256, toHex } from './sha256.js';
import type { FileMeta } from './types.js';

export type Range = [start: number, end: number]; // inclusive [start, end]

export class ChunkBitmap {
  private words: Uint32Array;
  private totalBits: number;
  private verifiedCount = 0;

  constructor(totalChunks: number) {
    this.totalBits = Math.max(1, totalChunks);
    this.words = new Uint32Array(Math.ceil(this.totalBits / 32));
  }

  get totalChunks(): number {
    return this.totalBits;
  }

  get verified(): number {
    return this.verifiedCount;
  }

  get percent(): number {
    return this.totalBits > 0 ? (this.verifiedCount / this.totalBits) * 100 : 0;
  }

  isComplete(): boolean {
    return this.verifiedCount >= this.totalBits;
  }

  has(index: number): boolean {
    if (index < 0 || index >= this.totalBits) return false;
    const word = this.words[index >>> 5]!;
    return (word & (1 << (index & 31))) !== 0;
  }

  set(index: number): boolean {
    if (index < 0 || index >= this.totalBits) return false;
    const wordIdx = index >>> 5;
    const bit = 1 << (index & 31);
    const prev = this.words[wordIdx]!;
    if ((prev & bit) === 0) {
      this.words[wordIdx] = prev | bit;
      this.verifiedCount++;
      return true;
    }
    return false;
  }

  clear(index: number): boolean {
    if (index < 0 || index >= this.totalBits) return false;
    const wordIdx = index >>> 5;
    const bit = 1 << (index & 31);
    const prev = this.words[wordIdx]!;
    if ((prev & bit) !== 0) {
      this.words[wordIdx] = prev & ~bit;
      this.verifiedCount--;
      return true;
    }
    return false;
  }

  /** Find next unverified chunk index >= fromIndex. Returns -1 if all are complete. */
  nextMissing(fromIndex = 0): number {
    if (fromIndex >= this.totalBits) return -1;
    let idx = Math.max(0, fromIndex);
    let wordIdx = idx >>> 5;
    const totalWords = this.words.length;

    // Fast-skip fully populated 32-bit words (0xFFFFFFFF)
    const bitInFirstWord = idx & 31;
    if (bitInFirstWord === 0) {
      while (wordIdx < totalWords && this.words[wordIdx] === 0xffffffff) {
        wordIdx++;
      }
      idx = wordIdx << 5;
    }

    for (let i = idx; i < this.totalBits; i++) {
      if (!this.has(i)) return i;
    }
    return -1;
  }

  /** Returns contiguous verified prefix length [0..N) */
  contiguousVerifiedPrefix(): number {
    let count = 0;
    while (count < this.totalBits && this.has(count)) {
      count++;
    }
    return count;
  }

  /** Compress verified bits into compact closed intervals: [[0, 50], [52, 90]] */
  toRanges(): Range[] {
    const ranges: Range[] = [];
    let inRange = false;
    let start = 0;

    for (let i = 0; i < this.totalBits; i++) {
      const isSet = this.has(i);
      if (isSet && !inRange) {
        inRange = true;
        start = i;
      } else if (!isSet && inRange) {
        inRange = false;
        ranges.push([start, i - 1]);
      }
    }
    if (inRange) {
      ranges.push([start, this.totalBits - 1]);
    }
    return ranges;
  }

  /** Populate bitmap from array of ranges */
  fromRanges(ranges: Range[]): void {
    for (const [start, end] of ranges) {
      const s = Math.max(0, start);
      const e = Math.min(this.totalBits - 1, end);
      for (let i = s; i <= e; i++) {
        this.set(i);
      }
    }
  }

  /**
   * Compact serialization: e.g. "0-49,52-90"
   */
  encodeCompressed(): string {
    const ranges = this.toRanges();
    return ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(',');
  }

  /**
   * Parse compact serialization string
   */
  static decodeCompressed(totalChunks: number, str: string): ChunkBitmap {
    const bitmap = new ChunkBitmap(totalChunks);
    if (!str || !str.trim()) return bitmap;
    const parts = str.split(',');
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      if (p.includes('-')) {
        const [sStr, eStr] = p.split('-');
        const s = parseInt(sStr!, 10);
        const e = parseInt(eStr!, 10);
        if (!isNaN(s) && !isNaN(e)) {
          for (let i = s; i <= e; i++) bitmap.set(i);
        }
      } else {
        const idx = parseInt(p, 10);
        if (!isNaN(idx)) bitmap.set(idx);
      }
    }
    return bitmap;
  }
}

export interface CheckpointData {
  transferId: string;
  fileIndex: number;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  verifiedChunks: number;
  totalChunks: number;
  ranges: Range[];
  updatedAt: number;
}

/**
 * Generate a cryptographically stable transfer ID from file metadata so that both
 * sender and receiver agree on identical IDs across sessions, tabs, and network reconnections.
 */
export async function buildStableTransferId(files: FileMeta[], salt = 'neardrop-v2'): Promise<string> {
  const hasher = new Sha256();
  hasher.update(new TextEncoder().encode(salt));
  for (const f of files) {
    const descriptor = `${f.name}:${f.size}:${f.type || ''}:${f.hash || ''}`;
    hasher.update(new TextEncoder().encode(descriptor));
  }
  const digest = hasher.digest();
  return toHex(digest).slice(0, 16);
}
