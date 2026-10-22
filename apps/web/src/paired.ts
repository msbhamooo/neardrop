/** Paired (trusted) devices: verified public keys persisted in IndexedDB. */
import { get, set, del } from 'idb-keyval';
import { verificationEmoji, type VerifiedPeerLike } from '@neardrop/core';
import { signal } from '@preact/signals';

export interface PairedDevice {
  deviceId: string;
  name: string;
  deviceType: string;
  alg: 'Ed25519' | 'ES256';
  publicJwk: JsonWebKey;
  pairedAt: number;
}

export const pairedDevices = signal<Map<string, PairedDevice>>(new Map());

export async function loadPaired(): Promise<void> {
  const list = (await get<PairedDevice[]>('neardrop:paired')) ?? [];
  pairedDevices.value = new Map(list.map((d) => [d.deviceId, d]));
}

export async function savePaired(peer: VerifiedPeerLike): Promise<void> {
  const map = new Map(pairedDevices.value);
  map.set(peer.deviceId, {
    deviceId: peer.deviceId,
    name: peer.name,
    deviceType: peer.deviceType,
    alg: peer.alg,
    publicJwk: peer.publicJwk,
    pairedAt: Date.now(),
  });
  pairedDevices.value = map;
  await set('neardrop:paired', [...map.values()]);
}

export async function forgetPaired(deviceId: string): Promise<void> {
  const map = new Map(pairedDevices.value);
  map.delete(deviceId);
  pairedDevices.value = map;
  await set('neardrop:paired', [...map.values()]);
  void del(deviceId); // unused key guard
}

export const isPaired = (deviceId: string): boolean => pairedDevices.value.has(deviceId);

/** Bluetooth-style visual check: same 4 emojis shown on both devices during pairing. */
export function emojiForPair(fingerprintA: string, fingerprintB: string): string[] {
  return verificationEmoji(fingerprintA, fingerprintB);
}
