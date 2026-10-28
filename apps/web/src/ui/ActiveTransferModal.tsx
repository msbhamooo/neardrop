import type { TransferView } from '../transfers.js';
import { sessionBus } from '../transfers.js';
import { humanBytes } from './IncomingSheet.js';
import { fmtEta } from './Transfers.js';
import { DeviceIcon } from './icons.js';

export function ActiveTransferModal({ transfer }: { transfer: TransferView }) {
  const isSend = transfer.direction === 'send';
  const pct = transfer.totalBytes > 0 ? Math.min(100, Math.round((transfer.bytes / transfer.totalBytes) * 100)) : 0;
  const isOffering = transfer.status === 'offering';
  const isDone = transfer.status === 'done';
  const kind = sessionBus.connectionKind(transfer.peerId);

  // Format friendly ETA
  let timeText = '';
  if (isOffering) {
    timeText = 'Waiting for recipient to accept…';
  } else if (pct >= 99 && !isDone) {
    timeText = 'Almost done… checking your files';
  } else if (transfer.eta && isFinite(transfer.eta) && transfer.eta > 0) {
    if (transfer.eta < 5) timeText = 'A few seconds remaining';
    else if (transfer.eta < 60) timeText = `About ${Math.round(transfer.eta)} seconds remaining`;
    else timeText = `About ${fmtEta(transfer.eta)} remaining`;
  } else {
    timeText = 'Transferring…';
  }

  const fileCount = transfer.files?.length || 1;
  const firstFileName = transfer.files?.[0]?.name || 'File';
  const title = isSend
    ? `Sending to ${transfer.peerName}`
    : `Receiving from ${transfer.peerName}`;

  return (
    <div class="active-transfer-card" role="status" aria-live="polite">
      <div class="active-transfer-head">
        <div class="active-transfer-lead">
          <span class="active-pulse-dot" />
          <span class="active-transfer-title">{title}</span>
        </div>
        <button
          class="btn-stop-text"
          onClick={() => sessionBus.cancelTransfer(transfer.id)}
          aria-label="Stop transfer"
        >
          Stop
        </button>
      </div>

      <div class="active-files-summary">
        <span class="file-name-truncate">
          {fileCount === 1 ? firstFileName : `${fileCount} files (${firstFileName}, …)`}
        </span>
      </div>

      <div class="active-progress-track">
        <div class="active-progress-fill" style={`width:${isOffering ? 10 : Math.max(8, pct)}%`} />
      </div>

      <div class="active-metrics-row">
        <span class="active-percentage">{isOffering ? 'Connecting…' : `${pct}%`}</span>
        <span class="active-bytes">
          {humanBytes(transfer.bytes)} of {humanBytes(transfer.totalBytes)}
        </span>
      </div>

      <div class="active-eta-row">
        <span>{timeText}</span>
        {!isOffering && transfer.speed > 0 && <span class="active-speed">{humanBytes(transfer.speed)}/s</span>}
      </div>
      {kind === 'direct' && !isDone && transfer.bytes > 8 * 1024 * 1024 && transfer.speed > 0 && transfer.speed < 3 * 1024 * 1024
        && transfer.totalBytes - transfer.bytes > 15 * 1024 * 1024 && (
        <div class="active-note">
          Slow link. This looks like a 2.4 GHz Wi-Fi connection. Moving both devices to 5 GHz, or using a phone hotspot, is often 2–3× faster.
        </div>
      )}
      <div class="active-note">
        {kind === 'relay' ? 'Sent through a relay, still end-to-end encrypted. ' : kind === 'direct' ? 'Direct connection between devices. ' : ''}
        Keep this screen open until it finishes.
      </div>
    </div>
  );
}
