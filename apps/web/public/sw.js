// Dev / fallback Service Worker: purges stale Workbox precaches and reloads open clients.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
      try {
        await self.clients.claim();
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          try {
            await client.navigate(client.url);
          } catch {}
        }
      } catch {}
    })()
  );
});
