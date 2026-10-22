#!/usr/bin/env node
/** Production build: build core + server (tsc) and web (vite, includes PWA service worker). */
import { execSync } from 'node:child_process';

const run = (cmd, opts = {}) => {
  console.log(`\n[build] ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

run('tsc -p packages/core/tsconfig.build.json');
run('tsc -p apps/server/tsconfig.build.json');
run('vite build', { cwd: 'apps/web' });
console.log('\n[build] done: packages/core/dist, apps/server/dist, apps/web/dist');
