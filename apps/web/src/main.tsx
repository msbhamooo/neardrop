import { render } from 'preact';
import { effect } from '@preact/signals';
import { App } from './App.js';
import './styles.css';
import { initIdentity } from './identity.js';
import { loadPaired } from './paired.js';
import { sessionBus, pendingShare } from './transfers.js';
import { connState } from './signaling.js';
import { session } from './identity.js';
import { get } from 'idb-keyval';

async function boot(): Promise<void> {
  await Promise.all([initIdentity(), loadPaired()]);

  // SW registration is injected by vite-plugin-pwa (`injectRegister: script-defer`).

  sessionBus.start();

  // Web Share Target inbox (stashed by the service worker)
  if (location.search.includes('share=1')) {
    const inbox = await get<Array<{ name: string; type: string; blob: Blob }>>('neardrop:share-inbox');
    if (inbox && inbox.length > 0) {
      const files = inbox.map((entry) => new File([entry.blob], entry.name, { type: entry.type }));
      pendingShare.value = files;
      await import('idb-keyval').then((idb) => idb.del('neardrop:share-inbox'));
    }
    history.replaceState(null, '', '/');
  }

  // Offline detection: WS unreachable or browser offline → offline pairing UI.
  effect(() => {
    if (connState.value === 'offline' && !navigator.onLine) {
      // keep app functional; QrFlow screen is reachable via the toolbar button
    }
  });

  void session.value; // touch: identity ready

  render(<App />, document.getElementById('app')!);
}

void boot();
