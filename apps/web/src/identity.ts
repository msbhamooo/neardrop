/**
 * Device identity: Ed25519 (or ECDSA P-256) keypair in IndexedDB via idb-keyval,
 * friendly auto-name ("Blue Otter"), editable display name, receiving visibility.
 */
import { get, set } from 'idb-keyval';
import {
  generateIdentity, importIdentity, randomName,
  type Identity, type IdentityAlg,
} from '@neardrop/core';
import { detectDeviceType, friendlyDeviceDefaultName } from './device.js';
import { isGenericDefaultName } from './naming.js';
import { signal } from '@preact/signals';


export interface Settings {
  name: string;
  visibility: 'off' | 'contacts' | 'everyone';
  debug: boolean;
  geoEnabled: boolean;
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
}

export const session = signal<{
  identity: Identity;
  settings: Settings;
} | null>(null);

export const deviceType = detectDeviceType();

export async function initIdentity(): Promise<void> {
  const stored = await get<{ alg: IdentityAlg; publicJwk: JsonWebKey; privateJwk: JsonWebKey }>('neardrop:identity');
  const baseIdentity = stored
    ? await importIdentity(stored.alg, stored.publicJwk, stored.privateJwk)
    : await generateIdentity();
  if (!stored) {
    const jwk = await crypto.subtle.exportKey('jwk', baseIdentity.privateKey);
    await set('neardrop:identity', { alg: baseIdentity.alg, publicJwk: baseIdentity.publicJwk, privateJwk: jwk });
  }

  // One id per browser tab, kept across reloads (sessionStorage) so a refresh is the same device
  // rather than a new ghost device next to the old one.
  let tab = '';
  try { tab = sessionStorage.getItem('nd.tab') ?? ''; } catch { /* storage blocked */ }
  if (!tab) {
    tab = Math.random().toString(36).slice(2, 6);
    try { sessionStorage.setItem('nd.tab', tab); } catch { /* storage blocked */ }
  }
  const tabSuffix = `-${tab}`;

  const identity: Identity = {
    ...baseIdentity,
    deviceId: `${baseIdentity.deviceId}${tabSuffix}`,
  };

  const storedSettings = await get<Settings>('neardrop:settings');
  const needsUniqueName = !storedSettings || !storedSettings.name || isGenericDefaultName(storedSettings.name);

  const settings: Settings = {
    name: needsUniqueName ? friendlyDeviceDefaultName(baseIdentity.deviceId) : storedSettings.name,
    visibility: storedSettings?.visibility ?? ('everyone' as const),
    debug: storedSettings?.debug ?? false,
    geoEnabled: storedSettings?.geoEnabled ?? false,
    turnUrl: storedSettings?.turnUrl,
    turnUsername: storedSettings?.turnUsername,
    turnCredential: storedSettings?.turnCredential,
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
