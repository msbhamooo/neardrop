import { useState } from 'preact/hooks';
import type { TransferView } from '../transfers.js';
import { received } from '../sinks.js';
import { humanBytes } from './IncomingSheet.js';
import { CheckCircleIcon, FileTypeIcon } from './icons.js';

export function TransferSuccessSheet({
  transfer,
  onDismiss,
}: {
  transfer: TransferView;
  onDismiss: () => void;
}) {
  const isSend = transfer.direction === 'send';
  const [savedCount, setSavedCount] = useState<number>(0);
  const [savingAll, setSavingAll] = useState(false);

  const fileCount = transfer.files?.length || 1;
  const totalSize = humanBytes(transfer.totalBytes);

  const handleSaveAll = async () => {
    setSavingAll(true);
    let count = 0;
    for (let i = 0; i < fileCount; i++) {
      const rec = received.get(`${transfer.id}:${i}`);
      if (rec) {
        try {
          await rec.save();
          count++;
          setSavedCount(count);
        } catch {
          // ignore error
        }
      }
    }
    setSavingAll(false);
  };

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onDismiss()}>
      <div class="sheet-card success-card" role="dialog" aria-modal="true" aria-label="Transfer complete">
        <div class="success-icon-wrap">
          <CheckCircleIcon size={52} className="success-icon" />
        </div>

        <h3 class="success-title">
          {isSend ? 'Sent successfully!' : 'Received successfully!'}
        </h3>
        <p class="success-subtitle">
          {isSend
            ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'} (${totalSize}) sent to ${transfer.peerName}`
            : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} (${totalSize}) from ${transfer.peerName}`}
        </p>

        <div class="filelist-preview" style="max-height: 180px;">
          {transfer.files?.map((f, i) => (
            <div class="file-preview-row" key={i}>
              <div class="file-icon-box">
                <FileTypeIcon name={f.name} size={18} />
              </div>
              <div class="file-preview-info">
                <span class="file-preview-name">{f.name}</span>
                <span class="file-preview-size">{humanBytes(f.size)}</span>
              </div>
            </div>
          ))}
        </div>

        <div class="sheet-actions">
          {!isSend && (
            <button
              class="btn-primary-send"
              onClick={handleSaveAll}
              disabled={savingAll}
            >
              {savingAll ? 'Saving…' : savedCount > 0 ? 'Saved to Downloads ✓' : 'Save to Device'}
            </button>
          )}
          <button class={isSend ? 'btn-primary-send' : 'btn-cancel'} onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
