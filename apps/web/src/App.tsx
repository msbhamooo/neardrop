import { useState } from 'preact/hooks';
import { connState } from './signaling.js';
import { session } from './identity.js';
import { toast, transfers, pendingShare, peers } from './transfers.js';
import { Radar } from './ui/Radar.js';
import { IncomingSheet } from './ui/IncomingSheet.js';
import { TransfersList } from './ui/Transfers.js';
import { Settings } from './ui/Settings.js';
import { DebugPanel } from './ui/Debug.js';
import { QrFlow } from './ui/QrFlow.js';
import { sessionBus } from './transfers.js';

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const s = session.value!;
  const conn = connState.value;
  const hasTransfers = transfers.value.size > 0 || pendingShare.value !== null;

  return (
    <>
      <header class="topbar">
        <span class="title">NearDrop</span>
        <span class={`conn-pill${conn === 'offline' ? ' offline' : ''}`}>
          {conn === 'online' ? `${peers.value.size} nearby` : conn === 'connecting' ? 'connecting…' : 'offline'}
        </span>
        <button class="ghost" style="font-size:12px" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Radar' : 'Pair offline'}
        </button>
        <button class="ghost" style="font-size:12px" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      {showQr ? (
        <QrFlow onDone={() => setShowQr(false)} />
      ) : (
        <Radar onOpenPicker={() => setShowQr(false)} />
      )}

      {!showQr && (
        <>
          {hasTransfers && (
            <div style="padding:0 0 4px">
              <TransfersList />
            </div>
          )}
          {s.settings.debug && <DebugPanel />}
        </>
      )}

      <footer class="bottombar">
        <div class="seg" role="radiogroup" aria-label="Receiving mode">
          {(['off', 'contacts', 'everyone'] as const).map((mode) => (
            <button
              class={s.settings.visibility === mode ? 'on' : ''}
              onClick={() => {
                // quick toggle via the segmented control (also in Settings)
                import('./identity.js').then((m) => m.saveSettings({ visibility: mode }));
              }}
            >
              {mode === 'off' ? 'Receiving off' : mode === 'contacts' ? 'Contacts' : 'Everyone'}
            </button>
          ))}
        </div>
        <span style="flex:1" />
        <span style="font-size:11px;color:var(--fg-dim)">
          {sessionBus ? 'files go direct, never via a server' : ''}
        </span>
      </footer>

      <IncomingSheet />
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {toast.value && <div class={`toast${toast.value.error ? ' error' : ''}`}>{toast.value.text}</div>}
    </>
  );
}
