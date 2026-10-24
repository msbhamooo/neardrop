#!/usr/bin/env node
/** Production build: build core + server (tsc) and web (vite, includes PWA service worker). */
import { execSync } from 'node:child_process';

import { existsSync } from 'node:fs';

const run = (cmd, opts = {}) => {
  console.log(`\n[build] ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

run('tsc -p packages/core/tsconfig.build.json');
run('tsc -p apps/server/tsconfig.build.json');
const webVite = 'apps/web/node_modules/vite/bin/vite.js';
const viteBin = existsSync(webVite) ? 'node_modules/vite/bin/vite.js' : '../../node_modules/vite/bin/vite.js';
run(`${process.execPath} ${viteBin} build`, { cwd: 'apps/web' });
console.log('\n[build] done: packages/core/dist, apps/server/dist, apps/web/dist');
