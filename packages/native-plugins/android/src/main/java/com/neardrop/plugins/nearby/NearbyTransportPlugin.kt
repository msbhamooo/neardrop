package com.neardrop.plugins.nearby

import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy

/**
 * NearDrop native discovery via Google Nearby Connections.
 *
 * Strategy.P2P_POINT_TO_POINT per the spec. Files are pushed as STREAM payloads —
 * bytes are copied natively (WebRTC-style JS chunking is NOT used here), which is
 * what makes the >=40MB/s native target achievable.
 *
 * Requires in AndroidManifest.xml:
 *   <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
 *   <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
 *   <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
 *   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
 *   <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />
 *   <uses-permission android:name="android.permission.INTERNET" />
 * (BLUETOOTH_*/NEARBY_WIFI_DEVICES need runtime requests on API 31+/33+.)
 */
@CapacitorPlugin(name = "NearbyTransport")
class NearbyTransportPlugin : Plugin() {

    companion object {
        private const val SERVICE_ID = "com.neardrop.v1"
    }

    private val pendingConnections = mutableMapOf<String, PluginCall>()
    private val openChannels = mutableMapOf<String, String>() // channelId -> endpointId

    private val connectionLifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // NOTE: real builds must surface info.authenticationToken (the short numeric code)
            // to the user, matching the web app's 4-emoji comparison. Accept after user OK.
            Nearby.getConnectionsClient(context).acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            val call = pendingConnections.remove(endpointId)
            when (result.status.statusCode) {
                ConnectionsStatusCodes.STATUS_OK -> {
                    val channelId = "ch-$endpointId"
                    openChannels[channelId] = endpointId
                    call?.resolve(JSObject().put("channelId", channelId))
                }
                else -> call?.reject("connection failed: ${result.status.statusCode}")
            }
        }

        override fun onDisconnected(endpointId: String) {
            openChannels.entries.removeIf { it.value == endpointId }
            notifyListeners("peer-lost", JSObject().put("id", endpointId))
        }
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            notifyListeners(
                "peer-found",
                JSObject()
                    .put("id", info.endpointName) // device id (public-key fingerprint)
                    .put("endpointId", endpointId)
                    .put("name", info.endpointName.substringBefore('|'))
            )
        }

        override fun onEndpointLost(endpointId: String) {
            notifyListeners("peer-lost", JSObject().put("id", endpointId))
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> {
                    val text = payload.asBytes()?.toString(Charsets.UTF_8) ?: return
                    notifyListeners(
                        "message",
                        JSObject().put("channelId", "ch-$endpointId").put("data", text)
                    )
                }
                Payload.Type.STREAM -> { /* receiving side: stream to a file in app cache */ }
                else -> {}
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            notifyListeners(
                "progress",
                JSObject()
                    .put("channelId", "ch-$endpointId")
                    .put("payloadId", update.payloadId)
                    .put("bytes", update.bytesTransferred)
                    .put("totalBytes", update.totalBytes)
                    .put("status", update.status)
            )
        }
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("missing id")
        val name = call.getString("name") ?: "NearDrop device"
        val options = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
        Nearby.getConnectionsClient(context)
            .startAdvertising("$name|$id", SERVICE_ID, connectionLifecycle, options)
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("advertise failed: ${it.message}") }
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        Nearby.getConnectionsClient(context).stopAdvertising()
        call.resolve()
    }

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        val options = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
        Nearby.getConnectionsClient(context)
            .startDiscovery(SERVICE_ID, discovery, options)
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("discovery failed: ${it.message}") }
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) {
        Nearby.getConnectionsClient(context).stopDiscovery()
        call.resolve()
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("missing peerId")
        pendingConnections[peerId] = call
        Nearby.getConnectionsClient(context)
            .requestConnection(peerId, "neardrop", connectionLifecycle)
            .addOnFailureListener {
                pendingConnections.remove(peerId)
                call.reject("requestConnection failed: ${it.message}")
            }
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val channelId = call.getString("channelId") ?: return call.reject("missing channelId")
        val data = call.getString("data") ?: return call.reject("missing data")
        val endpointId = openChannels[channelId] ?: return call.reject("unknown channel")
        Nearby.getConnectionsClient(context)
            .sendPayload(endpointId, Payload.fromBytes(data.toByteArray(Charsets.UTF_8)))
        call.resolve()
    }

    /**
     * Native-side file push: content URIs straight to STREAM payloads.
     * Bytes never cross the JS bridge — this is the fast path.
     */
    @PluginMethod
    fun sendFilesNative(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("missing peerId")
        val uris = call.getArray("uris") ?: return call.reject("missing uris")
        val ctx: Context = context
        val client = Nearby.getConnectionsClient(ctx)
        for (i in 0 until uris.length()) {
            val uri = uris.getString(i)
            try {
                val file = java.io.File(uri.removePrefix("file://"))
                if (file.exists()) {
                    client.sendPayload(peerId, Payload.fromFile(file))
                } else {
                    ctx.contentResolver.openInputStream(android.net.Uri.parse(uri))?.use { input ->
                        val pipe = java.io.PipedOutputStream()
                        val sink = java.io.PipedInputStream(pipe, 8 * 1024 * 1024)
                        Thread {
                            try {
                                input.copyTo(pipe)
                            } catch (_: Exception) {
                            } finally {
                                try { pipe.close() } catch (_: Exception) {}
                            }
                        }.start()
                        client.sendPayload(peerId, Payload.fromStream(sink))
                    }
                }
            } catch (e: Exception) {
                call.reject("file $i failed: ${e.message}")
                return
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        Nearby.getConnectionsClient(context).stopAllEndpoints()
        call.resolve()
    }
}
