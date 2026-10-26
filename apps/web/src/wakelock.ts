import { effect } from '@preact/signals';
import { transfers } from './transfers.js';

/**
 * Keep the screen awake while a transfer is running. Phones suspend a backgrounded or dimmed page,
 * which silently kills WebRTC transfers (worst on iOS). Best effort: unsupported browsers ignore it.
 */
let lock: WakeLockSentinel | null = null;

async function acquire(): Promise<void> {
  try {
    if (!lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    }
  } catch { /* denied or unsupported */ }
}

async function release(): Promise<void> {
  try { await lock?.release(); } catch { /* ignore */ }
  lock = null;
}

export function initWakeLock(): void {
  effect(() => {
    const busy = [...transfers.value.values()].some((t) => t.status === 'active' || t.status === 'offering');
    if (busy) void acquire();
    else void release();
  });
  // The browser drops the lock when the tab is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => {
    const busy = [...transfers.value.values()].some((t) => t.status === 'active' || t.status === 'offering');
    if (document.visibilityState === 'visible' && busy) void acquire();
  });
}
