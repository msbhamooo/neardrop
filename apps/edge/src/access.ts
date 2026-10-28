/**
 * Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) so /admin stays closed even if the
 * Access policy is misconfigured. Fails closed when the Worker is not configured.
 */
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. "myteam.cloudflareaccess.com"
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
}

interface Jwk extends JsonWebKey { kid?: string }
let jwksCache: { at: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 10 * 60_000;

function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const decodeJson = (s: string): any => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function getKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('jwks fetch failed');
  const j = (await r.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys: j.keys };
  return j.keys;
}

export function resetAccessCache(): void { jwksCache = null; }

/** Returns the verified email, or null when the request must be rejected. */
export async function verifyAccess(request: Request, env: AccessEnv, now = Date.now()): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!team || !aud || !owner) return null;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson(parts[0]!);
    const payload = decodeJson(parts[1]!);
    if (header.alg !== 'RS256') return null;
    let keys = await getKeys(team);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await getKeys(team, true); jwk = keys.find((k) => k.kid === header.kid); }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
    if (!audOk) return null;
    if (payload.iss !== `https://${team}`) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now + 60_000) return null;
    const email = String(payload.email ?? '').toLowerCase();
    return email === owner ? email : null;
  } catch {
    return null;
  }
}
