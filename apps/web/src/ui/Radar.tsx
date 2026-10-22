import { useRef } from 'preact/hooks';
import { sessionBus, peers, transfers, pendingShare } from '../transfers.js';
import { Avatar, iconFor } from './Avatar.js';
import { session, deviceType } from '../identity.js';
import { isPaired } from '../paired.js';

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

export function Radar({ onOpenPicker }: { onOpenPicker: (peerId: string | null) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dropTarget = useRef<string | null>(null);

  const peerList = [...peers.value.values()];
  const myName = session.value?.settings.name ?? 'Me';

  const triggerPicker = (peerId: string) => {
    dropTarget.current = peerId;
    if (pendingShare.value) {
      // files came in via the system share sheet — send without a picker
      const files = pendingShare.value;
      pendingShare.value = null;
      void sessionBus.sendFiles(peerId, files);
      return;
    }
    fileInput.current?.click();
  };

  const onFilesChosen = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const peerId = dropTarget.current ?? [...peers.value.keys()][0];
    const files = [...(input.files ?? [])];
    input.value = '';
    if (peerId && files.length) void sessionBus.sendFiles(peerId, files);
  };

  return (
    <div class="radar-wrap">
      <div
        class="radar"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = [...(e.dataTransfer?.files ?? [])];
          if (peerList.length > 0 && files.length) void sessionBus.sendFiles(peerList[0]!.info.id, files);
        }}
      >
        <div class="ring" />
        <div class="ring r2" />
        <div class="pulse" />
        <div class="self-node">
          <span class="name">{myName}</span>
          <span>{deviceType}</span>
        </div>
        {peerList.map((p, i) => {
          const angle = (i / Math.max(peerList.length, 5)) * Math.PI * 2 - Math.PI / 2 + 0.35;
          const radius = 36; // percent
          const x = 50 + radius * Math.cos(angle);
          const y = 50 + radius * Math.sin(angle);
          const progress = peerProgress(p.info.id);
          return (
            <div
              class="peer-node"
              style={`left:${x}%;top:${y}%`}
              onClick={() => triggerPicker(p.info.id)}
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
            </div>
          );
        })}
        {peerList.length === 0 && (
          <div class="radar-empty">
            {pendingShare.value ? 'Choose the device you shared to' : 'Searching for nearby devices…'}
            <span style="font-size:11px;opacity:.7">
              They must have NearDrop open on the same network. Offline? Use “Pair offline”.
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
          onClick={() => onOpenPicker(null)}
        >
          + pick files for everyone
        </button>
      </div>
    </div>
  );
}
