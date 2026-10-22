# @neardrop/native-plugins

Capacitor 6 plugins giving NearDrop **true offline nearby discovery** — no Wi-Fi with internet required, no signaling server, one shared hotspot or direct peer-to-peer radio is enough.

## Why native

The pure-web app discovers peers via a signaling server (online) or QR codes (offline). Browsers cannot listen on the LAN or advertise over Bluetooth/Bonjour, so the two-scan QR dance is the price of the web platform. Native shells remove it:

| Transport | Platform | Discovery | Typical throughput |
|---|---|---|---|
| Google Nearby Connections (`P2P_POINT_TO_POINT`) | Android ↔ Android | BLE + Wi-Fi Direct/hotspot | 30–60 MB/s |
| MultipeerConnectivity | iOS ↔ iOS | Bonjour + AWDL + BT LE | 30–50 MB/s |
| BLE beacon + LAN TCP | Android ↔ iOS (cross-platform) | BLE advertisement carrying `deviceId|ip|port` | LAN speed (best effort) |

The transfer engine (`@neardrop/core`) is untouched: it takes `ChannelLike` objects, and the plugin surfaces control messages over the bridge while **files never cross the JS bridge** — the native side streams them (`Payload.STREAM` / `sendResource`), which is what makes the ≥40 MB/s native target achievable. Pushing bytes through the Capacitor bridge would cap at ~10 MB/s.

## Layout

```
src/definitions.ts    NearbyTransport + NativeFilePush TypeScript interfaces
src/index.ts          registerPlugin() + transport auto-selection helpers
src/web.ts            explicit "unsupported" web fallback (→ LAN WebRTC / QR)
android/…/NearbyTransportPlugin.kt   Nearby Connections implementation
ios/NearDropPlugins/NearbyTransportPlugin.swift   MultipeerConnectivity implementation
```

## Android build steps

```bash
pnpm --filter @neardrop/web exec cap add android        # inside apps/web after capacitor init
# copy this package's android/ sources into the generated project:
cp -r packages/native-plugins/android/src/main/java/com apps/android/app/src/main/java/
# add to apps/android/app/src/main/AndroidManifest.xml (see plugin header comment):
#   BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT (API 31+)
#   ACCESS_FINE_LOCATION (API ≤ 30), NEARBY_WIFI_DEVICES (API 33+), INTERNET
# add to apps/android/app/build.gradle: implementation("com.google.android.gms:play-services-nearby:19.3.0")
# register plugin in MainActivity: registerPlugin(NearbyTransportPlugin::class.java)
pnpm --filter @neardrop/web exec cap sync android
pnpm --filter @neardrop/web exec cap open android        # build & run from Android Studio
```

Permissions explainer copy (shown at runtime, per spec):
- *Nearby devices* — "NearDrop finds phones around you to send files directly; files never go through any server."
- On Android 13+ the runtime dialog is `NEARBY_WIFI_DEVICES` / Bluetooth; on ≤ Android 12 it's location (system limitation — we never read GPS).

## iOS build steps

```bash
pnpm --filter @neardrop/web exec cap add ios
cp -r packages/native-plugins/ios/NearDropPlugins apps/ios/App/App/
# add NearbyTransportPlugin.swift to the Xcode target
# Info.plist:
#   NSLocalNetworkUsageDescription: "NearDrop finds devices near you to send files directly."
#   NSBonjourServices: [ "_neardrop._tcp" ]
pnpm --filter @neardrop/web exec cap sync ios
pnpm --filter @neardrop/web exec cap open ios
```

The Local Network permission prompt appears on first advertise/browse; Wi-Fi sharing between iOS devices uses AWDL even **without any shared network** — true hotspot-free discovery within ~10m.

## Share sheet integration

- **Android**: `<intent-filter>` for `ACTION_SEND`/`ACTION_SEND_MULTIPLE` with `text/*, image/*, video/*, application/*` → route to the PWA's share inbox via a `share intent` bridge, or use the existing Web Share Target POST flow in the PWA.
- **iOS**: a Share Extension target that writes files into the app group container and `openUrl`s into the main app (Capacitor `App` deep link) — the web app picks them up from the same `neardrop:share-inbox` IDB key.

## Cross-platform Android ↔ iOS (BLE + LAN TCP) — design notes

MultipeerConnectivity does not interop with Android, and Nearby Connections does not exist on iOS. The cross-platform path:

1. Both sides run a **BLE peripheral/central** (CoreBluetooth / android.bluetooth.le):
   - advertise service UUID `0000XXXX-…` with manufacturer data: `deviceId (16B) | ip (4B) | port (2B)` (+ device name hash).
   - scan for the same service.
2. After discovery, transfer runs over a **plain TCP socket on the shared Wi-Fi/hotspot** (Android `Socket`, iOS `Network.framework NWConnection`), still end-to-end encrypted with the session keys from the QR-independent handshake (the app already has Ed25519/ECDSA identities; wrap the socket in a TLS-like layer using the same WebCrypto primitives, or accept OS-level WPA2 protection on hotspot).

**Documented limitations (be honest with users):**
- BLE advertising rate is ~10 Hz on iOS → discovery takes 1–3s, sometimes longer.
- If both devices are on **different networks with no shared hotspot**, BLE-only transfer would be ~30 KB/s — we do **not** offer BLE transfer; you get discovery + "join my hotspot" instructions instead.
- Some Android OEMs aggressively throttle background BLE scanning.

This BLE+TCP path is intentionally **not implemented yet** in this repo — the two same-platform transports cover the vast majority of "Android-to-Android" / "iPhone-to-iPhone" use, and the web QR path covers everything else. File: `src/ble-transport-design.md` if you pick this up.

## Transport selection (mirrors spec: native > LAN WebRTC > QR)

```ts
import { detectCapabilities, pickTransport } from '@neardrop/native-plugins';
const kind = pickTransport(detectCapabilities()); // 'native' | 'lan-webrtc' | 'qr'
```
