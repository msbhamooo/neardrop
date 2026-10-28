import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAccess, resetAccessCache } from '../src/access.js';

const TEAM = 'team.cloudflareaccess.com';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'aud123', OWNER_EMAIL: 'Owner@Example.com' };
const b64u = (b: ArrayBuffer | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;
const gen = async () => (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;

async function token(over: Record<string, unknown> = {}, signWith = () => keys.privateKey, alg = 'RS256') {
  const header = b64u(JSON.stringify({ alg, kid: 'k1' }));
  const payload = b64u(JSON.stringify({
    aud: ['aud123'], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'owner@example.com', ...over,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith(), new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}
const req = (t?: string) => new Request('https://x/admin', { headers: t ? { 'cf-access-jwt-assertion': t } : {} });

beforeAll(async () => { keys = await gen(); otherKeys = await gen(); });
beforeEach(async () => {
  resetAccessCache();
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [jwk] })));
});

describe('verifyAccess', () => {
  it('accepts a valid owner token (case-insensitive email)', async () => {
    expect(await verifyAccess(req(await token()), env)).toBe('owner@example.com');
  });
  it('rejects missing, malformed, or forged tokens', async () => {
    expect(await verifyAccess(req(), env)).toBeNull();
    expect(await verifyAccess(req('a.b'), env)).toBeNull();
    expect(await verifyAccess(req(await token({}, () => otherKeys.privateKey)), env)).toBeNull();
  });
  it('rejects wrong audience, issuer, email, expired, and non-RS256', async () => {
    expect(await verifyAccess(req(await token({ aud: ['nope'] })), env)).toBeNull();
    expect(await verifyAccess(req(await token({ iss: 'https://evil.example' })), env)).toBeNull();
    expect(await verifyAccess(req(await token({ email: 'eve@example.com' })), env)).toBeNull();
    expect(await verifyAccess(req(await token({ exp: Math.floor(Date.now() / 1000) - 10 })), env)).toBeNull();
    expect(await verifyAccess(req(await token({}, () => keys.privateKey, 'none')), env)).toBeNull();
  });
  it('fails closed when not configured', async () => {
    expect(await verifyAccess(req(await token()), {})).toBeNull();
    expect(await verifyAccess(req(await token()), { ...env, OWNER_EMAIL: '' })).toBeNull();
  });
});
