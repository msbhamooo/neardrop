/**
 * Device identity: Ed25519 (or ECDSA P-256) keypair in IndexedDB via idb-keyval,
 * friendly auto-name ("Blue Otter"), editable display name, receiving visibility.
 */
import { get, set } from 'idb-keyval';
import {
  generateIdentity, importIdentity, randomName,
  type Identity, type IdentityAlg,
} from '@neardrop/core';
import { detectDeviceType } from './device.js';
import { signal } from '@preact/signals';

export interface Settings {
  name: string;
  visibility: 'off' | 'contacts' | 'everyone';
  debug: boolean;
  geoEnabled: boolean;
}

export const session = signal<{
  identity: Identity;
  settings: Settings;
} | null>(null);

export const deviceType = detectDeviceType();

export async function initIdentity(): Promise<void> {
  const stored = await get<{ alg: IdentityAlg; publicJwk: JsonWebKey; privateJwk: JsonWebKey }>('neardrop:identity');
  const identity = stored
    ? await importIdentity(stored.alg, stored.publicJwk, stored.privateJwk)
    : await generateIdentity();
  if (!stored) {
    const jwk = await crypto.subtle.exportKey('jwk', identity.privateKey);
    await set('neardrop:identity', { alg: identity.alg, publicJwk: identity.publicJwk, privateJwk: jwk });
  }

  const settings = (await get<Settings>('neardrop:settings')) ?? {
    name: randomName(),
    visibility: 'everyone' as const,
    debug: false,
    geoEnabled: false,
  };
  await set('neardrop:settings', settings);
  session.value = { identity, settings };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (!session.value) return;
  const settings = { ...session.value.settings, ...patch };
  session.value = { ...session.value!, settings };
  await set('neardrop:settings', settings);
}
