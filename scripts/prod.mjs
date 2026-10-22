#!/usr/bin/env node
/** Prod entry: serve apps/web/dist statically on :3000 + signaling on :3001 (single process). */
import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath, extname, join } from 'node:path';

try { execSync('pkill -f "apps/server/src/index.ts" || true', { stdio: 'ignore' }); } catch {}

const env = { ...process.env, PORT: '3001', TRUST_PROXY: '1', LOG: '1' };
const sig = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { env, stdio: 'inherit' });

const dist = resolvePath('apps/web/dist');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  let p = (req.url ?? '/').split('?')[0];
  if (p === '/') p = '/index.html';
  const file = join(dist, p);
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'public,max-age=31536000,immutable',
    });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(dist, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404).end('NearDrop web build missing — run `pnpm build` first');
    }
  }
}).listen(3000, () => console.log('[prod] web on :3000, signaling on :3001'));

const stop = () => { try { sig.kill('SIGTERM'); } catch {} process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
