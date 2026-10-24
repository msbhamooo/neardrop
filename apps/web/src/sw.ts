/**
 * NearDrop service worker (vite-plugin-pwa injectManifest).
 * - Precaches the entire app shell → the app boots fully offline (Phase 3).
 * - Handles the Web Share Target POST: stash shared files in IDB and redirect,
 *   so NearDrop appears in the Android share sheet.
 */
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL, type PrecacheEntry } from 'workbox-precaching';
import { set } from 'idb-keyval';

declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();

const manifest = (self as unknown as { __WB_MANIFEST: Array<string | PrecacheEntry> }).__WB_MANIFEST;
if (Array.isArray(manifest) && manifest.length > 0) {
  precacheAndRoute(manifest);
}

self.addEventListener('install', () => {
  void self.skipWaiting?.();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/health')) {
    return;
  }
  // Network-first SPA navigation fallback (falls back to precached /index.html only when offline)
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(
      fetch(event.request).catch(() => {
        if (Array.isArray(manifest) && manifest.some((e) => (typeof e === 'string' ? e : e.url).includes('index.html'))) {
          return createHandlerBoundToURL('/index.html')(event as never);
        }
        return caches.match('/index.html') as Promise<Response>;
      }),
    );
    return;
  }
  // Web Share Target: POST /share-target with multipart/form-data
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
  }
});

async function handleShareTarget(request: unknown): Promise<Response> {
  try {
    const req = request as Request;
    const form = await req.formData();
    const stashed: Array<{ name: string; type: string; blob: Blob }> = [];
    const files = form.getAll('files').filter((f): f is File => f instanceof File);
    const title = form.get('title');
    const text = form.get('text');
    for (const file of files) {
      stashed.push({ name: file.name, type: file.type || 'application/octet-stream', blob: file });
    }
    if (!files.length && (typeof text === 'string' || typeof title === 'string')) {
      const content = [title, text].filter((x): x is string => typeof x === 'string').join('\n');
      if (content.trim()) {
        stashed.push({
          name: `Shared text ${new Date().toISOString().slice(0, 19).replace('T', ' ')}.txt`,
          type: 'text/plain',
          blob: new Blob([content]),
        });
      }
    }
    if (stashed.length > 0) {
      await set('neardrop:share-inbox', stashed);
    }
  } catch {
    /* best effort — still redirect below */
  }
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | string | null;
  if (data === 'skip-waiting' || (typeof data === 'object' && data?.type === 'SKIP_WAITING')) {
    void self.skipWaiting?.();
  }
});
