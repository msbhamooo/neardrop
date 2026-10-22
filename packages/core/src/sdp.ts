/**
 * Compact SDP codec for QR-code offline pairing.
 *
 * A fully-gathered WebRTC offer/answer (no trickle) reduces to:
 * DTLS fingerprint (32B) + ice-ufrag + ice-pwd + setup role + candidates.
 * We pack that into a small binary blob, deflate it (injectable), then base45 it
 * (alphanumeric QR mode). Typical offers land ~250-400 chars → fits QR v10-v13 @ ECC-M.
 */
import { encodeBase45, decodeBase45 } from './base45.js';

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type SetupRole = 'actpass' | 'active' | 'passive';

export interface CompactCandidate {
  ipMode: 'v4' | 'v6' | 'mdns';
  ip: string;
  port: number;
  type: CandidateType;
  priority: number;
  foundation: string;
  component: number;
}

export interface CompactSdp {
  setup: SetupRole;
  ufrag: string;
  pwd: string;
  /** 32 raw bytes */
  fingerprint: Uint8Array;
  candidates: CompactCandidate[];
}

export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array>;
export type Inflate = (bytes: Uint8Array) => Promise<Uint8Array>;

const MAGIC0 = 0x4e; // 'N'
const MAGIC1 = 0x44; // 'D'
const VERSION = 0x01;
const FLAG_DEFLATED = 0x01;

// ---------------------------------------------------------------------------
// SDP parsing / rebuilding
// ---------------------------------------------------------------------------

export function parseSdp(sdp: string): CompactSdp {
  let setup: SetupRole = 'actpass';
  let ufrag = '';
  let pwd = '';
  let fingerprint = new Uint8Array(32);
  const candidates: CompactCandidate[] = [];

  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('a=ice-ufrag:')) ufrag = line.slice(12);
    else if (line.startsWith('a=ice-pwd:')) pwd = line.slice(10);
    else if (line.startsWith('a=setup:')) {
      const role = line.slice(8);
      if (role === 'active' || role === 'passive' || role === 'actpass') setup = role;
    } else if (line.startsWith('a=fingerprint:')) {
      // "a=fingerprint:sha-256 19:E2:5C:..." → take the hex portion after the hash name
      const hex = line.split(/\s+/)[1]?.replace(/:/g, '') ?? '';
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32 && i * 2 + 2 <= hex.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      fingerprint = bytes;
    } else if (line.startsWith('a=candidate:')) {
      // a=candidate:FOUNDATION COMPONENT TRANSPORT PRIORITY IP PORT typ TYPE ...
      const m = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (host|srflx|prflx|relay)/.exec(line);
      if (!m) continue;
      const ip = m[5]!;
      const ipMode: CompactCandidate['ipMode'] = ip.endsWith('.local') ? 'mdns' : ip.includes(':') ? 'v6' : 'v4';
      candidates.push({
        foundation: m[1]!.slice(0, 255),
        component: Number(m[2]!),
        priority: Number(m[4]!),
        ip,
        port: Number(m[6]!),
        type: m[7] as CandidateType,
        ipMode,
      });
    }
  }
  return { setup, ufrag, pwd, fingerprint, candidates };
}

export function buildSdp(c: CompactSdp): string {
  const fpHex = Array.from(c.fingerprint, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${c.ufrag}`,
    `a=ice-pwd:${c.pwd}`,
    `a=fingerprint:sha-256 ${fpHex}`,
    `a=setup:${c.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  for (const cand of c.candidates) {
    lines.push(
      `a=candidate:${cand.foundation} ${cand.component} udp ${cand.priority} ${cand.ip} ${cand.port} typ ${cand.type}`,
    );
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Binary packing
// ---------------------------------------------------------------------------

class ByteWriter {
  private parts: number[] = [];
  u8(v: number): void { this.parts.push(v & 0xff); }
  u16(v: number): void { this.parts.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v: number): void { this.parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  bytes(b: Uint8Array): void { for (const x of b) this.parts.push(x); }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new Error('string too long for compact SDP');
    this.u8(b.length);
    this.bytes(b);
  }
  out(): Uint8Array { return new Uint8Array(this.parts); }
}

class ByteReader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  u8(): number { return this.buf[this.pos++]!; }
  u16(): number { const v = this.buf[this.pos]! | (this.buf[this.pos + 1]! << 8); this.pos += 2; return v; }
  u32(): number { const v = (this.buf[this.pos]! | (this.buf[this.pos + 1]! << 8) | (this.buf[this.pos + 2]! << 16) | (this.buf[this.pos + 3]! << 24)) >>> 0; this.pos += 4; return v; }
  bytes(n: number): Uint8Array { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  str(): string { const n = this.u8(); return new TextDecoder().decode(this.bytes(n)); }
}

const SETUP_ROLES: SetupRole[] = ['actpass', 'active', 'passive'];
const CAND_TYPES: CandidateType[] = ['host', 'srflx', 'prflx', 'relay'];

/** Pack the compact body (no magic header — encodePayload adds it outside the deflate envelope). */
export function packCompact(c: CompactSdp): Uint8Array {
  const w = new ByteWriter();
  w.u8(SETUP_ROLES.indexOf(c.setup));
  w.str(c.ufrag);
  w.str(c.pwd);
  w.bytes(c.fingerprint);
  w.u8(Math.min(c.candidates.length, 255));
  for (const cand of c.candidates.slice(0, 255)) {
    const modeBits = cand.ipMode === 'v4' ? 0 : cand.ipMode === 'v6' ? 1 : 2;
    w.u8(modeBits | (CAND_TYPES.indexOf(cand.type) << 2));
    if (cand.ipMode === 'v4') {
      for (const seg of cand.ip.split('.')) w.u8(Number(seg));
    } else {
      // v6 and .local (mDNS) are stored as length-prefixed ASCII strings
      w.str(cand.ip);
    }
    w.u16(cand.port);
    w.u32(cand.priority);
    w.str(cand.foundation);
    w.u8(cand.component);
  }
  return w.out();
}

export function unpackCompact(body: Uint8Array): CompactSdp {
  const r = new ByteReader(body);
  const setup = SETUP_ROLES[r.u8()] ?? 'actpass';
  const ufrag = r.str();
  const pwd = r.str();
  const fingerprint = r.bytes(32);
  const count = r.u8();
  const candidates: CompactCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const flagsByte = r.u8();
    const modeBits = flagsByte & 0x03;
    const type = CAND_TYPES[(flagsByte >> 2) & 0x03] ?? 'host';
    let ip = '';
    let ipMode: CompactCandidate['ipMode'] = 'v4';
    if (modeBits === 0) {
      ip = [r.u8(), r.u8(), r.u8(), r.u8()].join('.');
    } else {
      ip = r.str();
      ipMode = modeBits === 1 ? 'v6' : 'mdns';
    }
    const port = r.u16();
    const priority = r.u32();
    const foundation = r.str();
    const component = r.u8();
    candidates.push({ ip, port, type, priority, foundation, component, ipMode });
  }
  return { setup, ufrag, pwd, fingerprint, candidates };
}

// ---------------------------------------------------------------------------
// base45 payload: [magic 'N','D'] [version] [flags] [deflated-or-raw body]
// The flags byte stays OUTSIDE the deflate envelope so inflate sees a clean stream.
// ---------------------------------------------------------------------------

export async function encodePayload(c: CompactSdp, deflate?: Deflate): Promise<string> {
  const body = packCompact(c);
  let payload = body;
  let flags = 0;
  if (deflate && body.length > 64) {
    try {
      const z = await deflate(body);
      if (z.length < body.length - 4) {
        payload = z;
        flags |= FLAG_DEFLATED;
      }
    } catch { /* ship uncompressed */ }
  }
  const out = new Uint8Array(4 + payload.length);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = flags;
  out.set(payload, 4);
  return encodeBase45(out);
}

export async function decodePayload(payload: string, inflate?: Inflate): Promise<CompactSdp> {
  const buf = decodeBase45(payload);
  if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1 || buf[2] !== VERSION) throw new Error('bad QR payload');
  const flags = buf[3]!;
  let body = buf.subarray(4);
  if (flags & FLAG_DEFLATED) {
    if (!inflate) throw new Error('payload is deflated but no inflate adapter provided');
    body = await inflate(body);
  }
  return unpackCompact(body);
}
