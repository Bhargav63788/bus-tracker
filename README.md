# 🚌 Real-Time Bus Tracker

A real-time transit tracking system built with Node.js, Express, Leaflet, and standard browser Geolocation APIs. Designed to track buses using the conductor's mobile phone or laptop browser GPS without requiring external hardware modules.

---

## 🌟 Features

- **Browser-Native GPS Tracking**: Uses the standard JavaScript `navigator.geolocation.watchPosition()` API on the conductor's mobile phone or laptop browser. No external GPS hardware, Arduino, or serial chips required.
- **Conductor-Only Control**: Only the conductor has access to **Start Tracking** and **Stop Tracking** controls on the dedicated conductor dashboard.
- **Automated Passenger Live Map**: Passengers view the bus's live location automatically on their map. No buttons or page refreshes needed.
- **Real-Time Socket.IO & WebSocket Streaming**: Instant sub-second coordinate push via Socket.IO with automatic fallback to HTTP polling.
- **Session-Aware Route Polyline**:
  - When the conductor starts tracking, a clean new session starts and the previous route polyline is cleared.
  - While tracking, a vibrant blue polyline follows the actual path traveled in real time.
  - When the conductor stops tracking, the completed journey's polyline remains visible on the map.
  - Micro-jitter (< 0.5m) and redundant duplicate coordinates are automatically filtered.
- **Actual GPS Data Integrity**:
  - Moves the bus marker and draws the polyline strictly according to the actual GPS coordinates received from the device.
  - No artificial warping, hardcoded snapping, or simulated routes.
  - Discards null-island glitches `(0, 0)` and out-of-bounds coordinates.
- **Smooth Vehicle Animation**: Marker smoothly glides and rotates with vehicle bearing using `requestAnimationFrame` cubic ease-out interpolation.
- **Map Tools**:
  - Satellite view and street view toggle.
  - One-click center on bus.
  - Real-time speed, accuracy, and session distance traveled.

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
- **Passenger Live Map:** [http://localhost:3000/track.html](http://localhost:3000/track.html)
- **Conductor Dashboard:** [http://localhost:3000/conductor.html](http://localhost:3000/conductor.html)
- **API Status:** [http://localhost:3000/api/status](http://localhost:3000/api/status)

---

## 📱 How to Use

### Step 1: Conductor Starts Tracking
1. Open [http://localhost:3000/conductor.html](http://localhost:3000/conductor.html) on the conductor's mobile phone or laptop browser.
2. Click **Start Tracking**.
3. When prompted by your browser, tap **Allow** for Location permissions.
4. Your device continuously streams high-accuracy GPS coordinates to the server.

### Step 2: Passengers View the Bus
1. Open [http://localhost:3000/track.html](http://localhost:3000/track.html) on any passenger device.
2. The page connects automatically and displays the live bus position and route polyline as the bus moves.

### Step 3: Conductor Finishes Trip
1. On the conductor dashboard, click **Stop Tracking**.
2. GPS tracking stops immediately. The passenger map marks the bus as **Stopped** while preserving the completed trip route for inspection.

---

## 🔒 Configuration & Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port for the Express server (Render injects this automatically). |
| `GPS_API_KEY` | *(None / Empty)* | Optional secret key for securing `/update-location`. |

---

## ☁️ Deployment on Render

This project is 100% compatible with Render deployment:
1. Push your updated code to GitHub:
   ```bash
   git add .
   git commit -m "Update bus tracker: browser GPS tracking with conductor controls"
   git push origin main
   ```
2. Render will automatically detect the changes and deploy.
