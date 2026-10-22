# Test matrix

Manual matrix for every release. "PWA" = installed to home screen. Last full pass: **Oct 2026, engine v0.1**.

| Feature | Chrome (desktop) | Firefox (desktop) | Safari macOS | Chrome Android (browser) | Chrome Android (PWA) | Safari iOS (browser) | Safari iOS (PWA) |
|---|---|---|---|---|---|---|---|
| Signaling discovery | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WebRTC connect + transfer | ✅ ~30–60 MB/s LAN | ✅ ~20–35 MB/s | ✅ ~20–40 MB/s | ✅ ~15–40 MB/s | ✅ | ✅ ~8–15 MB/s | ✅ ~8–15 MB/s |
| Multi-file queue + >50MB parallel channels | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Resume after tab stays open, Wi-Fi blip | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crash resume (OPFS + IDB partials) | ✅ | ✅ (OPFS 111+) | ✅ (OPFS 15.2+) | ✅ | ✅ | ✅ | ✅ |
| Offline boot (SW precache) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| QR pairing (SDP→base45) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Camera QR scan (jsQR worker) | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ needs HTTPS+permission | ⚠️ camera blocked in installed-PWA on some versions — use paste fallback |
| Copy/paste code fallback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Web Share Target (receive from OS share sheet) | n/a | n/a | n/a | ✅ browser | ✅ PWA | ❌ | ❌ iOS does not support share_target files for PWAs |
| OPFS streaming write | ✅ | ✅ 111+ | ✅ 15.2+ | ✅ | ✅ | ✅ | ✅ |
| "Save to disk" (OPFS → download) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4GB transfer memory bounds | ✅ | ✅ | ✅ | ✅ (mem-check panel) | ✅ | ⚠️ 815MB iOS test recommended first | ⚠️ |
| Background transfer continues | ✅ (desktop) | ✅ | ✅ | ⚠️ killed after ~5min Doze | ⚠️ | ❌ | ❌ (see known limitations) |
| Install prompt | ✅ | ✅ | ✅ | ✅ | — | ✅ Add-to-Home | — |

## Throughput measurement recipe

1. Two devices on the same 5GHz SSID, ~2m from AP.
2. Send a 2GB zero-filled file (speed test harness in the debug panel — enable in Settings → Debug → shows live MB/s graph + selected ICE pair).
3. Note the selected pair: `host↔host` (LAN-direct) vs `srflx↔srflx` (relay through STUN-reflecting path). If not host↔host, the LAN path failed — check client isolation/mDNS.

## Automated tests (CI)

- `pnpm test`: 46 tests — core engine (36: codec, RFC base45 vectors, SHA-256 vs node:crypto, SDP minify round-trips, e2e transfers w/ hash verification, backpressure bounds, resume after drop, 1GB memory bounds, chunk-size negotiation ladder, identity + mutual handshake incl. MITM rejection) + signaling server (10: rooms, geohash adjacency, relay, rate-limit eviction, sanitize).
- `pnpm bench`: mock-transport engine throughput (engine ceiling, 25MB/s pacing, single-channel, 16KB-chunk, optional 4GB pass with `-- --big`).

## Browser quirks register

- **Chrome 137+**: Ed25519 in WebCrypto → app uses Ed25519 identities.
- **Safari ≤ 16**: throws on DataChannel messages >64KB → chunk-size probe falls back to 64KB/16KB per peer.
- **iOS Safari**: DataChannel throughput lands ~8–15 MB/s even on good Wi-Fi — SCTP tuning is limited; the 25MB/s target is a Chrome/5GHz number.
- **Firefox**: no `File System Access` API — OPFS path covers it (111+).
- **Android WebView/Chrome**: mDNS candidates need the network to multicast; managed networks break this → troubleshooting tip surface in QR flow + debug panel.
