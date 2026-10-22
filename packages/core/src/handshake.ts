import {
  type Identity, type IdentityAlg, type VerifiedPeerLike,
  signBytes, verifyBytes, randomNonce,
} from './identity.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { defer, type Deferred } from './chunks.js';

export interface HelloMessage {
  t: 'hello';
  v: number;
  deviceId: string;
  name: string;
  deviceType: string;
  alg: IdentityAlg;
  pub: JsonWebKey;
  nonce: string;
}

export interface ConfirmMessage {
  t: 'confirm';
  sig: string;
}

/**
 * Mutual identity handshake over the control channel. Both sides run one instance:
 *
 *   A ──hello{identity, nonceA}──▶ B      (both send immediately on start())
 *   A ◀──confirm{sign(nonceA)_B}── B      (sign on hello receipt)
 *   A verifies confirm over its OWN nonce → B owns B's key. Symmetric for B.
 *
 * The app routes every parsed control message through `handle(msg)` first
 * (it returns true when it consumed the message).
 */
export class Handshake {
  readonly nonce = randomNonce();
  private done: Deferred<VerifiedPeerLike> = defer<VerifiedPeerLike>();
  private peer: VerifiedPeerLike | null = null;
  private send: ((m: HelloMessage | ConfirmMessage) => void) | null = null;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    private me: { identity: Identity; name: string; deviceType: string },
    timeoutMs = 12_000,
  ) {
    this.timer = setTimeout(() => {
      if (!this.peer) this.done.reject(new Error('identity handshake timeout'));
    }, timeoutMs);
  }

  start(send: (m: HelloMessage | ConfirmMessage) => void): void {
    this.send = send;
    const { identity, name, deviceType } = this.me;
    send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      deviceId: identity.deviceId,
      name,
      deviceType,
      alg: identity.alg,
      pub: identity.publicJwk,
      nonce: this.nonce,
    });
  }

  /** Feed parsed control messages; returns true when consumed. */
  handle(msg: unknown): boolean {
    const m = msg as Partial<HelloMessage> & Partial<ConfirmMessage>;
    if (m.t === 'hello' && m.deviceId && m.pub && m.nonce && m.alg) {
      const peer: VerifiedPeerLike = {
        deviceId: m.deviceId,
        name: m.name ?? 'Unknown',
        deviceType: m.deviceType ?? 'other',
        alg: m.alg,
        publicJwk: m.pub,
      };
      this.peer = peer;
      void signBytes(this.me.identity, new TextEncoder().encode(m.nonce))
        .then((sig) => this.send?.({ t: 'confirm', sig }))
        .catch(() => this.done.reject(new Error('sign failed')));
      return true;
    }
    if (m.t === 'confirm' && m.sig && this.peer) {
      verifyBytes(this.peer.alg, this.peer.publicJwk, new TextEncoder().encode(this.nonce), m.sig)
        .then((ok) => {
          clearTimeout(this.timer);
          if (ok) this.done.resolve(this.peer!);
          else this.done.reject(new Error('peer signature invalid — identity verification failed'));
        })
        .catch((err) => this.done.reject(err instanceof Error ? err : new Error(String(err))));
      return true;
    }
    return false;
  }

  get result(): Promise<VerifiedPeerLike> {
    return this.done.promise;
  }
}
