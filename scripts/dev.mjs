#!/usr/bin/env node
/** NearDrop dev orchestrator: starts signaling server (:3001) + Vite web app (:3000). */
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const procs = [];
let exiting = false;

function start(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  procs.push(p);
  console.log(`[dev] started ${name} (pid ${p.pid})`);
  p.on('exit', (code) => {
    if (!exiting) {
      console.log(`[dev] ${name} exited (${code}) — shutting down`);
      shutdown(code ?? 0);
    }
  });
}

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Kill stale children from a previous run (vite + signaling) so ports are free.
// Patterns deliberately do NOT match this orchestrator's own command line.
for (const pat of ['vite/bin/vite[.]js', 'apps/server/src/[i]ndex.ts']) {
  try { execSync(`pkill -f ${pat} || true`, { stdio: 'ignore' }); } catch {}
}

// Signaling server (ws) on :3001 — TRUST_PROXY so the gateway's X-Forwarded-For is honored.
start(
  'signaling',
  process.execPath,
  ['--import', 'tsx', 'apps/server/src/index.ts'],
  { env: { ...process.env, PORT: '3001', TRUST_PROXY: '1', LOG: '1', NODE_ENV: 'development' } },
);

// Web app (Vite + Preact PWA) on :3000 — the only externally visible port.
const webVite = 'apps/web/node_modules/vite/bin/vite.js';
const rootVite = 'node_modules/vite/bin/vite.js';
if (existsSync(webVite)) {
  start('web', process.execPath, ['node_modules/vite/bin/vite.js', '--port', '3000', '--host', '0.0.0.0'], { cwd: 'apps/web' });
} else if (existsSync(rootVite)) {
  start('web', process.execPath, ['node_modules/vite/bin/vite.js', '--port', '3000', '--host', '0.0.0.0'], { cwd: '.' });
} else {
  console.error('[dev] vite not found — run `pnpm install` first');
  process.exit(1);
}
