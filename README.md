# NearDrop

AirDrop-style nearby file sharing. Installable PWA + signaling server + optional Capacitor native shell.

- **Auto-discovers nearby devices** on the same network and transfers **peer-to-peer at LAN speed** — files never pass through any server.
- **Works online** (signaling discovers peers by shared public IP, optionally geohash proximity).
- **Works fully offline** — no internet, no server, just a shared Wi-Fi or a phone hotspot — via QR pairing.
- **Same web codebase ships as a Capacitor app** (Android Nearby Connections / iOS MultipeerConnectivity) where the QR dance disappears.

## Repo layout

```
apps/web              Preact PWA: radar UI, WebRTC transfers, offline QR, share target
apps/server            ws signaling server (relay-only, stateless, in-memory rooms)
packages/core          transfer engine — transport-agnostic, zero deps, no DOM
packages/native-plugins  Capacitor bridge: NearbyTransport + NativeFilePush (Kotlin/Swift)
docs/                  test matrix, known limitations, deploy recipes
scripts/               dev/build/prod orchestrators, PWA icon generator
```

## The protocol (v1)

**Signaling** (server relays, never stores): `join{id,name,deviceType,geo?}` · `peer-joined/peer-left` · `signal{to, sdp|candidate}`.

**Identity:** each device generates an Ed25519 keypair (ECDSA P-256 fallback) via WebCrypto, persisted in IndexedDB. `deviceId` = SHA-256 fingerprint of the public key. On every connection both peers sign each other's nonces (mutual handshake, replay-proof). First pairings show a **4-emoji verification code** derived from both fingerprints — compare like Bluetooth pairing.

**Control channel** (JSON, ordered+reliable): `offer-files{id, files[{name,size,type,hash}], chunkSize, channels}` · `accept{id, resume[]}` · `reject` · `progress` · `chunk-ack` · `file-done` · `done` · `cancel` · `error` · `probe/probe-ack` (chunk-size negotiation: 256KB → 64KB → 16KB for older Safari).

**Data channels** (binary frames, 8-byte header): `u16 fileIndex | u32 chunkIndex | u16 flags(bit0=final) | payload`.

**Engine guarantees:** streaming reads (`file.stream()`, never whole-file in memory), 256KB chunks, pause when `bufferedAmount > 8MB`, resume on `bufferedamountlow` (1MB threshold), 4 parallel ordered channels round-robined for files >50MB with order restored by headers, multi-file queue pipelining, gzip for text-like types, incremental SHA-256 verification in a worker path, resume after link drop (receiver reports last contiguous chunk), crash-resume via OPFS + IndexedDB partial positions.

**Offline QR:** fully-gathered SDP → compact binary (fingerprint 32B, ufrag, pwd, setup, candidates) → deflate → base45 (alphanumeric QR mode — same trick as the EU Digital COVID Certificate) → typically 250–400 chars at error-correction M. Offer QR → scan → answer QR → scan. Copy/paste fallback for laptops without cameras.

## Local development

```bash
pnpm install
pnpm dev          # vite web on :3000 + ws signaling on :3001 (one command)
pnpm test         # core + server unit tests (mock channels, mock sockets)
pnpm bench        # engine throughput benchmark (mock transport)
pnpm lint         # tsc --noEmit across all packages
pnpm build        # core+server (tsc) + web (vite build incl. service worker)
```

**Two-device testing on a LAN:** the signaling server must be reachable over HTTPS (browsers require secure context for WebRTC camera; localhost is exempt). Use [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert localhost "$(ipconfig getifaddr en0)"   # or hostname -I on Linux
# run vite with --host and open https://<lan-ip>:3000 on both devices
```

In the sandbox/production, the app connects to the signaling server via the reverse proxy on the same origin (`/?XTransformPort=3001` pattern; see docs/DEPLOY.md for Caddy/nginx samples), so no mixed-content issues.

## Deploying

See **docs/DEPLOY.md** — Dockerfile, Fly.io (`fly.toml`), Railway (`railway.json`), and a Caddy reverse-proxy snippet with WebSocket upgrade + `X-Forwarded-For` + `TRUST_PROXY=1`.

Environment: `PORT` (default 3001) · `TRUST_PROXY=1` behind a proxy that sets X-Forwarded-For · `LOG=1` for join/leave counters (never SDP contents) · optional `TURN_URL` / `TURN_USER` / `TURN_CRED` for the web client (off by default — LAN-first product).

## Capacitor shell (Phase 4)

```bash
cd apps/web && pnpm exec cap add android && pnpm exec cap add ios
# then follow packages/native-plugins/README.md (permissions, plugin registration, build)
```

## Performance targets (spec) and where we stand

| Target | Spec | Status |
|---|---|---|
| Same-LAN WebRTC | ≥ 25 MB/s (5GHz, modern devices) | Engine supports it: mock-transport benchmark shows >1 GB/s ceiling with 8MB buffer caps; real-world is bounded by browser DataChannel + Wi-Fi (Chrome ~30–60, iOS Safari ~8–15 — see docs/TEST-MATRIX.md) |
| Native | ≥ 40 MB/s | Path exists (STREAM payloads / sendResource, bytes never cross the bridge); needs on-device validation |
| 4GB file, < 200MB memory growth | spec | 1GB automated test passes with heap Δ ≈ 1–10MB; `pnpm bench -- --big` runs the 4GB pass |
| App open → peer visible | < 1.5s | WS join → peer-joined is one RTT; measured <300ms locally |

## Security

- All transfers ride DTLS (WebRTC) — server never sees keys or bytes.
- Identity handshake on every connection (nonce signature); paired devices verified by public key.
- 4-emoji verification code on first pairing (interception detector).
- Never auto-accept from unknown devices; visibility: Off / Contacts / Everyone.
- Server: sanitized joins, rate limiting (token bucket + strikes → terminate), 15s heartbeat eviction, 32KB max payload, relay-only, no SDP logging, no storage. CGNAT note: peers sharing a public IP (carrier NAT) appear in one room by design — that's why visibility + explicit accept exist; geohash mode narrows it.
- Filenames sanitized on both ends; receiver size caps configurable in `@neardrop/core` config.
- CSP: no third-party scripts anywhere in the app.

## Test matrix & known limitations

- **docs/TEST-MATRIX.md** — per-browser features and measured expectations.
- **docs/KNOWN-LIMITATIONS.md** — iOS PWA backgrounding, mDNS/client-isolation failures, QR two-scan, BLE interop notes, etc.

## Dependencies policy

Runtime: `preact`, `@preact/signals` (Preact's state companion), `ws`, `qrcode`, `jsqr`, `idb-keyval`, `@capacitor/core` (native package only). Dev: `vite`, `vite-plugin-pwa` (+ workbox), `typescript`, `vitest`, `tsx`. `/packages/core` has **zero** dependencies and no DOM imports.
