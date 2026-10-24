#!/usr/bin/env node
/**
 * Prod entry: single-process unified server on PORT (default :3000).
 * Serves apps/web/dist statically + /api/signal HTTP signaling + /ws WebSocket signaling + /health
 * in the exact same process and HTTP server (no child process or port 3001 race conditions).
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

try { execSync('pkill -f "apps/server/src/index.ts" || true', { stdio: 'ignore' }); } catch {}

const serverEntry = resolvePath('apps/server/dist/create-server.js');
if (!existsSync(serverEntry)) {
  execSync('tsc -p packages/core/tsconfig.build.json && tsc -p apps/server/tsconfig.build.json', { stdio: 'inherit' });
}

const { createSignalingServer } = await import(serverEntry);
const port = Number(process.env.PORT ?? 3000);
const staticDir = resolvePath('apps/web/dist');

const srv = await createSignalingServer({
  port,
  trustProxy: true,
  log: true,
  staticDir,
});

console.log(`[prod] unified web + signaling (/api/signal + /ws) listening on :${srv.port}`);

const stop = () => {
  void srv.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
