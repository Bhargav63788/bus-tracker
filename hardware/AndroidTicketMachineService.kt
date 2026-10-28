package com.bustracker.hardware

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * Background Service for Android-based Electronic Ticket Machines (Sunmi, PAX, Telpo).
 * Runs seamlessly in the background while the ticketing/POS application is active.
 * Reads GPS coordinates every 3 seconds and posts telemetry to the Bus Tracker server.
 */
class AndroidTicketMachineService : Service(), LocationListener {

    companion object {
        private const val TAG = "BusTrackerHardware"
        private const val SERVER_URL = "https://your-bus-tracker.onrender.com/update-location"
        private const val GPS_API_KEY = "your_secure_gps_api_key_here"
        private const val BUS_ID = "BUS-42"
        private const val ROUTE_ID = "route-42"
        private const val NOTIFICATION_CHANNEL_ID = "bus_tracker_gps_channel"
        private const val NOTIFICATION_ID = 4201
    }

    private lateinit var locationManager: LocationManager
    private val httpClient = OkHttpClient()
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Hardware GPS Telemetry Service Created")
        startForeground(NOTIFICATION_ID, createNotification())

        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager

        try {
            // Request high accuracy GPS updates every 3000ms with min distance 1 meter
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                3000L,
                1.0f,
                this
            )
        } catch (ex: SecurityException) {
            Log.e(TAG, "GPS Permission missing: ${ex.message}")
        }
    }

    override fun onLocationChanged(location: Location) {
        val lat = location.latitude
        val lng = location.longitude
        val accuracy = if (location.hasAccuracy()) location.accuracy else null
        val speedKmH = if (location.hasSpeed()) (location.speed * 3.6).toInt() else null
        val heading = if (location.hasBearing()) location.bearing.toInt() else null

        Log.d(TAG, "GPS Fix: ($lat, $lng), Speed: $speedKmH km/h, Heading: $heading°")

        transmitToServer(lat, lng, accuracy, speedKmH, heading)
    }

    private fun transmitToServer(lat: Double, lng: Double, accuracy: Float?, speedKmH: Int?, heading: Int?) {
        val payload = JSONObject().apply {
            put("lat", lat)
            put("lng", lng)
            if (accuracy != null) put("accuracy", accuracy.toDouble())
            if (speedKmH != null) put("speed", speedKmH)
            if (heading != null) put("heading", heading)
            put("busId", BUS_ID)
            put("routeId", ROUTE_ID)
            put("source", "ticket_machine_pos")
            put("timestamp", System.currentTimeMillis())
        }

        val request = Request.Builder()
            .url(SERVER_URL)
            .addHeader("Content-Type", "application/json")
            .addHeader("X-API-KEY", GPS_API_KEY)
            .post(payload.toString().toRequestBody(jsonMediaType))
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "Network telemetry upload failed (will retry on next fix): ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (it.isSuccessful) {
                        Log.v(TAG, "Telemetry acknowledged by server: ${it.code}")
                    } else {
                        Log.e(TAG, "Server rejected coordinates: ${it.code}")
                    }
                }
            }
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        locationManager.removeUpdates(this)
        Log.i(TAG, "Hardware GPS Telemetry Service Stopped")
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    private fun createNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Bus Tracker Telemetry",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }

        return Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Bus Telemetry Active")
            .setContentText("Broadcasting live GPS coordinates from ticket machine")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .build()
    }
}
