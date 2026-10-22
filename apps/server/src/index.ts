import { createSignalingServer } from './create-server.js';

const PORT = Number(process.env.PORT ?? 3001);

createSignalingServer({ port: PORT })
  .then(() => {
    console.log(`[signaling] listening on :${PORT} (TRUST_PROXY=${process.env.TRUST_PROXY === '1' ? '1' : '0'})`);
  })
  .catch((err) => {
    console.error('[signaling] failed to start', err);
    process.exit(1);
  });
