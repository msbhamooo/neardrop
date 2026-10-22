/**
 * Offline pairing UI (Phase 3). Works with NO internet and no signaling server —
 * both devices just need the same Wi-Fi / one hotspot.
 *
 * Show code (offer QR) → other device scans (or paste) → they get an answer QR →
 * you scan (or paste) it → connected → identity handshake over DTLS → 4-emoji
 * verification → save as paired device → send/receive files.
 */
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
    <div class="qr-screen">
      <div style="display:flex;gap:8px;align-items:center;width:min(88vw,340px)">
        <button class="ghost" onClick={mode.t === 'choose' ? onDone : reset}>
          ← {mode.t === 'choose' ? 'Back' : 'Start over'}
        </button>
        <span style="flex:1;font-size:12px;color:var(--fg-dim)">Offline pairing · no internet needed</span>
      </div>

      {mode.t === 'choose' && (
        <div style="display:flex;flex-direction:column;gap:10px;width:min(88vw,340px)">
          <button class="primary" onClick={() => void startOfferer()}>
            Show my code
          </button>
          <button onClick={() => setMode({ t: 'scan-offer' })}>Scan their code</button>
          <button onClick={() => void startOfferer()}>
            Use copy &amp; paste instead
          </button>
          <div class="hint">
            Both devices must share a network (same Wi-Fi or one phone’s hotspot). One device shows a code,
            the other scans it (or copies it), then the first device scans the reply. Fully offline,
            end-to-end encrypted (DTLS).
          </div>
        </div>
      )}

      {showQr && (
        <>
          <canvas ref={qrCanvasRef} />
          <div class="hint">
            {mode.t === 'offer-qr'
              ? 'Have them scan this code — or copy/paste it. Then scan (or paste) their reply below.'
              : 'Show this code to the other device. Waiting for them to complete the handshake…'}
          </div>
          <div class="paste-box">
            <textarea
              readOnly
              value={myPayload}
              onFocus={(e) => void navigator.clipboard?.writeText(myPayload).then(() => showToast('Code copied'))}
              title="Tap to copy"
            />
            <div class="row-actions" style="margin-top:8px">
              <button
                class="primary"
                onClick={() => void navigator.clipboard?.writeText(myPayload).then(() => showToast('Code copied'))}
              >
                Copy my code
              </button>
            </div>
          </div>
          {mode.t === 'offer-qr' && (
            <div class="paste-box">
              <textarea
                placeholder="Paste their reply code here…"
                onChange={(e) => setPasteValue((e.target as HTMLTextAreaElement).value)}
              />
              <div class="row-actions" style="margin-top:8px">
                <button onClick={() => setMode({ t: 'scan-answer' })}>Scan their reply</button>
                <button class="primary" disabled={!isNearDropPayload(pasteValue)} onClick={() => void finishOfferer(pasteValue)}>
                  Use pasted reply
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {(mode.t === 'scan-offer' || mode.t === 'scan-answer') && (
        <>
          <video ref={videoRef} playsinline muted />
          <div class="hint">
            {mode.t === 'scan-offer'
              ? 'Point the camera at their code. You’ll get your own code to show them right after.'
              : 'Point the camera at their reply code. Keep this screen until it connects.'}
            <br />
            No camera? Go back and use copy &amp; paste.
          </div>
        </>
      )}

      {mode.t === 'connected' && <ConnectedView peer={mode.peer} saved={saved} onSave={() => setSaved(true)} onSend={() => fileInputRef.current?.click()} onClose={onDone} fileInputRef={fileInputRef} channels={channelsRef.current} />}

      {mode.t === 'failed' && (
        <>
          <div class="hint" style="color:var(--danger)">
            {mode.reason}
          </div>
          <div class="hint">
            Troubleshooting: check both devices share the same network, disable “AP/client isolation” on the
            router, or use a phone hotspot. Native shells (Phase 4) remove this dance entirely.
          </div>
          <button onClick={reset}>Try again</button>
        </>
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
    <div style="display:flex;flex-direction:column;gap:10px;width:min(88vw,340px);align-items:center">
      <h3 style="margin:4px 0 0">Connected to {peer.name}</h3>
      <div class="emoji-code">
        {emojis.map((e, i) => (
          <span key={i}>{e}</span>
        ))}
      </div>
      <div class="hint">
        Make sure the other device shows the <b>same 4 emojis</b> — that proves nobody intercepted the
        pairing. Then save the pairing so they’re trusted next time.
      </div>
      <button
        class="primary"
        disabled={saved}
        onClick={() => {
          void savePaired(peer).then(() => {
            onSave();
            showToast('Paired ✓');
          });
        }}
      >
        {saved ? 'Paired ✓' : 'Save as paired device'}
      </button>
      <button onClick={onSend}>Send files…</button>
      <button class="ghost" onClick={onClose}>
        Close (stay connected)
      </button>
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
