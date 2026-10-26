import { sessionBus, peers, transfers } from '../transfers.js';
import { session } from '../identity.js';
import { activeRoomCode } from '../signaling.js';
import { humanBytes } from './IncomingSheet.js';
import { fmtSpeed, fmtEta } from './Transfers.js';
import { CloseIcon } from './icons.js';

export function DiagnosticsSheet({ onClose }: { onClose: () => void }) {
  const activeLink = sessionBus.activeLink();
  const activeSender = sessionBus.activeSender();
  const peerList = [...peers.value.values()];
  const transferList = [...transfers.value.values()];
  const activeTransfer = transferList.find((t) => t.status === 'active' || t.status === 'offering');

  const connectionMode = activeLink?.usingRelayFallback
    ? 'Encrypted WebSocket Relay Mesh'
    : activeLink?.connected
      ? 'Direct WebRTC P2P (SCTP DataChannel)'
      : 'Idle / Awaiting Active Stream';

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet-card diag-card" role="dialog" aria-modal="true" aria-label="Advanced Diagnostics">
        <div class="diag-header">
          <h3 class="sheet-modal-title">Advanced Diagnostics</h3>
          <button class="btn-close-icon" onClick={onClose} aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>

        <p class="sheet-modal-subtitle">
          Internal transport telemetry and network performance metrics.
        </p>

        <div class="diag-section">
          <div class="diag-row">
            <span class="diag-label">Active Transport</span>
            <span class="diag-value highlight">{connectionMode}</span>
          </div>
          <div class="diag-row">
            <span class="diag-label">Connected Peers</span>
            <span class="diag-value">{peerList.length} discovered</span>
          </div>
          <div class="diag-row">
            <span class="diag-label">Local Device ID</span>
            <span class="diag-value mono">{session.value?.identity.deviceId || '—'}</span>
          </div>
          <div class="diag-row">
            <span class="diag-label">Room / Scope</span>
            <span class="diag-value mono">{activeRoomCode.value || 'Local LAN broadcast'}</span>
          </div>
          {activeTransfer && (
            <>
              <div class="diag-row">
                <span class="diag-label">Current Throughput</span>
                <span class="diag-value">{fmtSpeed(activeTransfer.speed)}</span>
              </div>
              <div class="diag-row">
                <span class="diag-label">Transferred</span>
                <span class="diag-value">
                  {humanBytes(activeTransfer.bytes)} / {humanBytes(activeTransfer.totalBytes)}
                </span>
              </div>
              <div class="diag-row">
                <span class="diag-label">Estimated Time Left</span>
                <span class="diag-value">{fmtEta(activeTransfer.eta)}</span>
              </div>
            </>
          )}
          {activeSender && (
            <div class="diag-row">
              <span class="diag-label">Active Sender Chunks</span>
              <span class="diag-value">Adaptive BDP streaming active</span>
            </div>
          )}
        </div>

        <div class="sheet-actions">
          <button class="btn-primary-send" onClick={onClose}>
            Close Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
}
