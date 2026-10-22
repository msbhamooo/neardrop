import { useState } from 'preact/hooks';
import { session, saveSettings, deviceType } from '../identity.js';
import { pairedDevices, forgetPaired } from '../paired.js';
import { showToast, sessionBus, pendingShare } from '../transfers.js';
import { peers } from '../transfers.js';


export function Settings({ onClose }: { onClose: () => void }) {
  const s = session.value!;
  const paired = [...pairedDevices.value.values()];
  const [name, setName] = useState(s.settings.name);
  const [nameDirty, setNameDirty] = useState(false);

  return (
    <div class="settings" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="panel">
        <h3>Settings</h3>

        <div class="field">
          <label for="nd-name">Device name</label>
          <div style="display:flex;gap:8px">
            <input
              id="nd-name"
              type="text"
              value={name}
              maxlength={40}
              onChange={(e) => {
                setName((e.target as HTMLInputElement).value);
                setNameDirty(true);
              }}
            />
            <button
              disabled={!nameDirty || !name.trim()}
              onClick={() => {
                void saveSettings({ name: name.trim() });
                setNameDirty(false);
                sessionBus.stop();
                sessionBus.start();
                showToast('Name updated');
              }}
            >
              Save
            </button>
          </div>
          <div style="font-size:11px;color:var(--fg-dim);margin-top:6px">
            Your identity: <code>{s.identity.deviceId}</code> · {deviceType}
          </div>
        </div>

        <div class="field">
          <label>Receiving</label>
          <div class="seg">
            {(['off', 'contacts', 'everyone'] as const).map((mode) => (
              <button
                class={s.settings.visibility === mode ? 'on' : ''}
                onClick={() => {
                  void saveSettings({ visibility: mode });
                  showToast(`Receiving: ${mode === 'off' ? 'Off' : mode === 'contacts' ? 'Contacts only' : 'Everyone'}`);
                }}
              >
                {mode === 'off' ? 'Off' : mode === 'contacts' ? 'Contacts' : 'Everyone'}
              </button>
            ))}
          </div>
          <div style="font-size:11px;color:var(--fg-dim);margin-top:6px">
            Contacts = devices you paired before. Unknown senders always need explicit Accept.
          </div>
        </div>

        <div class="field">
          <label>Nearby discovery (geohash)</label>
          <div class="seg">
            <button class={s.settings.geoEnabled ? 'on' : ''} onClick={() => void saveSettings({ geoEnabled: true })}>
              On
            </button>
            <button class={!s.settings.geoEnabled ? 'on' : ''} onClick={() => void saveSettings({ geoEnabled: false })}>
              Off
            </button>
          </div>
          <div style="font-size:11px;color:var(--fg-dim);margin-top:6px">
            Publishes a ~40m geohash cell so you see people on the same Wi-Fi even behind carrier NAT.
            Rounded, ephemeral, never stored by the server.
          </div>
        </div>

        <div class="field">
          <label>Paired devices ({paired.length})</label>
          {paired.length === 0 && <div style="font-size:12px;color:var(--fg-dim)">None yet — pair offline via QR or accept + verify a transfer.</div>}
          {paired.map((d) => (
            <div class="paired-item" key={d.deviceId}>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {d.name} <span style="color:var(--fg-dim)">· {d.deviceType}</span>
              </span>
              <span class="fp">{d.deviceId}</span>
              <button
                class="danger"
                style="font-size:11px;padding:4px 10px"
                onClick={() => {
                  void forgetPaired(d.deviceId);
                  showToast('Unpaired');
                }}
              >
                Unpair
              </button>
            </div>
          ))}
        </div>

        <div class="field">
          <label>Debug</label>
          <div class="seg">
            <button class={s.settings.debug ? 'on' : ''} onClick={() => void saveSettings({ debug: true })}>
              Show panel
            </button>
            <button class={!s.settings.debug ? 'on' : ''} onClick={() => void saveSettings({ debug: false })}>
              Hide
            </button>
          </div>
        </div>

        {pendingShare.value && (
          <div class="field">
            <button
              class="danger"
              onClick={() => {
                pendingShare.value = null;
                onClose();
              }}
            >
              Discard {pendingShare.value.length} shared file(s)
            </button>
          </div>
        )}

        <div style="display:flex;justify-content:space-between;margin-top:16px;align-items:center">
          <span style="font-size:11px;color:var(--fg-dim)">
            {peers.value.size} peer{peers.value.size === 1 ? '' : 's'} nearby
          </span>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
