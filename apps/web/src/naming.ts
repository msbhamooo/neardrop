/**
 * Intelligent device naming and disambiguation.
 * Ensures every discovered device has a unique, friendly, human-readable name
 * and a distinct visual color identity, preventing confusion when multiple
 * devices of the same type (e.g. multiple iPhones) are in the same room.
 */
import type { PeerInfo } from './signaling.js';
import type { PeerView } from './transfers.js';

export const ADJECTIVES = [
  'Amber', 'Azure', 'Brave', 'Breezy', 'Calm', 'Clever', 'Cosmic', 'Crimson',
  'Curious', 'Dapper', 'Dawn', 'Eager', 'Ember', 'Fern', 'Flint', 'Frost',
  'Gentle', 'Golden', 'Ivory', 'Jade', 'Lilac', 'Lunar', 'Mellow', 'Mint',
  'Noble', 'Onyx', 'Opal', 'Peppy', 'Polar', 'Quiet', 'Rapid', 'Rose',
  'Rusty', 'Silent', 'Silver', 'Sly', 'Solar', 'Sunny', 'Swift', 'Tender',
  'Tidal', 'Umber', 'Velvet', 'Vivid', 'Warm', 'Wild', 'Wise', 'Zesty'
] as const;

export interface DeviceTheme {
  name: string;
  accent: string;
  border: string;
  glow: string;
  bg: string;
}

export const DEVICE_THEMES: DeviceTheme[] = [
  { name: 'Cyan', accent: '#38bdf8', border: 'rgba(56, 189, 248, 0.45)', glow: 'rgba(56, 189, 248, 0.28)', bg: 'rgba(56, 189, 248, 0.08)' },
  { name: 'Emerald', accent: '#34d399', border: 'rgba(52, 211, 153, 0.45)', glow: 'rgba(52, 211, 153, 0.28)', bg: 'rgba(52, 211, 153, 0.08)' },
  { name: 'Amber', accent: '#fbbf24', border: 'rgba(251, 191, 36, 0.45)', glow: 'rgba(251, 191, 36, 0.28)', bg: 'rgba(251, 191, 36, 0.08)' },
  { name: 'Rose', accent: '#fb7185', border: 'rgba(251, 113, 133, 0.45)', glow: 'rgba(251, 113, 133, 0.28)', bg: 'rgba(251, 113, 133, 0.08)' },
  { name: 'Violet', accent: '#a78bfa', border: 'rgba(167, 139, 250, 0.45)', glow: 'rgba(167, 139, 250, 0.28)', bg: 'rgba(167, 139, 250, 0.08)' },
  { name: 'Coral', accent: '#fb923c', border: 'rgba(251, 146, 60, 0.45)', glow: 'rgba(251, 146, 60, 0.28)', bg: 'rgba(251, 146, 60, 0.08)' },
  { name: 'Teal', accent: '#2dd4bf', border: 'rgba(45, 212, 191, 0.45)', glow: 'rgba(45, 212, 191, 0.28)', bg: 'rgba(45, 212, 191, 0.08)' },
  { name: 'Indigo', accent: '#818cf8', border: 'rgba(129, 140, 248, 0.45)', glow: 'rgba(129, 140, 248, 0.28)', bg: 'rgba(129, 140, 248, 0.08)' },
];

/** Hash a string deterministically into a 32-bit positive integer */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getDeviceTheme(idOrName: string): DeviceTheme {
  const h = hashString(idOrName || 'device');
  return DEVICE_THEMES[h % DEVICE_THEMES.length]!;
}

export function getDeviceAdjective(idOrSeed?: string): string {
  if (!idOrSeed) {
    return ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  }
  const h = hashString(idOrSeed);
  return ADJECTIVES[h % ADJECTIVES.length]!;
}

/** Check if a name is a generic fallback like "My iPhone" */
export function isGenericDefaultName(name?: string): boolean {
  if (!name) return true;
  const n = name.trim();
  const generic = [
    'My iPhone', 'My iPad', 'My Phone', 'My Tablet', 'My Mac',
    'My Windows PC', 'My Computer', 'My Device', 'Device', 'Nearby Device',
    'Unknown device', 'peer'
  ];
  if (generic.includes(n)) return true;
  // Also check patterns like "My <type>"
  if (/^my (iphone|ipad|phone|tablet|mac|computer|device|pc)$/i.test(n)) return true;
  return false;
}

/**
 * Generate a unique default device name (e.g. "Jade iPhone", "Cosmic Mac")
 * based on device type and a seed ID.
 */
export function generateUniqueDeviceName(uaString?: string, seedId?: string): string {
  const ua = uaString || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  let model = 'Device';
  if (/iPhone/i.test(ua)) model = 'iPhone';
  else if (/iPad/i.test(ua)) model = 'iPad';
  else if (/Android.*Mobile/i.test(ua)) model = 'Phone';
  else if (/Android/i.test(ua)) model = 'Tablet';
  else if (/Macintosh/i.test(ua)) model = 'Mac';
  else if (/Windows NT/i.test(ua)) model = 'Windows PC';
  else if (/Linux/i.test(ua)) model = 'Linux PC';

  const adj = getDeviceAdjective(seedId);
  return `${adj} ${model}`;
}

export interface DisambiguatedPeer {
  info: PeerInfo;
  link: PeerView['link'];
  displayName: string;
  theme: DeviceTheme;
  isSameDeviceTab: boolean;
  subtitle: string;
}

/**
 * Disambiguates a list of discovered peers against each other and against the local device.
 * Guarantees that EVERY visible peer node has a distinct, understandable name.
 */
export function disambiguatePeers(
  peerList: PeerView[],
  myId: string,
  myName: string,
): DisambiguatedPeer[] {
  const myBaseId = myId.split('-')[0] || myId;

  // Step 1: Pre-process raw names and detect same-device tabs
  const intermediate = peerList.map((p) => {
    const peerId = p.info.id;
    const peerBaseId = peerId.split('-')[0] || peerId;
    const isSameDeviceTab = Boolean(myBaseId && peerBaseId && myBaseId === peerBaseId && peerId !== myId);
    const theme = getDeviceTheme(peerId);

    let baseName = (p.info.name || '').trim();

    // If the peer is advertising a generic name like "My iPhone", elevate it to a distinct human name
    if (isGenericDefaultName(baseName)) {
      let model = 'Device';
      if (/iphone/i.test(baseName) || p.info.deviceType === 'phone') model = 'iPhone';
      else if (/ipad/i.test(baseName) || p.info.deviceType === 'tablet') model = 'iPad';
      else if (/mac/i.test(baseName)) model = 'Mac';
      else if (p.info.deviceType === 'laptop') model = 'Laptop';
      else if (p.info.deviceType === 'desktop') model = 'Computer';
      else if (p.info.deviceType === 'phone') model = 'Phone';

      const adj = getDeviceAdjective(peerId);
      baseName = `${adj} ${model}`;
    }

    return {
      p,
      peerId,
      isSameDeviceTab,
      theme,
      baseName,
    };
  });

  // Step 2: Handle tabs and duplicate name collisions
  // Group by baseName to see which ones collide
  const nameCounts = new Map<string, number>();
  for (const item of intermediate) {
    if (item.isSameDeviceTab) {
      // Don't count same device tab as a general collision
      continue;
    }
    const current = nameCounts.get(item.baseName) || 0;
    nameCounts.set(item.baseName, current + 1);
  }

  // Also check if any peer has the same name as the local device ("You")
  const localNameCollision = nameCounts.has(myName);

  const tracker = new Map<string, number>();
  let tabCounter = 1;

  return intermediate.map((item) => {
    let displayName = item.baseName;
    let subtitle = 'Tap to send';

    if (item.isSameDeviceTab) {
      tabCounter++;
      displayName = `${myName} (Other Tab)`;
      subtitle = 'This device · Tap to test';
    } else if (item.baseName === myName) {
      // Different device, but exact same custom name as the local user
      const count = (tracker.get(item.baseName) || 0) + 1;
      tracker.set(item.baseName, count);
      displayName = `${item.baseName} (${count + 1})`;
      subtitle = 'Tap to send';
    } else {
      const totalWithName = nameCounts.get(item.baseName) || 0;
      if (totalWithName > 1) {
        const idx = (tracker.get(item.baseName) || 0) + 1;
        tracker.set(item.baseName, idx);
        displayName = `${item.baseName} (${idx})`;
      }
    }

    return {
      info: {
        ...item.p.info,
        name: displayName,
      },
      link: item.p.link,
      displayName,
      theme: item.theme,
      isSameDeviceTab: item.isSameDeviceTab,
      subtitle,
    };
  });
}
