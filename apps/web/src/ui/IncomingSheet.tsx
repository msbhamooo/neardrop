import { incoming, sessionBus } from '../transfers.js';
import { FileTypeIcon, DownloadIcon } from './icons.js';

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function IncomingSheet() {
  const inc = incoming.value;
  if (!inc) return null;

  const totalBytes = inc.files.reduce((acc, f) => acc + (Number.isFinite(f.size) ? f.size : 0), 0);
  const count = inc.files.length;

  return (
    <div class="sheet-backdrop">
      <div class="sheet-card incoming-card" role="dialog" aria-modal="true" aria-label="Incoming transfer request">
        <div class="incoming-header">
          <div class="incoming-avatar-circle">
            <DownloadIcon size={28} className="incoming-avatar-icon" />
          </div>
          <h3 class="incoming-title">
            <strong>{inc.senderName}</strong> wants to send you {count === 1 ? 'a file' : `${count} files`}
          </h3>
          <p class="incoming-subtitle">
            {count} {count === 1 ? 'item' : 'items'} · {humanBytes(totalBytes)} total
          </p>
        </div>

        <div class="filelist-preview" style="max-height: 200px;">
          {inc.files.map((f, i) => (
            <div class="file-preview-row" key={i}>
              <div class="file-icon-box">
                <FileTypeIcon name={f.name} type={f.type} size={20} />
              </div>
              <div class="file-preview-info">
                <span class="file-preview-name">{f.name}</span>
                <span class="file-preview-size">{humanBytes(f.size)}</span>
              </div>
            </div>
          ))}
        </div>

        <div class="sheet-actions incoming-actions">
          <button
            class="btn-decline"
            onClick={() => sessionBus.rejectIncoming()}
          >
            Decline
          </button>
          <button
            class="btn-accept"
            onClick={() => sessionBus.acceptIncoming()}
            autoFocus
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
