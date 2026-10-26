import { useState } from 'preact/hooks';
import { activeRoomCode } from '../signaling.js';
import { sessionBus, showToast } from '../transfers.js';
import { LinkIcon } from './icons.js';
import { makeRoomCode } from '../roomcode.js';

export function RoomShareModal({ onClose }: { onClose: () => void }) {
  const currentRoom = activeRoomCode.value;
  const [code, setCode] = useState(currentRoom || '');

  const handleJoin = (targetCode?: string) => {
    const val = (targetCode || code).trim().toUpperCase();
    if (!val) {
      sessionBus.setRoomCode(undefined);
      showToast('Switched to local Wi-Fi only');
      onClose();
      return;
    }
    sessionBus.setRoomCode(val);
    showToast(`Connected to room ${val}`);
    onClose();
  };

  const handleCopyLink = async () => {
    const roomToUse = currentRoom || code.trim() || makeRoomCode();
    if (!currentRoom) {
      sessionBus.setRoomCode(roomToUse);
      setCode(roomToUse);
    }
    const url = `${window.location.origin}${window.location.pathname}?room=${roomToUse}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied to clipboard!');
    } catch {
      showToast(`Room code: ${roomToUse}`);
    }
  };

  const handleLeave = () => {
    sessionBus.setRoomCode(undefined);
    setCode('');
    showToast('Returned to local Wi-Fi');
    onClose();
  };

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet-card room-modal-card" role="dialog" aria-modal="true" aria-label="Connect across networks">
        <h3 class="sheet-modal-title">Share Across Different Networks</h3>
        <p class="sheet-modal-subtitle">
          On different Wi-Fi networks or mobile data? Send a link or enter the code to connect instantly.
        </p>

        {currentRoom && (
          <div class="current-room-badge">
            <span>Connected to code: <strong>{currentRoom}</strong></span>
            <button class="btn-leave-room" onClick={handleLeave}>Leave</button>
          </div>
        )}

        <div class="room-actions-stack">
          <button class="btn-copy-room-link" onClick={handleCopyLink}>
            <LinkIcon size={16} />
            <span>Copy Invite Link</span>
          </button>


          <div class="room-divider">
            <span>or enter a code</span>
          </div>

          <div class="room-input-row">
            <input
              type="text"
              class="room-code-input"
              placeholder="e.g. HILL-SHOE-RING"
              value={code}
              maxlength={24}
              onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJoin();
              }}
            />
            <button
              class="btn-primary-send"
              style="padding: 12px 18px; min-width: 80px;"
              onClick={() => handleJoin()}
              disabled={code.trim().length < 3}
            >
              Join
            </button>
          </div>
        </div>

        <div class="sheet-actions">
          <button class="btn-cancel" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
