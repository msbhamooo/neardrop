import { useEffect, useRef, useState } from 'preact/hooks';
import { peers, pendingShare, showToast, sessionBus } from '../transfers.js';
import { session } from '../identity.js';
import { activeRoomCode, connState } from '../signaling.js';
import { disambiguatePeers, showOwnTabs } from '../naming.js';
import { humanDeviceLabel } from '../device.js';
import { DeviceIcon } from './icons.js';
import { humanBytes } from './IncomingSheet.js';
import { makeRoomCode } from '../roomcode.js';
import { activeShare, linkRoom, startShare, stopShare, leaveLinkRoom } from '../share.js';
import type { StagedSend } from './SendConfirmationSheet.js';

/**
 * Plain list home: choose files, pick a nearby device, done.
 * Same-network devices appear automatically; other networks use a short spoken code.
 */
export function SimpleHome({
  onStageSend,
  onRename,
  onToggleView,
}: {
  onStageSend: (s: StagedSend) => void;
  onRename: () => void;
  onToggleView: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const targetRef = useRef<string | null>(null);
  const linkModeRef = useRef(false);
  const [over, setOver] = useState(false);
  const [joinCode, setJoinCode] = useState('');

  const myId = session.value?.identity.deviceId ?? '';
  const myName = session.value?.settings.name ?? 'This device';
  const list = disambiguatePeers([...peers.value.values()], myId, myName).filter((p) => !p.isSameDeviceTab || showOwnTabs());
  const waiting = pendingShare.value;
  const room = activeRoomCode.value;
  const online = connState.value === 'online';

  const stage = (p: (typeof list)[number], files: File[]) =>
    onStageSend({ peerId: p.info.id, peerName: p.displayName, deviceType: p.info.deviceType, files });

  // One device found: send straight to it. Otherwise hold the files and let the user pick.
  const route = (files: File[], peerId?: string | null) => {
    if (!files.length) return;
    const target = peerId ? list.find((p) => p.info.id === peerId) : list.length === 1 ? list[0] : undefined;
    if (target) stage(target, files);
    else pendingShare.value = files;
  };

  const onPicked = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    if (linkModeRef.current) {
      linkModeRef.current = false;
      if (files.length) void makeLink(files);
      return;
    }
    route(files, targetRef.current);
    targetRef.current = null;
  };

  const chooseFor = (peerId: string) => {
    if (waiting?.length) {
      pendingShare.value = null;
      route(waiting, peerId);
    } else {
      targetRef.current = peerId;
      input.current?.click();
    }
  };

  const invite = () => {
    if (!room) sessionBus.setRoomCode(makeRoomCode());
  };

  const copyInvite = async () => {
    const url = `${location.origin}${location.pathname}?room=${activeRoomCode.value}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(`Code: ${activeRoomCode.value}`);
    }
  };

  const join = () => {
    const code = joinCode.trim();
    if (code.length < 3) return;
    sessionBus.setRoomCode(code);
    setJoinCode('');
  };

  // Paste files/screenshots from the clipboard (Ctrl/Cmd+V).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      route(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const share = activeShare.value;
  const viaLink = linkRoom.value;

  const makeLink = async (files: File[]) => {
    pendingShare.value = null;
    startShare(files);
    try {
      await navigator.clipboard.writeText(activeShare.value!.url);
      showToast('Link copied. Keep this tab open until they have the files.');
    } catch { /* user can copy from the box */ }
  };

  const sendAll = (files: File[]) => {
    const targets = list.filter((p) => !p.isSameDeviceTab);
    pendingShare.value = null;
    void Promise.allSettled(targets.map((p) => sessionBus.sendFiles(p.info.id, files)));
    showToast(`Sending to ${targets.length} devices`);
  };

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(share!.url);
      showToast('Link copied');
    } catch {
      showToast('Select the link and copy it', true);
    }
  };

  const waitingBytes = waiting?.reduce((n, f) => n + f.size, 0) ?? 0;

  return (
    <div class="simple-home">
      <input ref={input} type="file" multiple style="display:none" onChange={onPicked} />

      {viaLink && (
        <section class="sh-section" aria-live="polite">
          <div class="sh-label">Shared with you</div>
          <div class="sh-banner">
            <span>
              {list.length
                ? 'Connected to the sender. An offer will appear in a moment, tap Accept to receive.'
                : 'Waiting for the sender. They need to keep NearDrop open on their device.'}
            </span>
            <button class="sh-link" onClick={leaveLinkRoom}>Leave</button>
          </div>
        </section>
      )}

      <section class="sh-section">
        <div class="sh-label">Send</div>
        {share ? (
          <div class="sh-panel" aria-live="polite">
            <p>
              Sharing {share.files.length === 1 ? share.files[0]!.name : `${share.files.length} files`}.
              Anyone who has this link can receive it, so send it only to people you trust.
              Keep this tab open until they have the files.
            </p>
            <input class="sh-code-input" readOnly value={share.url} onFocus={(e) => (e.target as HTMLInputElement).select()} aria-label="Share link" />
            <div class="sh-actions">
              <button class="sh-btn" onClick={copyShare}>Copy link</button>
              <button class="sh-btn" onClick={stopShare}>Stop sharing</button>
            </div>
            <p class="sh-sub">{share.served === 0 ? 'Nobody has opened it yet.' : `Offered to ${share.served} device${share.served === 1 ? '' : 's'}.`}</p>
          </div>
        ) : waiting ? (
          <div class="sh-banner" aria-live="polite">
            <span>
              {waiting.length === 1 ? waiting[0]!.name : `${waiting.length} files`} ({humanBytes(waitingBytes)}) &mdash; choose a device below
            </span>
            <span class="sh-actions">
              {list.filter((p) => !p.isSameDeviceTab).length > 1 && (
                <button class="sh-btn" onClick={() => sendAll(waiting)}>
                  Send to all ({list.filter((p) => !p.isSameDeviceTab).length})
                </button>
              )}
              <button class="sh-btn" onClick={() => void makeLink(waiting)}>Get a link</button>
              <button class="sh-link" onClick={() => (pendingShare.value = null)}>Clear</button>
            </span>
          </div>
        ) : (
          <div
            class={`sh-drop${over ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              route([...(e.dataTransfer?.files ?? [])]);
            }}
          >
            <p>
              Drop files here
              <small>Photos, videos and documents of any size. Nothing is uploaded to a server.</small>
            </p>
            <span class="sh-actions">
              <button class="sh-btn" onClick={() => { targetRef.current = null; input.current?.click(); }}>
                Choose files
              </button>
              <button class="sh-btn" title="Share a link instead of picking a nearby device" onClick={() => { linkModeRef.current = true; input.current?.click(); }}>
                Get a link
              </button>
            </span>
          </div>
        )}
      </section>

      <section class="sh-section">
        <div class="sh-label">{room ? 'Devices in your room' : 'Devices on this network'}</div>
        <div class="sh-list">
          {list.length === 0 ? (
            <p class="sh-empty">
              {online
                ? 'No other devices yet. Open NearDrop on the other device and connect it to the same Wi-Fi.'
                : 'Connecting…'}
            </p>
          ) : (
            list.map((p) => (
              <button key={p.info.id} class="sh-row" onClick={() => chooseFor(p.info.id)}>
                <DeviceIcon type={p.info.deviceType} size={22} />
                <span class="sh-main">
                  <span class="sh-name">{p.displayName}</span>
                  <span class="sh-sub">{humanDeviceLabel(p.info.deviceType)}</span>
                </span>
                <span class="sh-act">{waiting ? 'Send here' : 'Send files'}</span>
              </button>
            ))
          )}
        </div>
      </section>

      {!share && !viaLink && (
      <details class="sh-details" open={!!room}>
        <summary>Not on the same network?</summary>
        {room ? (
          <>
            <p class="sh-sub">Share this code, or the link, with the other person. They enter it on their device.</p>
            <div class="sh-code">{room}</div>
            <div class="sh-actions">
              <button class="sh-btn" onClick={copyInvite}>Copy link</button>
              <button class="sh-btn" onClick={() => sessionBus.setRoomCode(undefined)}>Leave room</button>
            </div>
          </>
        ) : (
          <>
            <div class="sh-actions">
              <button class="sh-btn" onClick={invite}>Create a code</button>
            </div>
            <div class="sh-actions">
              <input
                class="sh-input"
                placeholder="Or enter a code"
                value={joinCode}
                maxLength={24}
                onInput={(e) => setJoinCode((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && join()}
                aria-label="Room code"
              />
              <button class="sh-btn" onClick={join} disabled={joinCode.trim().length < 3}>Join</button>
            </div>
          </>
        )}
      </details>
      )}

      <div class="sh-foot">
        <span>
          Visible as <strong>{myName}</strong> &middot;{' '}
          <button class="sh-link" onClick={onRename}>Rename</button>
        </span>
        <button class="sh-link" onClick={onToggleView}>Switch to radar view</button>
      </div>
    </div>
  );
}
