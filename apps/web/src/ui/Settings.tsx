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
  const [turnUrl, setTurnUrl] = useState(s.settings.turnUrl ?? '');
  const [turnUsername, setTurnUsername] = useState(s.settings.turnUsername ?? '');
  const [turnCredential, setTurnCredential] = useState(s.settings.turnCredential ?? '');
  const [turnDirty, setTurnDirty] = useState(false);

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
            <button
              class={s.settings.geoEnabled ? 'on' : ''}
              onClick={() => {
                void saveSettings({ geoEnabled: true });
                sessionBus.stop();
                sessionBus.start();
              }}
            >
              On
            </button>
            <button
              class={!s.settings.geoEnabled ? 'on' : ''}
              onClick={() => {
                void saveSettings({ geoEnabled: false });
                sessionBus.stop();
                sessionBus.start();
              }}
            >
              Off
            </button>
          </div>
          <div style="font-size:11px;color:var(--fg-dim);margin-top:6px">
            Publishes a ~40m geohash cell so you see people nearby even behind carrier NAT.
            Rounded, ephemeral, never stored by the server.
          </div>
        </div>

        <div class="field">
          <label>Custom TURN server (optional cross-NAT relay)</label>
          <div style="display:flex;flex-direction:column;gap:6px">
            <input
              type="text"
              placeholder="turn:turn.example.com:3478"
              value={turnUrl}
              onInput={(e) => {
                setTurnUrl((e.target as HTMLInputElement).value);
                setTurnDirty(true);
              }}
            />
            <div style="display:flex;gap:6px">
              <input
                type="text"
                placeholder="Username (optional)"
                style="flex:1"
                value={turnUsername}
                onInput={(e) => {
                  setTurnUsername((e.target as HTMLInputElement).value);
                  setTurnDirty(true);
                }}
              />
              <input
                type="text"
                placeholder="Credential (optional)"
                style="flex:1"
                value={turnCredential}
                onInput={(e) => {
                  setTurnCredential((e.target as HTMLInputElement).value);
                  setTurnDirty(true);
                }}
              />
              <button
                disabled={!turnDirty}
                onClick={() => {
                  void saveSettings({
                    turnUrl: turnUrl.trim() || undefined,
                    turnUsername: turnUsername.trim() || undefined,
                    turnCredential: turnCredential.trim() || undefined,
                  });
                  setTurnDirty(false);
                  showToast('TURN configuration saved');
                }}
              >
                Save
              </button>
            </div>
          </div>
          <div style="font-size:11px;color:var(--fg-dim);margin-top:6px">
            Multi-STUN and automatic WebSocket relay fallback are built-in. Add a dedicated TURN server for high-bandwidth UDP relay across strict firewalls.
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
