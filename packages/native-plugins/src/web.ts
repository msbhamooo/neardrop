/**
 * Web fallback: nearby discovery needs platform radios, so the web implementation
 * is a loud, explicit "unsupported" stub — the app then uses LAN WebRTC + QR pairing.
 */
import type { NearbyTransportPlugin, NativeFilePush, DeviceInfo, NearbyPeer } from './definitions.js';

const unsupported = (name: string): Promise<never> =>
  Promise.reject(new Error(`${name} requires the native NearDrop shell (Capacitor build). Use LAN WebRTC or QR pairing instead.`));

export class WebNearbyTransport implements NearbyTransportPlugin {
  async startAdvertising(_info: DeviceInfo): Promise<void> {
    await unsupported('NearbyTransport.startAdvertising');
  }
  async stopAdvertising(): Promise<void> {}
  async startDiscovery(): Promise<void> {
    await unsupported('NearbyTransport.startDiscovery');
  }
  async stopDiscovery(): Promise<void> {}
  async onPeerFound(_cb: (peer: NearbyPeer) => void): Promise<void> {}
  async onPeerLost(_cb: (peer: { id: string }) => void): Promise<void> {}
  async connect(_peerId: string): Promise<{ channelId: string }> {
    return unsupported('NearbyTransport.connect');
  }
  async disconnect(_channelId: string): Promise<void> {}
  async send(_channelId: string, _data: string): Promise<void> {}
  async onMessage(_cb: (event: { channelId: string; data: string }) => void): Promise<void> {}
  async stop(): Promise<void> {}
}

export class WebNativeFilePush implements NativeFilePush {
  async supported(): Promise<boolean> {
    return false;
  }
  async sendFilesNative(..._args: unknown[]): Promise<void> {
    await unsupported('NativeFilePush.sendFilesNative');
  }
}
