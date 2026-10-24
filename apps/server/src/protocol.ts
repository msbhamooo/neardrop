/** Wire protocol between the signaling server and clients. Relay-only: no SDP inspection, no storage. */

export interface JoinMessage {
  t: 'join';
  /** stable device id (public-key fingerprint) */
  id: string;
  /** display name, 1..64 chars */
  name: string;
  deviceType: 'phone' | 'tablet' | 'laptop' | 'desktop' | 'tv' | 'watch' | 'other';
  /** optional 8-char geohash (~50m cells) for coarse proximity discovery */
  geo?: string;
  /** optional shared room code for cross-network discovery */
  roomCode?: string;
  /** optional list of paired contact device IDs for cross-network contact discovery */
  pairedIds?: string[];
  /** receiving policy hint, informational for peers */
  visibility?: 'off' | 'contacts' | 'everyone';
}

export interface SetRoomMessage {
  t: 'set-room';
  roomCode?: string;
}

export interface SignalMessage {
  t: 'signal';
  to: string;
  /** opaque SDP/ICE/relay payload — never logged, never interpreted */
  data: unknown;
}

export type ClientMessage = JoinMessage | SetRoomMessage | SignalMessage | { t: 'ping' };

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: JoinMessage['deviceType'];
  geo?: string;
  /** whether this peer shares your IP room (same network) vs geo-proximity/room-code/paired */
  sameNetwork: boolean;
  /** how this peer was discovered */
  via?: 'lan' | 'room' | 'geo' | 'contact';
}

export type ServerMessage =
  | { t: 'welcome'; peers: PeerInfo[]; roomCode?: string }
  | { t: 'peer-joined'; peer: PeerInfo }
  | { t: 'peer-left'; id: string }
  | { t: 'signal'; from: string; fromPeer?: PeerInfo; data: unknown }
  | { t: 'pong' }
  | { t: 'error'; code: 'rate-limited' | 'bad-message' | 'not-joined' | 'unknown-peer'; message: string };
