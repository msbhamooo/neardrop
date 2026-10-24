import { useState } from 'preact/hooks';
import { connState, activeRoomCode } from './signaling.js';
import { session } from './identity.js';
import { toast, transfers, pendingShare, peers, sessionBus, showToast } from './transfers.js';
import { Radar } from './ui/Radar.js';
import { IncomingSheet } from './ui/IncomingSheet.js';
import { TransfersList } from './ui/Transfers.js';
import { Settings } from './ui/Settings.js';
import { DebugPanel } from './ui/Debug.js';
import { QrFlow } from './ui/QrFlow.js';

function randomRoomCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showRoomBar, setShowRoomBar] = useState(Boolean(activeRoomCode.value));
  const [roomInput, setRoomInput] = useState(activeRoomCode.value ?? '');

  const s = session.value!;
  const conn = connState.value;
  const currentRoom = activeRoomCode.value;
  const hasTransfers = transfers.value.size > 0 || pendingShare.value !== null;

  const applyRoom = (code?: string) => {
    sessionBus.setRoomCode(code);
    setRoomInput(activeRoomCode.value ?? '');
    if (activeRoomCode.value) {
      showToast(`Joined cross-network room ${activeRoomCode.value}`);
    } else {
      showToast('Returned to local network discovery');
    }
  };

  const copyRoomLink = async () => {
    const code = activeRoomCode.value || randomRoomCode();
    if (!activeRoomCode.value) applyRoom(code);
    const url = `${location.origin}${location.pathname}?room=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast(`Room ${code} link copied`);
    } catch {
      showToast(`Room code: ${code}`);
    }
  };

  return (
    <>
      <header class="topbar">
        <span class="title">NearDrop</span>
        <span class={`conn-pill${conn === 'offline' ? ' offline' : ''}`}>
          {conn === 'online' ? `${peers.value.size} nearby` : conn === 'connecting' ? 'connecting…' : 'offline'}
        </span>
        <button
          class="ghost"
          style="font-size:12px"
          onClick={() => {
            setShowRoomBar((v) => !v);
            if (!roomInput && activeRoomCode.value) setRoomInput(activeRoomCode.value);
          }}
        >
          {currentRoom ? `Room: ${currentRoom}` : 'Cross-network'}
        </button>
        <button class="ghost" style="font-size:12px" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Radar' : 'Pair offline'}
        </button>
        <button class="ghost" style="font-size:12px" aria-label="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      {showRoomBar && !showQr && (
        <div class="roombar">
          <input
            type="text"
            placeholder="Enter room code (e.g. 7K9P2M)"
            value={roomInput}
            maxlength={24}
            onInput={(e) => setRoomInput((e.target as HTMLInputElement).value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyRoom(roomInput);
            }}
          />
          <button class="primary" style="padding:8px 12px;font-size:12px" onClick={() => applyRoom(roomInput)}>
            Join room
          </button>
          <button
            style="padding:8px 12px;font-size:12px"
            onClick={() => {
              const code = randomRoomCode();
              setRoomInput(code);
              applyRoom(code);
            }}
          >
            New code
          </button>
          <button style="padding:8px 12px;font-size:12px" onClick={() => void copyRoomLink()}>
            Copy link
          </button>
          {currentRoom && (
            <button
              class="danger"
              style="padding:8px 12px;font-size:12px"
              onClick={() => {
                setRoomInput('');
                applyRoom(undefined);
              }}
            >
              Leave
            </button>
          )}
        </div>
      )}

      {showQr ? (
        <QrFlow onDone={() => setShowQr(false)} />
      ) : (
        <Radar onOpenCrossNetwork={() => setShowRoomBar(true)} />
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
                import('./identity.js').then((m) => m.saveSettings({ visibility: mode }));
              }}
            >
              {mode === 'off' ? 'Receiving off' : mode === 'contacts' ? 'Contacts' : 'Everyone'}
            </button>
          ))}
        </div>
        <span style="flex:1" />
        <span style="font-size:11px;color:var(--fg-dim)">
          {sessionBus ? 'End-to-end verified · LAN, Cross-NAT, QR & Relay' : ''}
        </span>
      </footer>

      <IncomingSheet />
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {toast.value && <div class={`toast${toast.value.error ? ' error' : ''}`}>{toast.value.text}</div>}
    </>
  );
}
