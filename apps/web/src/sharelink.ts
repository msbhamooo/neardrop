/**
 * "Send by link" primitives (pure, no DOM/signals, unit-tested).
 *
 * A share link looks like  https://host/#/r/<SECRET>.  The secret lives in the URL fragment, which
 * browsers never send to any server. Both sides derive a rendezvous room from it with SHA-256, so
 * the signaling server (and any broker) only ever sees the hash, never the secret.
 * Files then flow device-to-device over the usual DTLS-encrypted WebRTC channels, and the
 * receiver still has to tap Accept.
 */
import { Sha256, toHex } from '@neardrop/core';

// No 0/O/1/I/L: easy to read aloud if a link ever has to be typed.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SECRET_LENGTH = 20; // 31^20 ~ 2^99

export function makeShareSecret(): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  while (out.length < SECRET_LENGTH) {
    crypto.getRandomValues(buf);
    // rejection sampling: no modulo bias
    if (buf[0]! < 248) out.push(ALPHABET[buf[0]! % ALPHABET.length]!);
  }
  return out.join('');
}

/** Rendezvous room for a secret. Fits the server's 24-char room-code limit; irreversible. */
export function shareRoom(secret: string): string {
  const digest = new Sha256().update(new TextEncoder().encode(`neardrop-share:${secret}`)).digest();
  return `S-${toHex(digest).slice(0, 20).toUpperCase()}`;
}

export function shareUrl(origin: string, pathname: string, secret: string): string {
  return `${origin}${pathname}#/r/${secret}`;
}

/** Extract a valid secret from `location.hash`, or null. */
export function parseShareHash(hash: string): string | null {
  const m = /^#\/r\/([A-Z2-9]{20})$/i.exec(hash.trim());
  if (!m) return null;
  const secret = m[1]!.toUpperCase();
  return [...secret].every((c) => ALPHABET.includes(c)) ? secret : null;
}
