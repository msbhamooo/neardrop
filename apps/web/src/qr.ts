/**
 * Offline pairing (Phase 3): no signaling server, no internet — only a shared LAN
 * or hotspot. Full offer/answer over QR codes + copy-paste fallback.
 *
 * Flow (spec): create RTCPeerConnection with `iceServers: []`, wait for ICE
 * gathering, minify SDP → deflate → base45 → QR (alphanumeric mode, <400 chars target).
 * The second scan is inherent to offer/answer without a backchannel (documented
 * limitation — removed in Phase 4 native shell).
 */
import QRCode from 'qrcode';
import {
  parseSdp, buildSdp, encodePayload, decodePayload,
  Handshake, encodeControl,
  type CompactSdp, type Deflate, type Inflate,
} from '@neardrop/core';

export const QR_PREFIX = 'NEARDROP1:';

const deflate: Deflate = async (bytes) => pipe(bytes, 'deflate');
const inflate: Inflate = async (bytes) => pipe(bytes, 'inflate');

async function pipe(bytes: Uint8Array, direction: 'deflate' | 'inflate'): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(
    direction === 'deflate' ? new CompressionStream('gzip') : new DecompressionStream('gzip'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Wait for full ICE gathering (no trickle) with a safety timeout. */
export function waitGathered(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** QRable string for an offerer's local description. */
export async function offerPayload(pc: RTCPeerConnection): Promise<string> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitGathered(pc);
  const sdp = pc.localDescription!.sdp;
  const payload = await encodePayload(parseSdp(sdp), deflate);
  return QR_PREFIX + payload;
}

/** Build the answerer's pc from a scanned/pasted offer payload; returns its own payload. */
export async function acceptOffer(pc: RTCPeerConnection, payload: string): Promise<string> {
  const compact = await decodePayload(stripPrefix(payload), inflate);
  await pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(compact) });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitGathered(pc);
  const out = await encodePayload(parseSdp(pc.localDescription!.sdp), deflate);
  return QR_PREFIX + out;
}

/** Offerer completes the handshake from the scanned/pasted answer payload. */
export async function acceptAnswer(pc: RTCPeerConnection, payload: string): Promise<void> {
  const compact = await decodePayload(stripPrefix(payload), inflate);
  await pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(compact) });
}

export const stripPrefix = (s: string): string => (s.startsWith(QR_PREFIX) ? s.slice(QR_PREFIX.length) : s.trim());
export const isNearDropPayload = (s: string): boolean => s.startsWith(QR_PREFIX);

// ---------------------------------------------------------------------------
// QR rendering & camera scanning
// ---------------------------------------------------------------------------

export async function renderQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: 'M', margin: 2, scale: 6, color: { dark: '#0b1220', light: '#ffffff' } });
}

export interface Scanner {
  stop(): void;
}

export function startScanner(
  video: HTMLVideoElement,
  onPayload: (text: string) => void,
  onError?: (err: string) => void,
): Promise<Scanner> {
  return new Promise((resolve, reject) => {
    let stream: MediaStream | null = null;
    let worker: Worker | null = null;
    let raf = 0;
    let lastDecode = 0;
    let stopped = false;

    const cleanup = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      worker?.terminate();
      worker = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        stream = s;
        video.srcObject = s;
        void video.play();
        worker = new Worker(new URL('./qr-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent) => {
          const res = e.data as { text: string } | null;
          if (res?.text && isNearDropPayload(res.text)) {
            cleanup();
            onPayload(res.text);
          }
        };
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const tick = () => {
          if (stopped) return;
          if (video.videoWidth > 0 && Date.now() - lastDecode > 66) {
            // ~15fps decode
            lastDecode = Date.now();
            const w = Math.min(video.videoWidth, 640);
            const h = Math.round((video.videoHeight / video.videoWidth) * w);
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h);
            worker?.postMessage({ data: data.data, width: w, height: h }, [data.data.buffer]);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        resolve({ stop: cleanup });
      })
      .catch((err) => {
        onError?.(String(err?.name ?? err));
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// Offline pairing session — wires a QR-negotiated RTCPeerConnection into the
// same identity handshake used online, so pairing keys travel the same channel.
// ---------------------------------------------------------------------------

export interface QrChannels {
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  data: RTCDataChannel[];
}

export function createOfflinePeerConnection(): QrChannels {
  const pc = new RTCPeerConnection({ iceServers: [] }); // LAN only, by design
  const control = pc.createDataChannel('control');
  const data: RTCDataChannel[] = [];
  for (let i = 0; i < 4; i++) {
    const ch = pc.createDataChannel(`data-${i}`);
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 1024 * 1024;
    data.push(ch);
  }
  return { pc, control, data };
}

export function acceptOfflinePeerConnection(pc: RTCPeerConnection): QrChannels {
  const out: QrChannels = { pc, control: null as unknown as RTCDataChannel, data: [] };
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    if (ch.label === 'control') {
      out.control = ch;
    } else {
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 1024 * 1024;
      out.data.push(ch);
    }
  };
  return out;
}

/** Run the identity handshake over a QR-connected control channel. */
export function runQrHandshake(
  channels: QrChannels,
  identity: { identity: import('@neardrop/core').Identity; name: string; deviceType: string },
  onVerified: (peer: import('@neardrop/core').VerifiedPeerLike) => void,
): void {
  const hs = new Handshake(identity as never);
  channels.control.addEventListener('open', () => {
    hs.start((m) => {
      try { channels.control.send(encodeControl(m as never)); } catch { /* gone */ }
    });
  });
  channels.control.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(String(e.data));
      if (hs.handle(msg)) return;
    } catch { /* not json */ }
  });
  hs.result.then(onVerified).catch(() => undefined);
}
