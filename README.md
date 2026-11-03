# 🚌 Real-Time Bus Tracker

A real-time transit tracking system built with Node.js, Express, Leaflet, and standard browser Geolocation APIs. Designed to track buses using the conductor's mobile phone or laptop browser GPS without requiring external hardware modules.

---

## 🌟 Features

- **Map-Based Visual Route Drawing System**:
  - Full-screen interactive Leaflet OpenStreetMap canvas (`/route-editor.html`).
  - **Click-to-Draw**: Draw entire routes directly by clicking along roads without manually typing addresses or searching stops.
  - **OSRM Road Snapping**: Points automatically snap into true road geometry curves instead of straight lines.
  - **Dynamic Route Manipulation**: Drag route waypoints to adjust curves or click on the route polyline to bend it with intermediate points.
  - **Designated Bus Stops**: Click anywhere along the route to drop bus stops (🚏) with automatic sequencing and renaming.
  - **Undo / Redo & Keyboard Shortcuts**: Full `Ctrl+Z` (Undo) and `Ctrl+Y` (Redo) history tracking.
  - **Automated Distance & Travel Time**: Dynamically computes total kilometers and estimated travel duration.
  - **Route Persistence & Editing**: Save routes to persistent backend storage (`data/routes.json`), load saved routes to edit them, or activate a route for live tracking.
  - **Unified Live Sync**: The active planned route and bus stops are displayed directly on the passenger map (`/track.html`) and conductor dashboard (`/conductor.html`).
- **Strict Route-Restricted GPS Tracking**:
  - **Route Assignment**: The conductor selects the assigned route from saved routes directly on the conductor dashboard (`conductor.html`).
  - **Start Restriction**: Tracking can ONLY be started if the conductor is physically on or within the permitted corridor (default 100m) of the selected route. If outside, tracking is strictly blocked with: `"You are outside the selected bus route. Move to the route to start tracking."`
  - **Continuous Route Validation**: Distance from the bus GPS position to the route geometry is calculated in real time.
  - **Automatic Passenger Privacy Shielding**: If the bus departs from the permitted corridor (>100m away), live coordinate publishing is paused immediately. Passengers are notified with `OFF ROUTE` status and the bus marker is hidden. **Off-route GPS coordinates are never broadcast or exposed.**
  - **Auto-Resume**: When the bus returns within the permitted route corridor, location broadcasting resumes automatically.
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
- **Visual Route Planner:** [http://localhost:3000/route-editor.html](http://localhost:3000/route-editor.html)
- **Passenger Live Map:** [http://localhost:3000/track.html](http://localhost:3000/track.html)
- **Conductor Dashboard:** [http://localhost:3000/conductor.html](http://localhost:3000/conductor.html)
- **API Status:** [http://localhost:3000/api/status](http://localhost:3000/api/status)

---

## 🗺️ How to Use the Visual Route Drawing System

1. Open [http://localhost:3000/route-editor.html](http://localhost:3000/route-editor.html).
2. Click **Start Drawing Route** (the map cursor switches to a crosshair).
3. Click anywhere along the roads on the map to place waypoints:
   - First click places the **Origin** (🏁 green pin).
   - Second and subsequent clicks place road points and automatically snap the route along real roads using OSRM!
   - Last click becomes the **Destination** (🎯 red pin).
4. **Drag & Bend Waypoints**: Click and drag any pin to adjust the route around curves, or click directly on the blue road line to insert a bend point.
5. **Drop Bus Stops**: Click **Add Bus Stops** mode and click along the route to place designated bus stops (🚏). Click a stop marker to rename it or delete it.
6. **Undo / Redo**: Use the toolbar buttons or `Ctrl+Z` / `Ctrl+Y` keyboard shortcuts.
7. Click **Finish & Save**: Review the distance, estimated duration, and stops preview. Check "Set as Active Route" and click **Save Route to Database**.
8. Open the **Saved Routes (📁)** drawer at any time to load, edit, activate, or delete existing routes.

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
| `ROUTE_TOLERANCE_METERS` | `100` | Maximum distance (meters) the bus can deviate from the route geometry before publishing is paused. |

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
