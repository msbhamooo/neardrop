import { signal, effect } from '@preact/signals';
import { sessionBus, peers, showToast } from './transfers.js';
import { makeShareSecret, shareRoom, shareUrl, parseShareHash } from './sharelink.js';

export interface ActiveShare {
  files: File[];
  secret: string;
  room: string;
  url: string;
  /** how many receivers we have started sending to */
  served: number;
}

/** Set while this tab is offering files by link (the sender). */
export const activeShare = signal<ActiveShare | null>(null);
/** Set when this tab was opened from someone's share link (the receiver). */
export const linkRoom = signal<string | null>(null);

const servedIds = new Set<string>();

export function startShare(files: File[]): void {
  const secret = makeShareSecret();
  const room = shareRoom(secret);
  servedIds.clear();
  activeShare.value = { files, secret, room, url: shareUrl(location.origin, location.pathname, secret), served: 0 };
  sessionBus.setRoomCode(room);
}

export function stopShare(): void {
  activeShare.value = null;
  servedIds.clear();
  sessionBus.setRoomCode(undefined);
}

export function leaveLinkRoom(): void {
  linkRoom.value = null;
  sessionBus.setRoomCode(undefined);
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
}

/** Receiver side: called once at boot. */
export function joinFromLocationHash(): void {
  const secret = parseShareHash(location.hash);
  if (!secret) return;
  const room = shareRoom(secret);
  linkRoom.value = room;
  sessionBus.setRoomCode(room);
}

// Sender side: whenever a new device appears in the share room, offer it the files.
// (The receiver still sees an Accept/Decline prompt.)
effect(() => {
  const share = activeShare.value;
  const current = peers.value;
  if (!share) return;
  for (const id of [...servedIds]) if (!current.has(id)) servedIds.delete(id); // allow re-serving after a reconnect
  for (const id of current.keys()) {
    if (servedIds.has(id)) continue;
    servedIds.add(id);
    share.served += 1;
    void sessionBus.sendFiles(id, share.files).catch(() => showToast('Could not reach the receiver', true));
  }
});
