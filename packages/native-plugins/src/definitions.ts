/**
 * NearDrop native transport definitions (Phase 4).
 *
 * The web transfer engine (/packages/core) is transport-agnostic: it only needs
 * RTCDataChannel-like objects. These interfaces bridge native radios
 * (Google Nearby Connections on Android, MultipeerConnectivity on iOS) into that shape.
 */
import type { DeviceType, FileMeta } from '@neardrop/core';

export interface DeviceInfo {
  /** stable device id — use the same public-key fingerprint as the web identity */
  id: string;
  name: string;
  deviceType: DeviceType;
}

export interface NearbyPeer {
  id: string;
  name: string;
  deviceType: DeviceType;
  /** transport-specific handle used for connect() */
  endpointId: string;
}

/** Event payloads emitted while advertising/discovering. */
export interface NearbyEvents {
  peerFound: NearbyPeer;
  peerLost: { id: string };
}

/**
 * The native discovery half. Mirrors the spec:
 *   startAdvertising / startDiscovery / onPeerFound / onPeerLost / connect / stop
 */
export interface NearbyTransportPlugin {
  startAdvertising(info: DeviceInfo): Promise<void>;
  stopAdvertising(): Promise<void>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  onPeerFound(cb: (peer: NearbyPeer) => void): Promise<void>;
  onPeerLost(cb: (peer: { id: string }) => void): Promise<void>;
  /** Returns a channel id the JS side uses for control messages. */
  connect(peerId: string): Promise<{ channelId: string }>;
  disconnect(channelId: string): Promise<void>;
  /** raw bytes over the control channel (JSON protocol messages) */
  send(channelId: string, data: string): Promise<void>;
  /** called repeatedly by the plugin: incoming control messages */
  onMessage(cb: (event: { channelId: string; data: string }) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * HIGH-THROUGHPUT file path. Pushing 40+MB/s through the Capacitor bridge is not
 * realistic (serialized IPC per message); the native side streams files directly:
 *
 *   Android: Nearby Connections Payload.STREAM
 *   iOS:     MCSession.sendResource
 *
 * `progress` events keep the JS UI live, but bytes never cross the bridge.
 */
export interface NativeFilePush {
  /** can this device push files natively (without JS-bridged chunks)? */
  supported(): Promise<boolean>;
  /** fileUris: content:// (Android) or file:// URLs (iOS share extension sandbox) */
  sendFilesNative(
    peerId: string,
    metas: Array<FileMeta & { uri: string }>,
    onProgress: (event: { fileIndex: number; bytes: number; totalBytes: number }) => void,
  ): Promise<void>;
}
