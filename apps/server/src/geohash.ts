/**
 * Minimal base32 geohash (precision 8 ≈ 38m × 19m cells) + neighbor cells,
 * enough for "nearby" co-presence without storing or logging precise location.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision = 8): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bits = 0;
  let bit = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        bit = (bit << 1) + 1;
        lonMin = mid;
      } else {
        bit <<= 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bit = (bit << 1) + 1;
        latMin = mid;
      } else {
        bit <<= 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[bit];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

/** Decode a geohash to its cell center + approximate cell dimensions. */
export function decodeGeohash(hash: string): { lat: number; lon: number; latErr: number; lonErr: number } {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let even = true;
  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`bad geohash char: ${ch}`);
    for (let bit = 4; bit >= 0; bit--) {
      const b = (idx >> bit) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (b) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (b) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latErr: (latMax - latMin) / 2,
    lonErr: (lonMax - lonMin) / 2,
  };
}

/** The cell itself + its 8 surrounding cells (coarse adjacency). */
export function geohashNeighborhood(hash: string): string[] {
  const { lat, lon, latErr, lonErr } = decodeGeohash(hash);
  const cells = new Set<string>([hash]);
  for (const dLat of [-1, 0, 1]) {
    for (const dLon of [-1, 0, 1]) {
      if (dLat === 0 && dLon === 0) continue;
      const la = Math.max(-89.99, Math.min(89.99, lat + dLat * latErr * 2.001));
      const lo = Math.max(-179.99, Math.min(179.99, lon + dLon * lonErr * 2.001));
      cells.add(encodeGeohash(la, lo, hash.length));
    }
  }
  return [...cells];
}

export function isValidGeohash(geo: unknown): geo is string {
  return typeof geo === 'string' && /^[0123456789bcdefghjkmnpqrstuvwxyz]{8}$/.test(geo);
}
