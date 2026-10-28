import { useState } from 'preact/hooks';
import { session, saveSettings, deviceType } from '../identity.js';
import { pairedDevices, forgetPaired } from '../paired.js';
import { showToast, sessionBus } from '../transfers.js';
import { humanDeviceLabel } from '../device.js';
import { CloseIcon, QrCodeIcon, ActivityIcon } from './icons.js';

export function Settings({
  onClose,
  onOpenDiagnostics,
  onOpenQr,
}: {
  onClose: () => void;
  onOpenDiagnostics: () => void;
  onOpenQr: () => void;
}) {
  const s = session.value!;
  const paired = [...pairedDevices.value.values()];
  const [name, setName] = useState(s.settings.name);
  const [nameDirty, setNameDirty] = useState(false);

  const handleSaveName = () => {
    const clean = name.trim();
    if (!clean) return;
    void saveSettings({ name: clean });
    setNameDirty(false);
    sessionBus.stop();
    sessionBus.start();
    showToast('Device name saved');
  };

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet-card settings-card" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="diag-header">
          <h3 class="sheet-modal-title">Settings</h3>
          <button class="btn-close-icon" onClick={onClose} aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>


        {/* Device Name */}
        <div class="settings-group">
          <label class="settings-group-title">Device Name</label>
          <div class="settings-row-input">
            <input
              type="text"
              class="friendly-input"
              value={name}
              maxlength={32}
              onInput={(e) => {
                setName((e.target as HTMLInputElement).value);
                setNameDirty(true);
              }}
            />
            {nameDirty && (
              <button
                class="btn-primary-send"
                style="padding: 10px 16px; min-width: 60px;"
                onClick={handleSaveName}
              >
                Save
              </button>
            )}
          </div>
          <span class="settings-hint">Visible to nearby devices as a {humanDeviceLabel(deviceType)}.</span>
        </div>

        {/* Receiving Mode */}
        <div class="settings-group">
          <label class="settings-group-title">Who can send to you</label>
          <div class="seg-pill-group">
            {(['everyone', 'contacts', 'off'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                class={`seg-pill-btn ${s.settings.visibility === mode ? 'active' : ''}`}
                onClick={() => {
                  void saveSettings({ visibility: mode });
                  showToast(
                    `Receiving: ${mode === 'everyone' ? 'Everyone' : mode === 'contacts' ? 'Known contacts' : 'Off'}`
                  );
                }}
              >
                {mode === 'everyone' ? 'Everyone' : mode === 'contacts' ? 'Known Only' : 'Hidden (Off)'}
              </button>
            ))}
          </div>
          <span class="settings-hint">
            {s.settings.visibility === 'everyone'
              ? 'Anyone nearby can request to send files. You can always decline.'
              : s.settings.visibility === 'contacts'
                ? 'Only devices you have previously accepted transfers from.'
                : 'Your device is hidden from nearby discovery.'}
          </span>
        </div>

        {/* Known Devices */}
        {paired.length > 0 && (
          <div class="settings-group">
            <label class="settings-group-title">Known Devices ({paired.length})</label>
            <div class="paired-list">
              {paired.map((d) => (
                <div class="paired-row" key={d.deviceId}>
                  <div class="paired-info">
                    <span class="paired-name">{d.name}</span>
                    <span class="paired-sub">{d.deviceType}</span>
                  </div>
                  <button
                    class="btn-unpair"
                    onClick={() => {
                      void forgetPaired(d.deviceId);
                      showToast('Device forgotten');
                    }}
                  >
                    Forget
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Privacy */}
        <div class="settings-group">
          <label class="settings-group-title">Privacy</label>
          <label class="settings-action-row" style="cursor:pointer">
            <div class="settings-action-label">
              <span>Share anonymous usage data</span>
            </div>
            <input
              type="checkbox"
              checked={s.settings.shareStats !== false}
              onChange={(e) => void saveSettings({ shareStats: (e.target as HTMLInputElement).checked })}
            />
          </label>
          <span class="settings-hint">
            Helps fix bugs and speed. Never includes file names, contents, or anything that identifies you.
          </span>
        </div>

        {/* Extra Options */}
        <div class="settings-group">
          <label class="settings-group-title">More Options</label>
          <div class="more-options-list">
            <button
              class="settings-action-row"
              onClick={() => {
                onClose();
                onOpenQr();
              }}
            >
              <div class="settings-action-label">
                <QrCodeIcon size={18} />
                <span>Connect Offline via Camera (QR)</span>
              </div>
              <span class="action-chevron">›</span>
            </button>
            <button
              class="settings-action-row"
              onClick={() => {
                onClose();
                onOpenDiagnostics();
              }}
            >
              <div class="settings-action-label">
                <ActivityIcon size={18} />
                <span>Advanced Diagnostics & Speed</span>
              </div>
              <span class="action-chevron">›</span>
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
