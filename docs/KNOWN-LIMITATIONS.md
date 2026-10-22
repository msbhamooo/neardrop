# Known limitations

Honest list — read before filing bugs or promising features.

## Web platform (PWA in a browser)

1. **iOS suspends transfers when the PWA is backgrounded.** WebRTC DataChannels die within seconds once Safari/WebKit freezes the page. Long transfers must keep the screen foregrounded. (The native shell removes this.)
2. **Two-scan QR is inherent to offline mode.** WebRTC offer/answer needs the answer delivered back; with no network backchannel the only channels are camera/keyboard, hence QR → QR or paste → paste. (Native shell removes it.)
3. **Received files land in OPFS, not the Downloads folder.** Browsers don't let pages write arbitrary paths; the app shows a Save button (downloads via object URL). `showSaveFilePicker` is deliberately not used for multi-file drops (per-file prompts are unbearable).
4. **mDNS-obfuscated host candidates.** Modern browsers hide local IPs behind `xxxx.local` names; APs that block multicast or enable **client/AP isolation** break LAN WebRTC. Mitigations in-product: troubleshooting tips in the QR flow + debug panel ICE-pair inspector + "use a hotspot" advice.
5. **CGNAT groups strangers.** All devices behind one carrier-grade NAT share a signaling room. Mitigations: explicit accept always, visibility Off/Contacts/Everyone, optional geohash narrowing, rate-limited signaling, identity verification + emoji compare. Never auto-accept.
6. **iOS PWA cannot receive Web Share Target files** (Android-only feature of Chromium). The native share extension is the fix.
7. **Turn off when off-network.** No TURN by default (files must never relay through servers). Devices on different networks simply won't connect unless a TURN server is configured — by design.
8. **Chunk-size negotiation adds ~2s before first offer** (probe → ack ladder). Fine for big transfers, visible for tiny ones. Cached per peer in a session.
9. **Resume scope:** link-drop resume within a living page session is reliable; crash resume depends on OPFS write flushing and is verified by hash mismatch → automatic restart of that file.
10. **iOS Safari DataChannel throughput ~8–15 MB/s** — the 25 MB/s target is a Chrome-on-5GHz number. See TEST-MATRIX.md.

## Native shells (Phase 4)

11. **Nearby Connections requires Play Services** — de-Googled Android devices fall back to the web/QR paths.
12. **MultipeerConnectivity is iOS↔iOS only.** Android↔iOS requires the BLE-beacon+TCP design (documented in packages/native-plugins/README.md) — not yet implemented; use QR pairing across platforms.
13. **The Kotlin/Swift plugin code is real but not yet device-tested** — it compiles structurally against documented APIs; treat it as a serious starting point, not a finished store artifact. The acceptance-token/emoji verification prompts are flagged with TODOs.
14. **40MB/s native target** needs on-device validation (Pixel↔Pixel on 5GHz Wi-Fi; iPhone↔iPhone AWDL).

## Server

15. **Rooms die with the process** (in-memory by design — no storage, no logs of SDP). Rolling deploys drop discovery for ~2s; clients re-join automatically with backoff.
16. **Geohash proximity is coarse (~40m cells)** and only narrows CGNAT rooms when both sides enable it.
