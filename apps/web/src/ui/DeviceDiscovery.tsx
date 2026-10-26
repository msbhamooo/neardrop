import { useEffect, useRef, useState } from 'preact/hooks';
import { peers, transfers, pendingShare, sessionBus, showToast } from '../transfers.js';
import { session, deviceType } from '../identity.js';
import { isPaired } from '../paired.js';
import { humanBytes } from './IncomingSheet.js';
import { DeviceIcon, UploadIcon, DownloadIcon, CloseIcon, QrCodeIcon } from './icons.js';
import { humanDeviceLabel } from '../device.js';
import { disambiguatePeers, getDeviceTheme, showOwnTabs } from '../naming.js';
import type { StagedSend } from './SendConfirmationSheet.js';
import { linkDraft, activeShare, linkRoom } from '../share.js';
import { flattenFolder } from '../files.js';


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

export function DeviceDiscovery({
  onStageSend,
  onOpenRoomModal,
}: {
  onStageSend: (staged: StagedSend) => void;
  onOpenRoomModal: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetPeerRef = useRef<{ id: string; name: string; deviceType: string } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [hoveredPeerId, setHoveredPeerId] = useState<string | null>(null);
  const [multi, setMulti] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const linkModeRef = useRef(false);
  const folderRef = useRef<HTMLInputElement>(null);

  const rawPeerList = [...peers.value.values()];
  const myId = session.value?.identity.deviceId ?? '';
  const myName = session.value?.settings.name ?? 'My Device';
  const myTypeLabel = humanDeviceLabel(deviceType);
  const myTheme = getDeviceTheme(myId || myName);
  // Other tabs of this same browser are not real destinations; hide them (dev: localStorage nd.showTabs=1).
  const peerList = disambiguatePeers(rawPeerList, myId, myName).filter((p) => !p.isSameDeviceTab || showOwnTabs());
  const stagedFiles = pendingShare.value;
  const stagedBytes = stagedFiles?.reduce((acc, f) => acc + (Number.isFinite(f.size) ? f.size : 0), 0) ?? 0;

  // Handle clipboard paste of photos/files
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();

      if (peerList.length === 1) {
        const p = peerList[0]!;
        onStageSend({
          peerId: p.info.id,
          peerName: p.displayName,
          deviceType: p.info.deviceType,
          files,
        });
      } else {
        pendingShare.value = files;
        showToast(`${files.length} file(s) ready — tap a device to send`);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [peerList, onStageSend]);


  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const sendToIds = (ids: string[]) => {
    const files = pendingShare.value;
    if (!files || !ids.length) return;
    pendingShare.value = null;
    setMulti(false);
    setSelected(new Set());
    void Promise.allSettled(ids.map((id) => sessionBus.sendFiles(id, files)));
    showToast(`Sending to ${ids.length} device${ids.length === 1 ? '' : 's'}`);
  };

  const handleDeviceClick = (peer: { id: string; name: string; deviceType: string }) => {
    if (multi && pendingShare.value) {
      toggleSelected(peer.id);
      return;
    }
    if (pendingShare.value && pendingShare.value.length > 0) {
      const files = pendingShare.value;
      pendingShare.value = null;
      onStageSend({
        peerId: peer.id,
        peerName: peer.name,
        deviceType: peer.deviceType,
        files,
      });
      return;
    }

    targetPeerRef.current = peer;
    fileInputRef.current?.click();
  };

  const handleGenericFileSelect = () => {
    targetPeerRef.current = null;
    fileInputRef.current?.click();
  };

  const onFileInputChanged = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    const files = input === folderRef.current ? flattenFolder(picked) : picked;
    input.value = '';
    if (!files.length) return;
    if (linkModeRef.current) {
      linkModeRef.current = false;
      linkDraft.value = files;
      return;
    }

    const target = targetPeerRef.current;
    if (target) {
      onStageSend({
        peerId: target.id,
        peerName: target.name,
        deviceType: target.deviceType,
        files,
      });
    } else if (peerList.length === 1) {
      const p = peerList[0]!;
      onStageSend({
        peerId: p.info.id,
        peerName: p.info.name,
        deviceType: p.info.deviceType,
        files,
      });
    } else {
      pendingShare.value = files;
      showToast(`${files.length} file(s) ready — tap a device to send`);
    }
  };

  const handleGlobalDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;

    if (peerList.length === 1) {
      const p = peerList[0]!;
      onStageSend({
        peerId: p.info.id,
        peerName: p.info.name,
        deviceType: p.info.deviceType,
        files,
      });
    } else {
      pendingShare.value = files;
      showToast(`${files.length} file(s) ready — tap a device to send`);
    }
  };

  return (
    <div
      class={`discovery-canvas ${isDraggingOver ? 'dragging-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDraggingOver(false);
        }
      }}
      onDrop={handleGlobalDrop}
    >
      {/* Hidden native multi-file picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style="display:none"
        onChange={onFileInputChanged}
      />

      <input
        ref={folderRef}
        type="file"
        {...({ webkitdirectory: '' } as Record<string, string>)}
        style="display:none"
        onChange={onFileInputChanged}
      />

      {/* Global Drag-and-drop overlay */}
      {isDraggingOver && (
        <div class="drag-overlay">
          <div class="drag-overlay-box">
            <span class="drag-icon-wrap">
              <DownloadIcon size={36} className="drag-icon-svg" />
            </span>
            <h3 class="drag-title">Drop files to share</h3>
            <p class="drag-subtitle">Release anywhere to send to nearby devices</p>
          </div>
        </div>
      )}

      {/* Staged files top alert */}
      {stagedFiles && stagedFiles.length > 0 && (
        <div class="staged-banner">
          <div class="staged-banner-info">
            <span class="staged-icon-wrap">
              <UploadIcon size={16} />
            </span>
            <div class="staged-text-group">
              <strong class="staged-count">{stagedFiles.length} {stagedFiles.length === 1 ? 'file' : 'files'} ready</strong>
              <span class="staged-size">({humanBytes(stagedBytes)}) · {multi ? 'Tap devices to select them' : 'Tap a device to send'}</span>
            </div>
          </div>
          {peerList.length > 1 && (
            <div class="staged-multi">
              {multi ? (
                <button
                  class="btn-choose-files staged-mini"
                  disabled={selected.size === 0}
                  onClick={() => sendToIds([...selected])}
                >
                  Send to {selected.size} selected
                </button>
              ) : (
                <button class="btn-choose-files staged-mini" onClick={() => setMulti(true)}>
                  Select devices
                </button>
              )}
              <button class="btn-choose-files staged-mini" onClick={() => sendToIds(peerList.map((p) => p.info.id))}>
                All ({peerList.length})
              </button>
            </div>
          )}
          <button
            class="staged-clear-btn"
            onClick={() => { pendingShare.value = null; setMulti(false); setSelected(new Set()); }}
            aria-label="Cancel selection"
            title="Cancel selection"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {/* Architectural Radar Canvas Grid & Coordinate Rings */}
      <div class="radar-viewport">
        {/* Radar Background Rings & Crosshairs */}
        <div class="radar-grid-layer" aria-hidden="true">
          <div class="radar-crosshair crosshair-x" />
          <div class="radar-crosshair crosshair-y" />
          <div class="radar-ring ring-inner" />
          <div class="radar-ring ring-middle" />
          <div class="radar-ring ring-outer" />
          
          {/* Subtle rotating scanning beam */}
          <div class="radar-scanner">
            <div class="radar-sweep-beam" />
          </div>

          {/* Harmonic acoustic ripples */}
          <div class="radar-harmonic-ripple ripple-1" />
          <div class="radar-harmonic-ripple ripple-2" />
        </div>

        {/* Center node: You */}
        <div class="self-device-anchor">
          <div
            class="self-device-halo"
            style={`background: radial-gradient(circle, ${myTheme.glow} 0%, transparent 72%);`}
          />
          <div
            class="self-device-circle"
            style={`border-color: ${myTheme.border}; box-shadow: 0 0 20px ${myTheme.glow}; color: ${myTheme.accent};`}
          >
            <DeviceIcon type={deviceType} size={30} className="self-device-icon" />
          </div>
          <div class="self-device-text">
            <span class="self-device-name">{myName}</span>
            <span class="self-device-type">You · {myTypeLabel}</span>
          </div>
        </div>

        {/* Surrounding discovered devices */}
        {peerList.map((p, i) => {
          const totalPeers = Math.max(peerList.length, 3);
          const angle = (i / totalPeers) * Math.PI * 2 - Math.PI / 2;
          const radiusPercent = peerList.length === 1 ? 38 : 42; // distance from center
          const leftPercent = 50 + radiusPercent * Math.cos(angle);
          const topPercent = 50 + radiusPercent * Math.sin(angle);
          const progress = peerProgress(p.info.id);
          const paired = isPaired(p.info.id);

          return (
            <button
              key={p.info.id}
              type="button"
              class={`peer-card-node ${selected.has(p.info.id) ? 'selected' : ''} ${hoveredPeerId === p.info.id ? 'hovered' : ''} ${p.isSameDeviceTab ? 'is-tab-peer' : ''}`}
              style={`left: ${leftPercent}%; top: ${topPercent}%; animation-delay: ${i * 80}ms;`}
              onClick={() => handleDeviceClick(p.info)}
              onMouseEnter={() => setHoveredPeerId(p.info.id)}
              onMouseLeave={() => setHoveredPeerId(null)}
              aria-label={`Send files to ${p.displayName}`}
            >
              {/* Expanding ping ring on discovery with theme color */}
              <div
                class="peer-discovery-ping"
                style={`border-color: ${p.theme.border};`}
              />

              <div class="peer-avatar-wrapper">
                <div
                  class="peer-avatar-circle"
                  style={`border-color: ${p.theme.border}; background: ${p.theme.bg}; color: ${p.theme.accent}; box-shadow: 0 0 16px ${p.theme.glow};`}
                >
                  <DeviceIcon type={p.info.deviceType} size={28} className="peer-device-icon" />
                </div>
                {paired && (
                  <span class="peer-badge-paired" title="Paired device">
                    ✓
                  </span>
                )}
                {p.isSameDeviceTab && (
                  <span class="peer-badge-tab" title="Another tab on this device">
                    Tab
                  </span>
                )}
                {progress !== undefined && (
                  <svg class="peer-progress-ring" viewBox="0 0 76 76">
                    <circle cx="38" cy="38" r="34" class="ring-bg" />
                    <circle
                      cx="38"
                      cy="38"
                      r="34"
                      class="ring-fill"
                      style={`stroke: ${p.theme.accent}; stroke-dashoffset: ${213.6 * (1 - progress)}`}
                    />
                  </svg>
                )}
              </div>
              <div class="peer-card-labels">
                <span class="peer-card-name">{p.displayName}</span>
                <span class="peer-card-action">
                  {progress !== undefined ? `${Math.round(progress * 100)}%` : p.subtitle}
                </span>
              </div>
            </button>
          );
        })}


        {/* Elegant, calm empty state when 0 peers found */}
        {peerList.length === 0 && (
          <div class="discovery-empty-state">
            <div class="empty-status-beacon">
              <span class="empty-status-dot" />
              <span class="empty-status-text">Scanning for devices…</span>
            </div>
            
            <p class="empty-desc">
              Open NearDrop on any other device nearby to send or receive files instantly.
            </p>

            <div class="empty-actions-row">
              <button
                class="btn-choose-files"
                onClick={handleGenericFileSelect}
              >
                <UploadIcon size={16} />
                <span>Select files to send</span>
              </button>

              {!activeShare.value && !linkRoom.value && (
                <button class="btn-room-hint" onClick={() => { linkModeRef.current = true; targetPeerRef.current = null; fileInputRef.current?.click(); }}>
                  <span>Get a link</span>
                </button>
              )}
              <button
                class="btn-room-hint"
                onClick={onOpenRoomModal}
                title="Connect with devices on a different network"
              >
                <QrCodeIcon size={15} />
                <span>Different network?</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Always-available picker so sending never depends on tapping the right device */}
      {peerList.length > 0 && !stagedFiles && (
        <div class="radar-send-bar">
          <button class="btn-choose-files" onClick={handleGenericFileSelect}>
            <UploadIcon size={16} />
            <span>{peerList.length === 1 ? `Send files to ${peerList[0]!.displayName}` : 'Choose files to send'}</span>
          </button>
          <button class="btn-room-hint" onClick={() => folderRef.current?.click()}>
            <span>Folder</span>
          </button>
          {!activeShare.value && !linkRoom.value && (
            <button class="btn-room-hint" onClick={() => { linkModeRef.current = true; targetPeerRef.current = null; fileInputRef.current?.click(); }}>
              <span>Get a link</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
