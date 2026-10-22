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
  /** receiving policy hint, informational for peers */
  visibility?: 'off' | 'contacts' | 'everyone';
}

export interface SignalMessage {
  t: 'signal';
  to: string;
  /** opaque SDP/ICE payload — never logged, never interpreted */
  data: unknown;
}

export type ClientMessage = JoinMessage | SignalMessage | { t: 'ping' };

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: JoinMessage['deviceType'];
  geo?: string;
  /** whether this peer shares your IP room (same network) vs geo-proximity only */
  sameNetwork: boolean;
}

export type ServerMessage =
  | { t: 'welcome'; peers: PeerInfo[] }
  | { t: 'peer-joined'; peer: PeerInfo }
  | { t: 'peer-left'; id: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'pong' }
  | { t: 'error'; code: 'rate-limited' | 'bad-message' | 'not-joined' | 'unknown-peer'; message: string };
