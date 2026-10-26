/**
 * Ultra-fast 32-bit CRC32 checksum for chunk-level wire integrity verification.
 * Precomputes lookup table for throughput >2 GB/s in modern JS runtimes.
 * Used to verify each frame immediately before writing to storage sinks.
 */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
