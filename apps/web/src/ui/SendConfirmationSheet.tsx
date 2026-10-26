import { useEffect, useState } from 'preact/hooks';
import { DeviceIcon, FileTypeIcon } from './icons.js';
import { humanBytes } from './IncomingSheet.js';
import { humanDeviceLabel } from '../device.js';

export interface StagedSend {
  peerId: string;
  peerName: string;
  deviceType: string;
  files: File[];
}

export function SendConfirmationSheet({
  staged,
  onConfirm,
  onCancel,
}: {
  staged: StagedSend;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});

  const totalBytes = staged.files.reduce((acc, f) => acc + (Number.isFinite(f.size) ? f.size : 0), 0);
  const count = staged.files.length;

  useEffect(() => {
    // Generate object URLs for image files to give immediate reassurance
    const urls: Record<number, string> = {};
    staged.files.forEach((file, idx) => {
      if (file.type.startsWith('image/') && file.size < 30 * 1024 * 1024) {
        urls[idx] = URL.createObjectURL(file);
      }
    });
    setThumbnails(urls);

    return () => {
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [staged.files]);

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div class="sheet-card" role="dialog" aria-modal="true" aria-label="Confirm send">
        <div class="sheet-header">
          <div class="recipient-badge">
            <DeviceIcon type={staged.deviceType} size={22} />
            <span>Send to <strong>{staged.peerName}</strong></span>
          </div>
          <span class="device-sub">{humanDeviceLabel(staged.deviceType)}</span>
        </div>

        <div class="file-summary-bar">
          <span class="summary-count">
            {count} {count === 1 ? 'file' : 'files'}
          </span>
          <span class="summary-size">· {humanBytes(totalBytes)} total</span>
        </div>

        <div class="filelist-preview">
          {staged.files.map((file, i) => (
            <div class="file-preview-row" key={i}>
              {thumbnails[i] ? (
                <img src={thumbnails[i]} alt="" class="file-thumb" />
              ) : (
                <div class="file-icon-box">
                  <FileTypeIcon name={file.name} type={file.type} size={20} />
                </div>
              )}
              <div class="file-preview-info">
                <span class="file-preview-name">{file.name}</span>
                <span class="file-preview-size">{humanBytes(file.size)}</span>
              </div>
            </div>
          ))}
        </div>

        <div class="sheet-actions">
          <button class="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button class="btn-primary-send" onClick={onConfirm} autoFocus>
            Send Now
          </button>
        </div>
      </div>
    </div>
  );
}
