/**
 * Offline pairing UI (Phase 3). Works with NO internet and no signaling server —
 * both devices just need the same Wi-Fi / one hotspot.
 *
 * Show code (offer QR) → other device scans (or paste) → they get an answer QR →
 * you scan (or paste) it → connected → identity handshake over DTLS → 4-emoji
 * verification → save as paired device → send/receive files.
 */
import { reportQrPair } from '../stats/index.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VerifiedPeerLike } from '@neardrop/core';
import {
  createOfflinePeerConnection, acceptOfflinePeerConnection,
  offerPayload, acceptOffer, acceptAnswer,
  renderQr, startScanner, runQrHandshake, isNearDropPayload,
  type QrChannels, type Scanner,
} from '../qr.js';
import { session, deviceType } from '../identity.js';
import { savePaired, isPaired, emojiForPair } from '../paired.js';
import { sessionBus, type TransferHost, showToast } from '../transfers.js';

type Mode =
  | { t: 'choose' }
  | { t: 'offer-qr' } // showing my offer QR (+ paste box for their reply)
  | { t: 'scan-answer' }
  | { t: 'scan-offer' }
  | { t: 'answer-qr' } // showing my answer QR after scanning/pasting their offer
  | { t: 'connected'; peer: VerifiedPeerLike }
  | { t: 'failed'; reason: string };

export function QrFlow({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>({ t: 'choose' });
  const [myPayload, setMyPayload] = useState(''); // my offer or answer payload
  const [pasteValue, setPasteValue] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [saved, setSaved] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelsRef = useRef<QrChannels | null>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showQr = mode.t === 'offer-qr' || mode.t === 'answer-qr';

  useEffect(() => {
    if (showQr && qrCanvasRef.current && myPayload) {
      void renderQr(qrCanvasRef.current, myPayload).catch((err) => showToast(`QR render failed: ${err}`, true));
    }
  }, [showQr, myPayload]);

  useEffect(() => {
    if (mode.t !== 'scan-answer' && mode.t !== 'scan-offer') return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    void startScanner(
      video,
      (text) => void handleScanned(text),
      (err) => showToast(`Camera error: ${err}`, true),
    ).then((s) => {
      if (cancelled) s.stop();
      else scannerRef.current = s;
    });
    return () => {
      cancelled = true;
      scannerRef.current?.stop();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.t]);

  const reset = (): void => {
    scannerRef.current?.stop();
    scannerRef.current = null;
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    channelsRef.current = null;
    setConnecting(false);
    setMyPayload('');
    setPasteValue('');
    setMode({ t: 'choose' });
  };

  const adoptHost = (channels: QrChannels, peer: VerifiedPeerLike): void => {
    sessionBus.registerOfflineHost({
      peerId: peer.deviceId,
      peer,
      control: channels.control,
      data: channels.data,
      consented: true,
    });
  };

  const watchPc = (pc: RTCPeerConnection, channels: QrChannels): void => {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        setConnecting(false);
        reportQrPair(false);
        setMode({
          t: 'failed',
          reason:
            'Direct connection failed. Routers that block mDNS or enable client isolation kill LAN WebRTC — a phone hotspot usually works.',
        });
      }
      if (pc.connectionState === 'connected') {
        const s = session.value!;
        setConnecting(true);
        runQrHandshake(channels, { identity: s.identity, name: s.settings.name, deviceType }, (peer) => {
          adoptHost(channels, peer);
          setSaved(isPaired(peer.deviceId));
          setConnecting(false);
          reportQrPair(true);
          setMode({ t: 'connected', peer });
          showToast(`Connected to ${peer.name} ✓`);
        });
      }
    });
  };

  // ---------------- I'm the offerer ----------------
  const startOfferer = async (): Promise<void> => {
    const channels = createOfflinePeerConnection();
    pcRef.current = channels.pc;
    channelsRef.current = channels;
    watchPc(channels.pc, channels);
    try {
      const payload = await offerPayload(channels.pc);
      setMyPayload(payload);
      setMode({ t: 'offer-qr' });
    } catch (err) {
      setMode({ t: 'failed', reason: String(err) });
    }
  };

  const finishOfferer = async (answerText: string): Promise<void> => {
    if (!pcRef.current || !isNearDropPayload(answerText.trim())) return;
    setConnecting(true);
    try {
      await acceptAnswer(pcRef.current, answerText.trim());
      // connectionstatechange → connected → handshake → 'connected' mode
    } catch (err) {
      setConnecting(false);
      showToast(`Invalid reply code: ${err}`, true);
    }
  };

  // ---------------- I'm the answerer ----------------
  const becomeAnswerer = async (offerText: string): Promise<void> => {
    const channels = acceptOfflinePeerConnection(new RTCPeerConnection({ iceServers: [] }));
    pcRef.current = channels.pc;
    channelsRef.current = channels;
    watchPc(channels.pc, channels);
    try {
      const answer = await acceptOffer(channels.pc, offerText.trim());
      setMyPayload(answer);
      setMode({ t: 'answer-qr' });
    } catch (err) {
      setMode({ t: 'failed', reason: `Couldn't read their code: ${String(err)}` });
    }
  };

  const handleScanned = async (text: string): Promise<void> => {
    if (!isNearDropPayload(text)) return;
    if (mode.t === 'scan-offer') {
      await becomeAnswerer(text);
    } else if (mode.t === 'scan-answer') {
      await finishOfferer(text);
    }
  };

  const peer = mode.t === 'connected' ? mode.peer : null;

  return (
    <div class="offline-flow">
      <div class="of-head">
        <button class="sh-btn" onClick={mode.t === 'choose' ? onDone : reset}>
          {mode.t === 'choose' ? 'Back' : 'Start over'}
        </button>
        <div>
          <h2 class="of-title">Connect without internet</h2>
          <p class="of-sub">Both devices must be on the same Wi-Fi, or one phone's hotspot.</p>
        </div>
      </div>

      {mode.t === 'choose' && (
        <>
          <div class="sh-list">
            <button class="sh-row" onClick={() => void startOfferer()}>
              <span class="sh-main">
                <span class="sh-name">Show a code on this device</span>
                <span class="sh-sub">The other device scans it with its camera</span>
              </span>
              <span class="sh-act">1</span>
            </button>
            <button class="sh-row" onClick={() => setMode({ t: 'scan-offer' })}>
              <span class="sh-main">
                <span class="sh-name">Scan the other device's code</span>
                <span class="sh-sub">Use this device's camera</span>
              </span>
              <span class="sh-act">2</span>
            </button>
            <button class="sh-row" onClick={() => void startOfferer()}>
              <span class="sh-main">
                <span class="sh-name">Copy and paste a code instead</span>
                <span class="sh-sub">For devices without a camera</span>
              </span>
              <span class="sh-act">3</span>
            </button>
          </div>
          <p class="of-note">
            It takes two steps: one device shows a code, the other scans it, then the first scans the reply.
            Everything is encrypted between the two devices.
          </p>
        </>
      )}

      {showQr && (
        <div class="of-step">
          <p class="of-instruction">
            {mode.t === 'offer-qr'
              ? 'Step 1. Have the other device scan this code, or copy and paste it to them.'
              : 'Show this code to the other device. This screen connects by itself when they scan it.'}
          </p>
          <div class="qr-card"><canvas ref={qrCanvasRef} /></div>
          <textarea
            class="sh-code-input of-text"
            readOnly
            rows={3}
            value={myPayload}
            aria-label="My code"
            onFocus={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <div class="sh-actions">
            <button class="sh-btn" onClick={() => void navigator.clipboard?.writeText(myPayload).then(() => showToast('Code copied'))}>
              Copy code
            </button>
          </div>
          {mode.t === 'offer-qr' && (
            <>
              <p class="of-instruction">Step 2. They will show you a reply code. Scan it or paste it here.</p>
              <textarea
                class="sh-code-input of-text"
                rows={3}
                placeholder="Paste their reply code here"
                onInput={(e) => setPasteValue((e.target as HTMLTextAreaElement).value)}
              />
              <div class="sh-actions">
                <button class="sh-btn" onClick={() => setMode({ t: 'scan-answer' })}>Scan their reply</button>
                <button class="sh-btn primary" disabled={!isNearDropPayload(pasteValue) || connecting} onClick={() => void finishOfferer(pasteValue)}>
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {(mode.t === 'scan-offer' || mode.t === 'scan-answer') && (
        <div class="of-step">
          <p class="of-instruction">
            {mode.t === 'scan-offer'
              ? 'Point the camera at the other device’s code. You will then get a reply code to show them.'
              : 'Point the camera at their reply code and keep this screen open.'}
          </p>
          <video class="of-video" ref={videoRef} playsinline muted />
          <p class="of-note">No camera? Go back and choose "Copy and paste".</p>
        </div>
      )}

      {mode.t === 'connected' && <ConnectedView peer={mode.peer} saved={saved} onSave={() => setSaved(true)} onSend={() => fileInputRef.current?.click()} onClose={onDone} fileInputRef={fileInputRef} channels={channelsRef.current} />}

      {mode.t === 'failed' && (
        <div class="of-step">
          <p class="of-error">{mode.reason}</p>
          <p class="of-note">
            Check that both devices are on the same network. Some routers block devices from seeing each other
            ("client isolation"); a phone hotspot usually works.
          </p>
          <div class="sh-actions"><button class="sh-btn" onClick={reset}>Try again</button></div>
        </div>
      )}
    </div>
  );
}

function ConnectedView({
  peer,
  saved,
  onSave,
  onSend,
  onClose,
  fileInputRef,
  channels,
}: {
  peer: VerifiedPeerLike;
  saved: boolean;
  onSave: () => void;
  onSend: () => void;
  onClose: () => void;
  fileInputRef: { current: HTMLInputElement | null };
  channels: QrChannels | null;
}): preact.VNode {
  const emojis = emojiForPair(session.value!.identity.deviceId, peer.deviceId);
  return (
    <div class="of-step">
      <h3 class="of-title">Connected to {peer.name}</h3>
      <p class="of-instruction">Check that the other device shows the same 4 symbols. If they match, nobody intercepted the connection.</p>
      <div class="emoji-code" aria-label="Verification symbols">
        {emojis.map((e, i) => (
          <span key={i}>{e}</span>
        ))}
      </div>
      <div class="sh-actions">
        <button class="sh-btn primary" onClick={onSend}>Send files</button>
        <button
          class="sh-btn"
          disabled={saved}
          onClick={() => {
            void savePaired(peer).then(() => {
              onSave();
              showToast('Device saved');
            });
          }}
        >
          {saved ? 'Saved as trusted' : 'Trust this device'}
        </button>
        <button class="sh-btn" onClick={onClose}>Done</button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style="display:none"
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const files = [...(input.files ?? [])];
          input.value = '';
          if (files.length && channels && channels.control.readyState === 'open') {
            void sessionBus.sendToHost(
              {
                peerId: peer.deviceId,
                peer,
                control: channels.control,
                data: channels.data,
                consented: true,
              } satisfies TransferHost,
              files,
            );
          }
        }}
      />
    </div>
  );
}
