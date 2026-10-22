import { createHash } from 'node:crypto';
import type { JoinMessage, PeerInfo, ServerMessage } from './protocol.js';
import { geohashNeighborhood, isValidGeohash } from './geohash.js';

export interface Peer {
  ws: import('ws').WebSocket;
  id: string;
  name: string;
  deviceType: JoinMessage['deviceType'];
  geo?: string;
  room: string; // 'ip:<hash>'
  alive: boolean;
  strikes: number;
}

/**
 * In-memory rooms keyed by hashed client IP. Visibility:
 *   - same room (same network) → always visible to each other
 *   - different rooms → visible only if BOTH published a geohash and the cells are adjacent
 * Nothing is persisted; room state dies with the process.
 */
export class RoomRegistry {
  private byRoom = new Map<string, Set<Peer>>();
  private byId = new Map<string, Peer>();

  roomForIp(ip: string): string {
    const h = createHash('sha256').update(ip).digest('hex').slice(0, 12);
    return `ip:${h}`;
  }

  add(peer: Peer): void {
    let set = this.byRoom.get(peer.room);
    if (!set) {
      set = new Set();
      this.byRoom.set(peer.room, set);
    }
    set.add(peer);
    this.byId.set(peer.id, peer);
  }

  remove(peer: Peer): void {
    this.byRoom.get(peer.room)?.delete(peer);
    if (!this.byRoom.get(peer.room)?.size) this.byRoom.delete(peer.room);
    // Guard against the reload race: a dead socket's close event can fire AFTER the
    // same device re-joined with a fresh socket — only delete the byId entry we own.
    if (this.byId.get(peer.id) === peer) this.byId.delete(peer.id);
  }

  getById(id: string): Peer | undefined {
    return this.byId.get(id);
  }

  count(): number {
    return this.byId.size;
  }

  /** Server-side visibility check: can `a` see `b`? */
  visible(a: Peer, b: Peer): boolean {
    if (a.id === b.id) return false;
    if (a.room === b.room) return true;
    if (a.geo && b.geo) {
      return geohashNeighborhood(a.geo).includes(b.geo);
    }
    return false;
  }

  /** All existing peers visible to `peer`. */
  visiblePeers(peer: Peer): Peer[] {
    const out: Peer[] = [];
    for (const other of this.byId.values()) {
      if (other.id !== peer.id && this.visible(peer, other)) out.push(other);
    }
    return out;
  }

  /** Broadcast `msg` to every peer that can see `peer` (used on join/leave). */
  broadcastVisible(peer: Peer, msg: ServerMessage): void {
    for (const other of this.byId.values()) {
      if (other.id !== peer.id && this.visible(other, peer)) {
        this.send(other, msg);
      }
    }
  }

  toPeerInfo(peer: Peer, viewer: Peer): PeerInfo {
    return {
      id: peer.id,
      name: peer.name,
      deviceType: peer.deviceType,
      geo: peer.geo,
      sameNetwork: peer.room === viewer.room,
    };
  }

  send(peer: Peer, msg: ServerMessage): void {
    if (peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(JSON.stringify(msg));
    }
  }

  /** Validate & normalize a join payload. Returns null when invalid. */
  static normalizeJoin(raw: unknown): JoinMessage | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || m.id.length < 8 || m.id.length > 64) return null;
    if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 64) return null;
    const types = ['phone', 'tablet', 'laptop', 'desktop', 'tv', 'watch', 'other'];
    if (!types.includes(m.deviceType as string)) return null;
    const join: JoinMessage = {
      t: 'join',
      id: m.id.replace(/[^\w-]/g, ''),
      name: m.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 64) || 'Unknown',
      deviceType: m.deviceType as JoinMessage['deviceType'],
    };
    if (isValidGeohash(m.geo)) join.geo = m.geo;
    if (m.visibility === 'off' || m.visibility === 'contacts' || m.visibility === 'everyone') {
      join.visibility = m.visibility;
    }
    return join;
  }
}
