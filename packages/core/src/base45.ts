/**
 * Base45 per RFC 9285. Its 45-character alphabet is exactly QR code's alphanumeric
 * mode charset — the same reason the EU Digital COVID Certificate chose it. Keeping
 * the QR payload in alphanumeric mode roughly halves symbol density vs byte mode.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i]!, i);

export function encodeBase45(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const n = bytes[i]! * 256 + bytes[i + 1]!;
      const c = n % 45;
      const d = ((n / 45) | 0) % 45;
      const e = (n / 2025) | 0;
      out += ALPHABET[c]! + ALPHABET[d]! + ALPHABET[e]!;
    } else {
      const n = bytes[i]!;
      out += ALPHABET[n % 45]! + ALPHABET[(n / 45) | 0]!;
    }
  }
  return out;
}

export function decodeBase45(text: string): Uint8Array {
  // NOTE: space IS a valid alphabet character (index 36) — do not strip whitespace!
  const clean = text;
  const out = new Uint8Array(Math.ceil((clean.length * 2) / 3));
  let pos = 0;
  for (let i = 0; i < clean.length; i += 3) {
    if (i + 2 < clean.length) {
      const c = INDEX.get(clean[i]!);
      const d = INDEX.get(clean[i + 1]!);
      const e = INDEX.get(clean[i + 2]!);
      if (c === undefined || d === undefined || e === undefined) throw new Error('base45: invalid character');
      const n = e * 2025 + d * 45 + c;
      if (n > 65535) throw new Error('base45: overflow');
      out[pos++] = n >>> 8; // first byte
      out[pos++] = n & 255; // second byte
    } else if (i + 1 < clean.length) {
      const c = INDEX.get(clean[i]!);
      const d = INDEX.get(clean[i + 1]!);
      if (c === undefined || d === undefined) throw new Error('base45: invalid character');
      const n = d * 45 + c;
      if (n > 255) throw new Error('base45: overflow (single byte)');
      out[pos++] = n;
    } else {
      throw new Error('base45: dangling character');
    }
  }
  return out.subarray(0, pos);
}
