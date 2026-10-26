import { signal, effect } from '@preact/signals';
import { sessionBus, peers, showToast } from './transfers.js';
import { makeShareSecret, shareRoom, shareUrl, parseShareHash, shareNeedsPassword } from './sharelink.js';
import { transfers } from './transfers.js';

export interface ActiveShare {
  files: File[];
  secret: string;
  room: string;
  url: string;
  hasPassword: boolean;
  /** close the link after the first receiver finishes */
  once: boolean;
  /** how many receivers we have started sending to */
  served: number;
  firstPeerId?: string;
}

/** Set while this tab is offering files by link (the sender). */
export const activeShare = signal<ActiveShare | null>(null);
/** Set when this tab was opened from someone's share link (the receiver). */
export const linkRoom = signal<string | null>(null);
/** Files waiting for the user to choose link options (password / one-time). */
export const linkDraft = signal<File[] | null>(null);
/** Set when the opened link needs a password before we can join its room. */
export const linkPasswordFor = signal<string | null>(null);

const servedIds = new Set<string>();
/** Sends that had already finished before the current link was made (they must not close it). */
let doneBefore = new Set<string>();

function doneSendIds(): Set<string> {
  return new Set([...transfers.value.values()].filter((t) => t.direction === 'send' && t.status === 'done').map((t) => t.id));
}

export function startShare(files: File[], opts: { password?: string; once?: boolean } = {}): void {
  const secret = makeShareSecret();
  const password = opts.password?.trim() ?? '';
  const room = shareRoom(secret, password);
  servedIds.clear();
  doneBefore = doneSendIds();
  activeShare.value = {
    files, secret, room,
    url: shareUrl(location.origin, location.pathname, secret, !!password),
    hasPassword: !!password,
    once: !!opts.once,
    served: 0,
  };
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
  if (shareNeedsPassword(location.hash)) {
    linkPasswordFor.value = secret; // ask before joining
    return;
  }
  const room = shareRoom(secret);
  linkRoom.value = room;
  sessionBus.setRoomCode(room);
}

export function submitLinkPassword(password: string): void {
  const secret = linkPasswordFor.value;
  if (!secret) return;
  const room = shareRoom(secret, password.trim());
  linkPasswordFor.value = null;
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
  let served = share.served;
  let first = share.firstPeerId;
  for (const id of current.keys()) {
    if (servedIds.has(id)) continue;
    servedIds.add(id);
    served += 1;
    first ??= id;
    void sessionBus.sendFiles(id, share.files).catch(() => showToast('Could not reach the receiver', true));
  }
  if (served !== share.served) activeShare.value = { ...share, served, firstPeerId: first }; // re-render the counter
});

// One-time links: close the room as soon as any receiver has finished getting the files.
effect(() => {
  const share = activeShare.value;
  if (!share?.once) return;
  const finished = [...doneSendIds()].some((id) => !doneBefore.has(id));
  if (finished) {
    stopShare();
    showToast('Delivered. The link is now closed.');
  }
});
