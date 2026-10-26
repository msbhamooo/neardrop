import { useState } from 'preact/hooks';
import { connState, activeRoomCode } from './signaling.js';
import { session } from './identity.js';
import { toast, transfers, peers, sessionBus } from './transfers.js';
import { DeviceDiscovery } from './ui/DeviceDiscovery.js';
import { SendConfirmationSheet, type StagedSend } from './ui/SendConfirmationSheet.js';
import { ActiveTransferModal } from './ui/ActiveTransferModal.js';
import { TransferSuccessSheet } from './ui/TransferSuccessSheet.js';
import { IncomingSheet } from './ui/IncomingSheet.js';
import { DeviceNameModal } from './ui/DeviceNameModal.js';
import { RoomShareModal } from './ui/RoomShareModal.js';
import { DiagnosticsSheet } from './ui/DiagnosticsSheet.js';
import { Settings } from './ui/Settings.js';
import { disambiguatePeers, showOwnTabs } from './naming.js';
import { SimpleHome } from './ui/SimpleHome.js';
import { QrFlow } from './ui/QrFlow.js';
import { PencilIcon, SettingsIcon } from './ui/icons.js';

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [simple, setSimple] = useState(() => {
    try { return localStorage.getItem('nd.view') === 'simple'; } catch { return false; }
  });
  const toggleView = () => {
    const next = !simple;
    setSimple(next);
    try { localStorage.setItem('nd.view', next ? 'simple' : 'radar'); } catch { /* ignore */ }
  };
  const [showNameModal, setShowNameModal] = useState(false);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [stagedSend, setStagedSend] = useState<StagedSend | null>(null);
  const [dismissedTransfers, setDismissedTransfers] = useState<Set<string>>(new Set());

  const s = session.value;
  const conn = connState.value;
  const currentRoom = activeRoomCode.value;
  const myName = s?.settings.name || 'My Device';
  const peerCount = disambiguatePeers([...peers.value.values()], s?.identity.deviceId ?? '', myName).filter(
    (p) => !p.isSameDeviceTab || showOwnTabs(),
  ).length;

  // Identify active transfers (sending or receiving in progress)
  const transferList = [...transfers.value.values()];
  const activeTransfer = transferList.find(
    (t) => t.status === 'active' || t.status === 'offering'
  );

  // Identify newly completed transfer not yet dismissed
  const completedTransfer = transferList.find(
    (t) => t.status === 'done' && !dismissedTransfers.has(t.id)
  );

  const handleConfirmSend = () => {
    if (!stagedSend) return;
    const { peerId, files } = stagedSend;
    setStagedSend(null);
    void sessionBus.sendFiles(peerId, files);
  };

  const handleDismissCompleted = (id: string) => {
    setDismissedTransfers((prev) => new Set([...prev, id]));
  };

  return (
    <div class={`neardrop-app${simple ? ' calm' : ''}`}>
      {/* Pristine, calm top navigation */}
      <header class="app-topbar">
        <div class="brand-group">
          <div class="logo-mark">
            <span class="logo-radar-ring">
              <span class="logo-radar-core" />
            </span>
            <span class="logo-text">NearDrop</span>
          </div>
          <div class="status-indicator-wrap">
            <span class={`status-beacon ${conn === 'online' ? 'online' : conn === 'connecting' ? 'connecting' : 'offline'}`} />
            <span class="status-label-text">
              {conn === 'online' ? 'Radar active' : conn === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
          </div>
        </div>

        {/* Center: Tap to change device name */}
        <button
          type="button"
          class="device-identity-trigger"
          onClick={() => setShowNameModal(true)}
          title="Tap to change your device name"
          aria-label={`Your device name is ${myName}. Tap to change.`}
        >
          <span class="device-label-prefix">This Device:</span>
          <span class="device-label-name">{myName}</span>
          <PencilIcon size={13} className="device-edit-icon" />
        </button>

        {/* Right action: Room / Settings */}
        <div class="topbar-right-actions">
          {currentRoom && (
            <button
              class="active-room-indicator"
              onClick={() => setShowRoomModal(true)}
              title="Connected across networks via room code"
            >
              <span class="room-indicator-dot" />
              <span>Room {currentRoom}</span>
            </button>
          )}
          <button
            class="btn-icon-minimal"
            onClick={() => setShowSettings(true)}
            aria-label="Settings and options"
            title="Settings"
          >
            <SettingsIcon size={18} />
          </button>
        </div>
      </header>

      {/* Main content: Either Offline QR flow or Device Discovery Canvas */}
      <main class="app-main">
        {showQr ? (
          <QrFlow onDone={() => setShowQr(false)} />
        ) : simple ? (
          <SimpleHome
            onStageSend={(staged) => setStagedSend(staged)}
            onRename={() => setShowNameModal(true)}
            onToggleView={toggleView}
          />
        ) : (
          <DeviceDiscovery
            onStageSend={(staged) => setStagedSend(staged)}
            onOpenRoomModal={() => setShowRoomModal(true)}
          />
        )}
      </main>

      {/* Reassuring bottom status bar */}
      <footer class="app-bottombar">
        <div class="bottombar-left">
          <button
            class="btn-footer-link"
            onClick={() => setShowRoomModal(true)}
          >
            {currentRoom ? `Room ${currentRoom} · Tap to change` : 'Wi-Fi only · Tap to connect across networks'}
          </button>
        </div>
        <div class="bottombar-right">
          <button class="btn-footer-link" onClick={toggleView}>{simple ? 'Radar view' : 'Simple view'}</button>
          <span class="bottombar-peer-count">
            {peerCount === 0
              ? 'No other devices'
              : `${peerCount} ${peerCount === 1 ? 'device' : 'devices'} nearby`}
          </span>
        </div>
      </footer>

      {/* Send Confirmation Dialog */}
      {stagedSend && (
        <SendConfirmationSheet
          staged={stagedSend}
          onConfirm={handleConfirmSend}
          onCancel={() => setStagedSend(null)}
        />
      )}

      {/* Active Transfer Card (Sending / Receiving Progress) */}
      {activeTransfer && !stagedSend && (
        <ActiveTransferModal transfer={activeTransfer} />
      )}

      {/* Transfer Completed Celebration Sheet */}
      {completedTransfer && !activeTransfer && !stagedSend && (
        <TransferSuccessSheet
          transfer={completedTransfer}
          onDismiss={() => handleDismissCompleted(completedTransfer.id)}
        />
      )}

      {/* Incoming Request Dialog (Grandparent-proof Accept / Decline) */}
      <IncomingSheet />

      {/* Change Device Name Modal */}
      {showNameModal && <DeviceNameModal onClose={() => setShowNameModal(false)} />}

      {/* Share / Join Cross-Network Room Modal */}
      {showRoomModal && <RoomShareModal onClose={() => setShowRoomModal(false)} />}

      {/* Advanced Diagnostics (Progressive Disclosure) */}
      {showDiagnostics && <DiagnosticsSheet onClose={() => setShowDiagnostics(false)} />}

      {/* Settings Modal */}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onOpenDiagnostics={() => setShowDiagnostics(true)}
          onOpenQr={() => setShowQr(true)}
        />
      )}

      {/* Reassuring Human Toast */}
      {toast.value && (
        <div class={`human-toast ${toast.value.error ? 'error' : ''}`} role="alert">
          {toast.value.text}
        </div>
      )}
    </div>
  );
}
