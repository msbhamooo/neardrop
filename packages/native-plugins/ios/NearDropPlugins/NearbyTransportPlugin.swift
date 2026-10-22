import Foundation
import MultipeerConnectivity
import Capacitor

/**
 * NearDrop native discovery via MultipeerConnectivity (iOS ⇄ iOS).
 *
 * Discovery/advertising over Bonjour + BT LE, transfer over the best available
 * transport (Wi-Fi peer-to-peer when shared network, else AWDL, else BT).
 * File pushes use MCSession.sendResource — bytes are copied natively.
 *
 * Info.plist requires:
 *   NSLocalNetworkUsageDescription — "NearDrop finds devices near you to send files directly."
 *   NSBonjourServices — [ "_neardrop._tcp" ]
 */
@objc(NearbyTransportPlugin)
public class NearbyTransportPlugin: CAPPlugin {
    private static let serviceType = "neardrop"
    private static let discoveryInfoKey = "neardrop"

    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var session: MCSession?
    private var localPeer: MCPeerID?

    // MARK: - Advertising

    @objc func startAdvertising(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? "unknown"
        let name = call.getString("name") ?? "NearDrop device"
        let local = MCPeerID(displayName: "\(name)|\(id)")
        localPeer = local
        session = MCSession(peer: local, securityIdentity: nil, encryptionPreference: .required)
        session?.delegate = self

        let advertiser = MCNearbyServiceAdvertiser(peer: local, discoveryInfo: ["nd": id], serviceType: Self.serviceType)
        advertiser.delegate = self
        advertiser.startAdvertisingPeer()
        self.advertiser = advertiser
        call.resolve()
    }

    @objc func stopAdvertising(_ call: CAPPluginCall) {
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        call.resolve()
    }

    // MARK: - Discovery

    @objc func startDiscovery(_ call: CAPPluginCall) {
        if localPeer == nil {
            // discovery without advertising: create an anonymous identity
            let local = MCPeerID(displayName: "neardrop|anon")
            localPeer = local
            session = MCSession(peer: local, securityIdentity: nil, encryptionPreference: .required)
            session?.delegate = self
        }
        let browser = MCNearbyServiceBrowser(peer: localPeer!, serviceType: Self.serviceType)
        browser.delegate = self
        browser.startBrowsingForPeers()
        self.browser = browser
        call.resolve()
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        browser?.stopBrowsingForPeers()
        browser = nil
        call.resolve()
    }

    // MARK: - Connect / send

    @objc func connect(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId") else { return call.reject("missing peerId") }
        guard let session else { return call.reject("no session") }
        // peerId is the MCPeerID displayName we surfaced through peer-found
        guard let peer = session.connectedPeers.first(where: { $0.displayName == peerId }) ?? invitedPeers[peerId] else {
            browser?.invitePeer(MCPeerID(displayName: peerId), to: session, withContext: nil, timeout: 15)
            invitedCalls[peerId] = call
            return
        }
        call.resolve(["channelId": "ch-\(peer.displayName)"])
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let channelId = call.getString("channelId"),
              let data = call.getString("data"),
              let session else { return call.reject("bad request") }
        let peerName = String(channelId.dropFirst(3))
        guard let peer = session.connectedPeers.first(where: { $0.displayName == peerName }) else {
            return call.reject("peer not connected")
        }
        do {
            try session.send(data.data(using: .utf8)!, toPeers: [peer], with: .reliable)
            call.resolve()
        } catch {
            call.reject("send failed: \(error.localizedDescription)")
        }
    }

    /** Native fast path: sendResource with a file URL — no bytes through the JS bridge. */
    @objc func sendFilesNative(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId"),
              let session,
              let peer = session.connectedPeers.first(where: { $0.displayName == peerId }) else {
            return call.reject("peer not connected")
        }
        guard let uris = call.getArray("uris", String.self) else { return call.reject("missing uris") }
        for (index, uri) in uris.enumerated() {
            let url = URL(fileURLWithPath: uri.replacingOccurrences(of: "file://", with: ""))
            session.sendResource(at: url, withName: url.lastPathComponent, toPeer: peer) { error in
                if let error {
                    call.reject("file \(index) failed: \(error.localizedDescription)")
                }
            }
            // progress reporting uses session(_:didStartReceivingResourceWithName:...)
        }
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        advertiser?.stopAdvertisingPeer()
        browser?.stopBrowsingForPeers()
        session?.disconnect()
        call.resolve()
    }

    private var invitedPeers: [String: MCPeerID] = [:]
    private var invitedCalls: [String: CAPPluginCall] = [:]
}

extension NearbyTransportPlugin: MCNearbyServiceAdvertiserDelegate {
    public func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                           withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        // auto-accept trusted peers; real builds must compare a short verification token
        // (the web app shows 4 emojis for this) before accepting unknown peers.
        invitationHandler(true, session)
    }
}

extension NearbyTransportPlugin: MCNearbyServiceBrowserDelegate {
    public func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        invitedPeers[peerID.displayName] = peerID
        let parts = peerID.displayName.split(separator: "|", maxSplits: 1)
        let name = parts.first.map(String.init) ?? peerID.displayName
        let id = info?["nd"] ?? String(parts.last ?? peerID.displayName.suffix(16))
        notifyListeners("peer-found", data: [
            "id": id,
            "name": name,
            "endpointId": peerID.displayName,
            "deviceType": "phone",
        ])
    }

    public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        notifyListeners("peer-lost", data: ["id": peerID.displayName])
    }
}

extension NearbyTransportPlugin: MCSessionDelegate {
    public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connected:
            if let pending = invitedCalls.removeValue(forKey: peerID.displayName) {
                pending.resolve(["channelId": "ch-\(peerID.displayName)"])
            }
        case .notConnected:
            if let pending = invitedCalls.removeValue(forKey: peerID.displayName) {
                pending.reject("connection failed")
            }
            notifyListeners("peer-lost", data: ["id": peerID.displayName])
        default:
            break
        }
    }

    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        if let text = String(data: data, encoding: .utf8) {
            notifyListeners("message", data: [
                "channelId": "ch-\(peerID.displayName)",
                "data": text,
            ])
        }
    }

    public func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {
        // incoming native file stream — write to app cache
    }

    public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String,
                        fromPeer peerID: MCPeerID, with progress: Progress) {
        notifyListeners("progress", data: [
            "channelId": "ch-\(peerID.displayName)",
            "bytes": Int(progress.completedUnitCount),
            "totalBytes": Int(progress.totalUnitCount),
            "name": resourceName,
        ])
    }

    public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String,
                        fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {
        notifyListeners("file-done", data: [
            "channelId": "ch-\(peerID.displayName)",
            "name": resourceName,
            "path": localURL?.path ?? NSNull(),
        ])
    }
}
