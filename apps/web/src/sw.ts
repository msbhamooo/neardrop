/**
 * NearDrop service worker (vite-plugin-pwa injectManifest).
 * - Precaches the entire app shell → the app boots fully offline (Phase 3).
 * - Handles the Web Share Target POST: stash shared files in IDB and redirect,
 *   so NearDrop appears in the Android share sheet.
 */
/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL, type PrecacheEntry } from 'workbox-precaching';
import { set } from 'idb-keyval';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute((self as unknown as { __WB_MANIFEST: Array<string | PrecacheEntry> }).__WB_MANIFEST);

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  // SPA navigation fallback (covers /?share=1 too — pathname is still '/')
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(createHandlerBoundToURL('/index.html')(event as never));
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
  if (event.data === 'skip-waiting') void self.skipWaiting?.();
});
