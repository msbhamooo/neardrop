import { useState } from 'preact/hooks';
import { session, saveSettings, deviceType } from '../identity.js';
import { sessionBus, showToast } from '../transfers.js';
import { humanDeviceLabel } from '../device.js';
import { getDeviceAdjective } from '../naming.js';

export function DeviceNameModal({ onClose }: { onClose: () => void }) {
  const currentName = session.value?.settings.name || '';
  const [name, setName] = useState(currentName);
  const typeLabel = humanDeviceLabel(deviceType);

  const suggestions = [
    `${getDeviceAdjective()} ${typeLabel}`,
    `Dad's ${typeLabel}`,
    `Mom's ${typeLabel}`,
    `Living Room ${typeLabel}`,
    `Work ${typeLabel}`,
  ];


  const handleSave = () => {
    const clean = name.trim();
    if (!clean) return;
    void saveSettings({ name: clean });
    sessionBus.stop();
    sessionBus.start();
    showToast(`Name updated to "${clean}"`);
    onClose();
  };

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet-card name-modal-card" role="dialog" aria-modal="true" aria-label="Change device name">
        <h3 class="sheet-modal-title">Your Device Name</h3>
        <p class="sheet-modal-subtitle">
          This is the name nearby people see when they want to send you files.
        </p>

        <div class="name-input-wrap">
          <input
            type="text"
            class="friendly-input"
            value={name}
            maxlength={32}
            autoFocus
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
        </div>

        <div class="suggestions-wrap">
          <span class="suggestions-label">Suggestions:</span>
          <div class="suggestion-chips">
            {suggestions.map((sug) => (
              <button
                key={sug}
                type="button"
                class="suggestion-chip"
                onClick={() => setName(sug)}
              >
                {sug}
              </button>
            ))}
          </div>
        </div>

        <div class="sheet-actions">
          <button class="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            class="btn-primary-send"
            onClick={handleSave}
            disabled={!name.trim()}
          >
            Save Name
          </button>
        </div>
      </div>
    </div>
  );
}
