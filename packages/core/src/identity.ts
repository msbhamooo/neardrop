import { Sha256, toHex } from './sha256.js';

export type IdentityAlg = 'Ed25519' | 'ES256';

export interface Identity {
  deviceId: string;
  alg: IdentityAlg;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
}

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto unavailable');
  return c.subtle;
};

export const base64 = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    let s = text.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const signVerifyParams = (alg: IdentityAlg): AlgorithmIdentifier | EcdsaParams =>
  alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: { name: 'SHA-256' } };
const keyGenParams = (alg: IdentityAlg): AlgorithmIdentifier | EcKeyGenParams =>
  alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
const keyUsages: KeyUsage[] = ['sign', 'verify'];

/** Generate a fresh identity: Ed25519 when the platform supports it, ECDSA P-256 otherwise. */
export async function generateIdentity(): Promise<Identity> {
  for (const alg of ['Ed25519', 'ES256'] as IdentityAlg[]) {
    try {
      const params = keyGenParams(alg) as AlgorithmIdentifier;
      const pair = (await subtle().generateKey(params, true, keyUsages)) as CryptoKeyPair;
      const publicJwk = await subtle().exportKey('jwk', pair.publicKey);
      const privateJwk = await subtle().exportKey('jwk', pair.privateKey);
      const privateKey = await subtle().importKey('jwk', privateJwk, params, true, ['sign']);
      return { deviceId: deviceIdFromJwk(alg, publicJwk), alg, publicJwk, privateKey };
    } catch {
      // fall through to the next algorithm
    }
  }
  throw new Error('no supported signature algorithm (need Ed25519 or ECDSA P-256)');
}

/** Restore an identity persisted as JWKs (e.g. IndexedDB). */
export async function importIdentity(alg: IdentityAlg, publicJwk: JsonWebKey, privateJwk: JsonWebKey): Promise<Identity> {
  const params = keyGenParams(alg) as AlgorithmIdentifier;
  const privateKey = await subtle().importKey('jwk', privateJwk, params, true, ['sign']);
  return { deviceId: deviceIdFromJwk(alg, publicJwk), alg, publicJwk, privateKey };
}

/** Import a peer's public key for verification. */
export async function importPublic(alg: IdentityAlg, jwk: JsonWebKey): Promise<CryptoKey> {
  const cleanJwk: JsonWebKey = {
    ...jwk,
    key_ops: ['verify'],
    ext: true,
  };
  return subtle().importKey('jwk', cleanJwk, keyGenParams(alg) as AlgorithmIdentifier, true, ['verify']);
}

export function deviceIdFromJwk(alg: IdentityAlg, jwk: JsonWebKey): string {
  const canon = JSON.stringify({ alg, x: jwk.x ?? '', y: jwk.y ?? '', crv: jwk.crv ?? '' });
  return toHex(new Sha256().update(new TextEncoder().encode(canon)).digest()).slice(0, 16);
}

export async function signBytes(identity: Identity, bytes: Uint8Array): Promise<string> {
  const sig = await subtle().sign(signVerifyParams(identity.alg) as AlgorithmIdentifier, identity.privateKey, bytes as unknown as BufferSource);
  return base64.encode(new Uint8Array(sig));
}

export async function verifyBytes(alg: IdentityAlg, publicJwk: JsonWebKey, bytes: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    const pub = await importPublic(alg, publicJwk);
    const sig = base64.decode(sigB64);
    return await subtle().verify(signVerifyParams(alg) as AlgorithmIdentifier, pub, sig as unknown as BufferSource, bytes as unknown as BufferSource);
  } catch {
    return false;
  }
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  return base64.encode(bytes);
}

/** Verified identity of the remote peer, produced by the handshake. */
export interface VerifiedPeerLike {
  deviceId: string;
  name: string;
  deviceType: string;
  alg: IdentityAlg;
  publicJwk: JsonWebKey;
}

// ---------------------------------------------------------------------------
// Friendly device names, e.g. "Blue Otter" + 4-emoji pairing verification code
// ---------------------------------------------------------------------------

const ADJECTIVES = ['Amber', 'Azure', 'Brave', 'Breezy', 'Calm', 'Clever', 'Cosmic', 'Crimson', 'Curious', 'Dapper', 'Dawn', 'Eager', 'Ember', 'Fern', 'Flint', 'Frost', 'Gentle', 'Golden', 'Ivory', 'Jade', 'Lilac', 'Lunar', 'Mellow', 'Mint', 'Noble', 'Onyx', 'Opal', 'Peppy', 'Polar', 'Quiet', 'Rapid', 'Rose', 'Rusty', 'Silent', 'Silver', 'Sly', 'Solar', 'Sunny', 'Swift', 'Tender', 'Tidal', 'Umber', 'Velvet', 'Vivid', 'Warm', 'Wild', 'Wise', 'Zesty'];
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Heron', 'Lynx', 'Koala', 'Puffin', 'Marten', 'Ibex', 'Tapir', 'Narwhal', 'Gecko', 'Marmot', 'Plover', 'Quokka', 'Raven', 'Serval', 'Tahr', 'Urchin', 'Vole', 'Walrus', 'Yak', 'Zebra', 'Badger', 'Chamois', 'Dingo', 'Ermine', 'Finch', 'Gibbon', 'Hare', 'Jackal', 'Kakapo'];

export function randomName(): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

const EMOJI = ['🐶','🐱','🦊','🐼','🐨','🦁','🐸','🐵','🐧','🦄','🐝','🐙','🦋','🐢','🐳','🐬','🐘','🦉','🍄','🌵','🌲','🌈','🍎','🍕','🧀','🍩','🚀','🚗','⛵','🎈','🎁','💡','🔑','🔒','🔨','📱','💻','⌚','📷','🎧','🎬','🎮','🎲','🎸','⚽','🏀','🎾','🎯','⚡','🌙','⭐','☀️','❄️','🔥','💧','🍀','🌸','🌊','🎀','🏆','🎨','🧲','🔔'];

/** Short human verification code shown on both devices during first pairing. */
export function verificationEmoji(fingerprintA: string, fingerprintB: string): string[] {
  const ordered = [fingerprintA, fingerprintB].sort();
  const digest = new Sha256().update(new TextEncoder().encode(ordered.join('|'))).digest();
  return [0, 1, 2, 3].map((i) => EMOJI[digest[i]! % EMOJI.length]!);
}
