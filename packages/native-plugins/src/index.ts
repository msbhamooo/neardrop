/**
 * @neardrop/native-plugins — Capacitor bridge for true offline nearby discovery.
 *
 * Transport priority (spec): native nearby > LAN WebRTC > QR fallback.
 * The web app picks automatically at boot.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';
import type { NearbyTransportPlugin as NearbyTransportDef, NativeFilePush as NativeFilePushDef } from './definitions.js';

export const NearbyTransportPlugin = registerPlugin<NearbyTransportDef>('NearbyTransport', {
  web: () => import('./web.js').then((m) => new m.WebNearbyTransport()),
});

export const NativeFilePushPlugin = registerPlugin<NativeFilePushDef>('NativeFilePush', {
  web: () => import('./web.js').then((m) => new m.WebNativeFilePush()),
});

export * from './definitions.js';

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

export type TransportKind = 'native' | 'lan-webrtc' | 'qr';

export interface TransportCapabilities {
  native: boolean;
  camera: boolean;
  online: boolean;
}

export function detectCapabilities(): TransportCapabilities {
  const native =
    Capacitor.isNativePlatform?.() === true &&
    (globalThis as unknown as { __NEARDROP_NATIVE__?: boolean }).__NEARDROP_NATIVE__ === true;
  return {
    native,
    camera: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    online: typeof navigator !== 'undefined' ? navigator.onLine : false,
  };
}

/** App boot: which discovery mode should the UI show? */
export function pickTransport(caps: TransportCapabilities): TransportKind {
  if (caps.native) return 'native';
  if (caps.online) return 'lan-webrtc';
  return 'qr';
}
