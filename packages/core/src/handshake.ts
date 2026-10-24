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
  private helloRetryTimer: ReturnType<typeof setInterval> | null = null;
  private pendingConfirmSig: string | null = null;
  private resolved = false;

  constructor(
    private me: { identity: Identity; name: string; deviceType: string },
    timeoutMs = 15_000,
  ) {
    this.timer = setTimeout(() => {
      this.cleanupTimers();
      if (!this.resolved) this.done.reject(new Error('identity handshake timeout'));
    }, timeoutMs);
  }

  private cleanupTimers(): void {
    clearTimeout(this.timer);
    if (this.helloRetryTimer) {
      clearInterval(this.helloRetryTimer);
      this.helloRetryTimer = null;
    }
  }

  private sendHello(): void {
    if (!this.send || this.resolved) return;
    const { identity, name, deviceType } = this.me;
    this.send({
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

  start(send: (m: HelloMessage | ConfirmMessage) => void): void {
    this.send = send;
    this.sendHello();
    if (!this.helloRetryTimer && !this.resolved) {
      this.helloRetryTimer = setInterval(() => {
        if (this.resolved) {
          this.cleanupTimers();
          return;
        }
        this.sendHello();
      }, 1200);
    }
  }

  /** Feed parsed control messages; returns true when consumed. */
  handle(msg: unknown): boolean {
    const m = msg as Partial<HelloMessage> & Partial<ConfirmMessage>;
    if (m.t === 'hello' && m.deviceId && m.pub && m.nonce && m.alg) {
      const isFirstHello = !this.peer;
      const peer: VerifiedPeerLike = {
        deviceId: m.deviceId,
        name: m.name ?? 'Unknown',
        deviceType: m.deviceType ?? 'other',
        alg: m.alg,
        publicJwk: m.pub,
      };
      this.peer = peer;
      // Ensure the remote side also has our hello if they just woke up
      if (isFirstHello) this.sendHello();
      void signBytes(this.me.identity, new TextEncoder().encode(m.nonce))
        .then((sig) => this.send?.({ t: 'confirm', sig }))
        .catch(() => this.done.reject(new Error('sign failed')));
      if (this.pendingConfirmSig) {
        const sig = this.pendingConfirmSig;
        this.pendingConfirmSig = null;
        this.verifyPeerConfirm(sig);
      }
      return true;
    }
    if (m.t === 'confirm' && m.sig) {
      if (!this.peer) {
        this.pendingConfirmSig = m.sig;
        return true;
      }
      this.verifyPeerConfirm(m.sig);
      return true;
    }
    return false;
  }

  private verifyPeerConfirm(sig: string): void {
    if (!this.peer || this.resolved) return;
    verifyBytes(this.peer.alg, this.peer.publicJwk, new TextEncoder().encode(this.nonce), sig)
      .then((ok) => {
        this.cleanupTimers();
        if (ok) {
          this.resolved = true;
          this.done.resolve(this.peer!);
        } else {
          this.done.reject(new Error('peer signature invalid — identity verification failed'));
        }
      })
      .catch((err) => {
        this.cleanupTimers();
        this.done.reject(err instanceof Error ? err : new Error(String(err)));
      });
  }

  get result(): Promise<VerifiedPeerLike> {
    return this.done.promise;
  }
}
