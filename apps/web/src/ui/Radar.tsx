import { useEffect, useRef, useState } from 'preact/hooks';
import { sessionBus, peers, transfers, pendingShare, showToast } from '../transfers.js';
import { Avatar } from './Avatar.js';
import { session, deviceType } from '../identity.js';
import { isPaired } from '../paired.js';
import { activeRoomCode } from '../signaling.js';

function peerProgress(peerId: string): number | undefined {
  let bytes = 0;
  let total = 0;
  for (const t of transfers.value.values()) {
    if (t.peerId === peerId && (t.status === 'active' || t.status === 'offering') && t.direction === 'send') {
      bytes = t.bytes;
      total = t.totalBytes;
    }
  }
  return total > 0 ? bytes / total : undefined;
}

export function Radar({ onOpenCrossNetwork }: { onOpenCrossNetwork: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dropTarget = useRef<string | '__ALL__' | null>(null);
  const [draggingPeerId, setDraggingPeerId] = useState<string | null>(null);

  const peerList = [...peers.value.values()];
  const myName = session.value?.settings.name ?? 'Me';
  const roomCode = activeRoomCode.value;

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      const list = [...peers.value.values()];
      if (list.length === 0) {
        showToast('Pasted file ready — connect a peer to send', true);
        pendingShare.value = files;
        return;
      }
      e.preventDefault();
      void sessionBus.sendFiles(list[0]!.info.id, files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const triggerPicker = (peerId: string | '__ALL__') => {
    dropTarget.current = peerId;
    if (pendingShare.value) {
      const files = pendingShare.value;
      pendingShare.value = null;
      if (peerId === '__ALL__') void sessionBus.sendFilesToAll(files);
      else void sessionBus.sendFiles(peerId, files);
      return;
    }
    fileInput.current?.click();
  };

  const onFilesChosen = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const target = dropTarget.current ?? [...peers.value.keys()][0];
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    if (target === '__ALL__') {
      void sessionBus.sendFilesToAll(files);
    } else if (target) {
      void sessionBus.sendFiles(target, files);
    } else {
      pendingShare.value = files;
      showToast(`${files.length} file(s) staged — tap a device when it appears`);
    }
  };

  return (
    <div class="radar-wrap">
      <div
        class="radar"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setDraggingPeerId(null);
          const files = [...(e.dataTransfer?.files ?? [])];
          if (peerList.length > 0 && files.length) void sessionBus.sendFiles(peerList[0]!.info.id, files);
        }}
      >
        <div class="ring" />
        <div class="ring r2" />
        <div class="pulse" />
        <div class="self-node">
          <span class="name">{myName}</span>
          <span>{roomCode ? `${deviceType} · ${roomCode}` : deviceType}</span>
        </div>
        {peerList.map((p, i) => {
          const angle = (i / Math.max(peerList.length, 5)) * Math.PI * 2 - Math.PI / 2 + 0.35;
          const radius = 36; // percent
          const x = 50 + radius * Math.cos(angle);
          const y = 50 + radius * Math.sin(angle);
          const progress = peerProgress(p.info.id);
          const viaLabel = p.link?.usingRelayFallback
            ? 'Relay'
            : p.info.via === 'room'
              ? 'Room'
              : p.info.via === 'contact'
                ? 'Contact'
                : p.info.via === 'geo'
                  ? 'Nearby'
                  : p.info.sameNetwork
                    ? 'LAN'
                    : 'Remote';
          return (
            <div
              class={`peer-node${draggingPeerId === p.info.id ? ' dragging' : ''}`}
              style={`left:${x}%;top:${y}%`}
              onClick={() => triggerPicker(p.info.id)}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingPeerId(p.info.id);
              }}
              onDragLeave={() => {
                if (draggingPeerId === p.info.id) setDraggingPeerId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingPeerId(null);
                const files = [...(e.dataTransfer?.files ?? [])];
                if (files.length) void sessionBus.sendFiles(p.info.id, files);
              }}
              key={p.info.id}
            >
              <Avatar
                name={p.info.name}
                deviceType={p.info.deviceType}
                id={p.info.id}
                progress={progress}
              />
              {isPaired(p.info.id) && (
                <span class="badge-paired">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              )}
              <span class="pname">{p.info.name}</span>
              <span class="pspeed">{viaLabel}</span>
            </div>
          );
        })}
        {peerList.length === 0 && (
          <div class="radar-empty">
            {pendingShare.value
              ? `${pendingShare.value.length} file(s) ready — waiting for recipient…`
              : 'Searching for nearby devices…'}
            <span style="font-size:11px;opacity:.7">
              Same Wi-Fi connects automatically. On different networks or mobile data?{' '}
              <button
                class="ghost"
                style="padding:2px 6px;font-size:11px;color:var(--accent);text-decoration:underline"
                onClick={onOpenCrossNetwork}
              >
                Use a Room Code
              </button>{' '}
              or Pair offline.
            </span>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          style="display:none"
          onChange={onFilesChosen}
        />
        <button
          class="ghost"
          style="position:absolute;right:8px;bottom:8px;font-size:11px"
          onClick={() => triggerPicker('__ALL__')}
        >
          + pick files for everyone
        </button>
      </div>
    </div>
  );
}
