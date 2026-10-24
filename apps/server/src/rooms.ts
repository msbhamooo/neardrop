import { createHash } from 'node:crypto';
import type { JoinMessage, PeerInfo, ServerMessage } from './protocol.js';
import { geohashNeighborhood, isValidGeohash } from './geohash.js';

export interface Peer {
  ws?: import('ws').WebSocket;
  sendFn?: (msg: ServerMessage) => void;
  id: string;
  name: string;
  deviceType: JoinMessage['deviceType'];
  geo?: string;
  roomCode?: string;
  pairedIds?: Set<string>;
  room: string; // 'ip:<hash>'
  alive: boolean;
  strikes: number;
}

/**
 * In-memory rooms keyed by hashed client IP, plus optional cross-network roomCode,
 * paired contacts, and geohash proximity.
 * Visibility:
 *   - same IP room (same network) → always visible
 *   - same roomCode (cross-network room) → visible across any network
 *   - paired contacts → visible if either device has paired with the other
 *   - adjacent 8-char geohash (~50m) → visible when both publish geohash
 */
export class RoomRegistry {
  private byRoom = new Map<string, Set<Peer>>();
  private byId = new Map<string, Peer>();

  roomForIp(ip: string): string {
    const h = createHash('sha256').update(ip).digest('hex').slice(0, 12);
    return `ip:${h}`;
  }

  add(peer: Peer): void {
    const existing = this.byId.get(peer.id);
    if (existing && existing !== peer) {
      this.byRoom.get(existing.room)?.delete(existing);
    }
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
    if (a.roomCode || b.roomCode) {
      if (a.roomCode && b.roomCode && a.roomCode === b.roomCode) return true;
      if (a.pairedIds?.has(b.id) || b.pairedIds?.has(a.id)) return true;
      return false;
    }
    if (a.room === b.room) return true;
    if (a.pairedIds?.has(b.id) || b.pairedIds?.has(a.id)) return true;
    if (a.geo && b.geo && geohashNeighborhood(a.geo).includes(b.geo)) return true;
    // Default global lobby when neither peer has locked into a private roomCode
    // (handles dual-stack IPv4/IPv6 on the same Wi-Fi, CGNAT, and Cloud Run proxy IPs).
    return true;
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
    const sameNetwork = peer.room === viewer.room;
    let via: PeerInfo['via'] = 'lan';
    if (!sameNetwork) {
      if (peer.roomCode && peer.roomCode === viewer.roomCode) via = 'room';
      else if (viewer.pairedIds?.has(peer.id) || peer.pairedIds?.has(viewer.id)) via = 'contact';
      else via = 'geo';
    }
    return {
      id: peer.id,
      name: peer.name,
      deviceType: peer.deviceType,
      geo: peer.geo,
      sameNetwork,
      via,
    };
  }

  send(peer: Peer, msg: ServerMessage): void {
    if (peer.sendFn) {
      peer.sendFn(msg);
      return;
    }
    if (peer.ws && peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(JSON.stringify(msg));
    }
  }

  static normalizeRoomCode(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const clean = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
    return clean.length >= 3 ? clean : undefined;
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
    const roomCode = RoomRegistry.normalizeRoomCode(m.roomCode);
    if (roomCode) join.roomCode = roomCode;
    if (Array.isArray(m.pairedIds)) {
      join.pairedIds = m.pairedIds
        .filter((x): x is string => typeof x === 'string' && x.length >= 8 && x.length <= 64)
        .slice(0, 100);
    }
    if (m.visibility === 'off' || m.visibility === 'contacts' || m.visibility === 'everyone') {
      join.visibility = m.visibility;
    }
    return join;
  }
}
