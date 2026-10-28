# 🚌 Professional Real-Time Bus Tracker

A professional, Google Maps-style transit tracking system built with Node.js, Express, Leaflet, and modern CSS/JavaScript. Supports live vehicle tracking with smooth marker interpolation, dynamic ETAs, bus stop timelines, conductor mobile broadcasting, and autonomous hardware GPS integration (Electronic Ticket Machines / IoT black boxes).

---

## 🌟 Upgraded Features

- **Google Maps Transit Aesthetic**: Full-screen vector transit map with CartoDB Voyager styling, satellite view toggle, and Google Maps-style floating action buttons.
- **Smooth Real-Time Tracking**: Coordinates update with smooth `requestAnimationFrame` cubic interpolation instead of abrupt marker jumping.
- **Directional Heading**: Custom high-DPI bus marker with 360° heading arrow and animated radar ping waves.
- **Route & Dynamic ETA**:
  - Double-layer transit polyline casing along realistic transit corridors.
  - Interactive bus stops with sequence numbers and popup details.
  - Dynamic Next Stop indicator with live ETA calculation (in minutes) based on vehicle speed.
  - Remaining distance and transit progress bar.
  - Expandable stop-by-stop itinerary drawer.
- **Autonomous Hardware GPS Integration**:
  - Direct support for Electronic Ticket Machines (ETMs) and Android POS terminals (Sunmi, PAX, Telpo) via background telemetry service.
  - Ready-to-flash ESP32 + SIM7600 4G LTE + u-blox GPS firmware template.
  - Hardware authentication via `X-API-KEY` or Bearer token.
- **Reliability & Telemetry Health**:
  - Live status indicator: **LIVE** (green pulse), **WEAK SIGNAL** (amber, >30s), or **SIGNAL LOST** (red, >90s).
  - Network failure handling with automatic retry banner.
  - Breadcrumb trails showing recently traveled path.
- **Testing & Simulation Mode**:
  - One-click interactive Demo/Simulation button on the live map.
  - Standalone Python hardware simulator script (`scripts/simulate_hardware_gps.py`).
  - Enhanced Conductor mobile panel (`conductor.html`) with live telemetry indicators.
- **100% Backward Compatible**: Retains original Render deployment paths, package scripts, and legacy `/update-location` coordinate payload support.

---

## 🚀 Quick Start (Running Locally)

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
# or: node server.js
```
The server will start at: **`http://localhost:3000`**

### 3. Open in Your Browser
- **Live Transit Tracker:** [http://localhost:3000/track.html](http://localhost:3000/track.html)
- **Conductor Console:** [http://localhost:3000/conductor.html](http://localhost:3000/conductor.html)
- **API Status:** [http://localhost:3000/api/status](http://localhost:3000/api/status)

---

## 🎮 How to Test Live Tracking

You can test live movement in any of these 3 ways:

### Method 1: One-Click Demo Mode (Easiest)
1. Open [http://localhost:3000/track.html](http://localhost:3000/track.html) in your browser.
2. In the floating action buttons on the right side of the map, click the **Play (▶)** button.
3. The server will start continuous autonomous movement along Express Route 42. You will see the bus glide smoothly along roads, rotate with headings, and update next-stop ETAs in real time!

### Method 2: Hardware Simulator Script
Run the Python simulator from your project directory (uses the `.venv` virtual environment):
```bash
.\.venv\Scripts\python.exe scripts/simulate_hardware_gps.py
```
This sends real-time GPS packets every 2.8 seconds with realistic speed, heading, and accuracy variations, exactly as a physical bus ticket machine would.

### Method 3: Mobile Conductor Console
1. Open [http://localhost:3000/conductor.html](http://localhost:3000/conductor.html) on a mobile device or browser.
2. Click **Start Broadcasting**. Your device's GPS coordinates will be sent to the server.

---

## 🛰️ Hardware GPS Integration (Ticket Machines & Black Boxes)

To track the bus autonomously without requiring the driver or conductor to keep a phone browser open, the system is designed to accept coordinates from hardware devices.

See the complete guide in [`hardware/README.md`](file:///d:/tracker/hardware/README.md).

### API Endpoint for Hardware:
- **URL:** `POST /update-location`
- **Headers:** `Content-Type: application/json`, `X-API-KEY: <optional_key>`
- **Payload:**
```json
{
  "lat": 12.971598,
  "lng": 77.594562,
  "accuracy": 4.5,
  "speed": 34,
  "heading": 85,
  "busId": "BUS-42",
  "routeId": "route-42",
  "source": "hardware",
  "timestamp": 1793175200000
}
```

### Ready-Made Firmware & Code:
- **Android POS Terminal (Sunmi, Telpo, PAX):** [`hardware/AndroidTicketMachineService.kt`](file:///d:/tracker/hardware/AndroidTicketMachineService.kt)
- **ESP32 + 4G LTE Modem + GPS Module:** [`hardware/esp32_gps_tracker.ino`](file:///d:/tracker/hardware/esp32_gps_tracker.ino)

---

## 🔒 Configuration & Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port for the Express server (Render injects this automatically). |
| `GPS_API_KEY` | *(None / Empty)* | Optional secret key for securing `/update-location`. If set, GPS hardware and conductor panels must supply matching `X-API-KEY` or Bearer token. |

---

## ☁️ Deployment on Render

This project is 100% compatible with your existing Render deployment:
1. Push your updated code to GitHub:
   ```bash
   git add .
   git commit -m "Upgrade bus tracker to Google Maps transit tracking with hardware GPS support"
   git push origin main
   ```
2. Render will automatically detect the changes, run `npm install`, and start with `npm start`.
3. If you want to enable API key authentication in production, add `GPS_API_KEY` under **Environment Variables** in your Render dashboard.
