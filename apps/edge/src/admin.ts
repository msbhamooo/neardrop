/** /admin (HTML) and /admin/api/stats (JSON). Every request must carry a valid Cloudflare Access JWT for the owner. */
import { verifyAccess, type AccessEnv } from './access.js';
import { ADMIN_HTML } from './admin-page.js';
import { loadStats, parseRange } from './queries.js';

export interface AdminEnv extends AccessEnv { DB: D1Database }

const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

export async function handleAdmin(request: Request, env: AdminEnv): Promise<Response> {
  if (await verifyAccess(request, env) === null) return new Response('Forbidden', { status: 403, headers: HEADERS });
  const url = new URL(request.url);
  if (url.pathname === '/admin/api/stats') {
    const stats = await loadStats(env.DB, parseRange(url.searchParams.get('range')));
    return new Response(JSON.stringify(stats), { headers: { ...HEADERS, 'content-type': 'application/json' } });
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    return new Response(ADMIN_HTML, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
  }
  return new Response('Not found', { status: 404, headers: HEADERS });
}
