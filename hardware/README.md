# Hardware Integration Guide: Bus Ticket Machine GPS Tracking

This guide explains how to connect an actual hardware Electronic Ticket Machine (ETM) or vehicle telematics unit to the Bus Tracker server so the bus transmits coordinates autonomously without requiring the driver or conductor's personal smartphone.

---

## 1. Supported Ticket Machine Architectures

Depending on the hardware deployed in your bus fleet, two primary architectures are supported:

### Option A: Smart Android POS Ticket Machine (Sunmi, Telpo, PAX, Wiseasy)
Most modern transit ticket machines run an embedded version of Android with built-in 4G LTE and GPS/GLONASS chipsets (used for geofencing fare stages).

* **How it works:** A lightweight background service runs continuously on the ticket machine alongside the ticketing app.
* **Operation:** Reads Android's `LocationManager` (`LocationManager.GPS_PROVIDER`) or `FusedLocationProviderClient` every 3 seconds.
* **Transmission:** Sends an HTTP POST to `/update-location` using OkHttp or standard HTTP client.
* **Advantage:** Zero extra hardware needed. Does not interfere with ticket printing or QR code scanning.
* **Sample Code:** See [`hardware/AndroidTicketMachineService.kt`](file:///d:/tracker/hardware/AndroidTicketMachineService.kt).

### Option B: Dedicated Embedded Microcontroller (ESP32 / ARM + 4G LTE + u-blox GPS)
For buses with standalone legacy mechanical ticket machines or where a dedicated tamper-proof black box is preferred.

* **Components:**
  1. **Microcontroller:** ESP32 (Dual-core 240MHz, low power).
  2. **Cellular Modem:** SIMCom SIM7600EI / A7670C (4G LTE CAT-1 with VoLTE & fallback).
  3. **GPS Receiver:** u-blox NEO-6M, NEO-8M, or NEO-M8N with ceramic active patch antenna.
  4. **Power Supply:** Automotive 12V/24V to 5V 3A DC-DC step-down buck converter with reverse polarity & surge protection.
* **Transmission:** Microcontroller parses NMEA `$GPRMC` sentences via UART, constructs JSON, and sends HTTP POST via AT commands or WiFi/4G socket.
* **Sample Code:** See [`hardware/esp32_gps_tracker.ino`](file:///d:/tracker/hardware/esp32_gps_tracker.ino).

---

## 2. API Specification for Hardware Devices

### Endpoint: `POST /update-location`
* **URL:** `https://<YOUR_RENDER_URL>/update-location`
* **Content-Type:** `application/json`
* **Authentication Header (Recommended for Production):**
  ```http
  X-API-KEY: your_secure_gps_api_key_here
  ```
  *(Or include `"apiKey": "your_secure_gps_api_key_here"` inside the JSON body)*

### JSON Payload Schema:
```json
{
  "lat": 12.971598,
  "lng": 77.594562,
  "accuracy": 4.5,
  "speed": 36,
  "heading": 85,
  "busId": "BUS-42",
  "routeId": "route-42",
  "source": "hardware",
  "timestamp": 1793175200000
}
```

### Field Definitions:
| Field | Type | Required | Description |
|---|---|---|---|
| `lat` | Float | Yes | Latitude in decimal degrees (-90.0 to 90.0) |
| `lng` | Float | Yes | Longitude in decimal degrees (-180.0 to 180.0) |
| `accuracy` | Float | Optional | GPS horizontal dilution / accuracy radius in meters |
| `speed` | Integer | Optional | Current ground speed in km/h (0 to 150) |
| `heading` | Integer | Optional | Vehicle bearing in degrees (0 to 360, 0 = North) |
| `busId` | String | Optional | Vehicle registration / Fleet identifier (e.g. `BUS-42`) |
| `routeId` | String | Optional | Route code (e.g. `route-42`) |
| `apiKey` | String | Optional | API Key if not passed via `X-API-KEY` HTTP header |

### Expected Server Response:
```json
{
  "status": "success",
  "message": "Location updated",
  "serverTime": 1793175200045,
  "busId": "BUS-42",
  "nextStop": "Richmond Circle",
  "etaMinutes": 3
}
```

---

## 3. Electrical & Physical Installation Guidelines

1. **Antenna Placement:**
   - Mount the active GPS antenna horizontally on top of the dashboard near the front windshield, facing upwards with an unobstructed view of the sky.
   - Avoid mounting under metallic window tints or windshield heating elements which attenuate satellite signals.
2. **Power Stability:**
   - Vehicle electrical systems fluctuate between 10V (engine crank) and 28V (alternator peak). Use an automotive step-down converter rated for up to 36V input with TVS transient suppression diodes.
   - Add a small 1000µF capacitor across the 5V rail to absorb transient voltage dips when the bus starter motor activates.
3. **Data Consumption:**
   - Each HTTP POST payload is ~180 bytes.
   - At a 3-second update interval:
     $$\text{Hourly Data} = 1200 \times 180 \text{ B} \approx 216 \text{ KB/hour}$$
     $$\text{Daily (14 hrs)} \approx 3 \text{ MB/day} \quad (\sim 90 \text{ MB/month})$$
   - Standard 1GB IoT SIM cards will run for over 10 months comfortably.

---

## 4. Testing Before Hardware Arrival

You do **not** need to wait for physical hardware to test the entire tracking flow:
1. **Interactive Demo Mode:** Click the "Play" demo button in the top right map controls of [`track.html`](file:///d:/tracker/track.html).
2. **Python Hardware Simulator:** Run `python scripts/simulate_hardware_gps.py` to transmit real-time telemetry from your workstation to the server with realistic speeds and headings.
3. **Conductor Mobile Panel:** Open [`conductor.html`](file:///d:/tracker/conductor.html) on any mobile browser.
