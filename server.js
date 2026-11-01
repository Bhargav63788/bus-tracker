const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// State Management: Real GPS & Tracking Sessions
// ----------------------------------------------------
let activeSession = {
  id: "session_" + Date.now(),
  status: "stopped", // "running" | "stopped"
  startTime: null,
  stopTime: null,
  history: [] // Points traveled strictly within the active session
};

let latestBusLocation = null;
const MAX_SESSION_HISTORY = 1000;

// Optional authentication key for hardware GPS / ticket machine
const GPS_API_KEY = process.env.GPS_API_KEY || "";

// In-memory cache for OSRM road snapping (avoids redundant queries)
const roadSnapCache = new Map();
const MAX_CACHE_ENTRIES = 500;

// ----------------------------------------------------
// Static Web Pages
// ----------------------------------------------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/track.html", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/conductor.html", (req, res) => res.sendFile(path.join(__dirname, "conductor.html")));
app.get("/bus.png", (req, res) => res.sendFile(path.join(__dirname, "bus.png")));

// ----------------------------------------------------
// Geodesic Math Utilities
// ----------------------------------------------------

// Haversine distance in kilometers
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Bearing calculation in degrees (0-360)
function calculateBearing(lat1, lon1, lat2, lon2) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

// Calculate total distance traveled strictly in the current session
function getSessionDistanceKm(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += getDistanceKm(
      points[i].lat,
      points[i].lng,
      points[i + 1].lat,
      points[i + 1].lng
    );
  }
  return Math.round(total * 100) / 100;
}

// ----------------------------------------------------
// Road & Highway Alignment using OSRM
// ----------------------------------------------------

/**
 * Snaps raw GPS coordinates to the nearest confirmed highway/road.
 * - Distance threshold: 35 meters. If nearest road is further than 35m
 *   (e.g., parking lot, bus depot, off-road bay), it does NOT snap.
 * - Always falls back to original GPS coordinates if OSRM is slow or offline.
 * - Preserves rawLat and rawLng as ground truth.
 */
function snapToNearestRoad(lat, lng) {
  return new Promise((resolve) => {
    // Check round-off cache key (approx 10-meter grid)
    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (roadSnapCache.has(cacheKey)) {
      return resolve(roadSnapCache.get(cacheKey));
    }

    const url = `https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`;
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "BusTracker/2.0 (RealTimeTransit)" },
        timeout: 1800
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => (rawData += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(rawData);
            if (data.code === "Ok" && data.waypoints && data.waypoints[0]) {
              const wp = data.waypoints[0];
              // Snap only if road is within 35 meters (prevents jumping to unrelated roads)
              if (wp.distance <= 35) {
                const snapped = {
                  lat: Number(wp.location[1].toFixed(6)),
                  lng: Number(wp.location[0].toFixed(6)),
                  roadName: wp.name || "Highway / Roadway",
                  snapDistance: Math.round(wp.distance * 10) / 10,
                  isSnapped: true
                };

                if (roadSnapCache.size > MAX_CACHE_ENTRIES) {
                  const firstKey = roadSnapCache.keys().next().value;
                  roadSnapCache.delete(firstKey);
                }
                roadSnapCache.set(cacheKey, snapped);
                return resolve(snapped);
              }
            }
          } catch (e) {
            // JSON parse error or unexpected response
          }
          // Out of threshold or non-road: retain raw coordinates
          resolve({
            lat,
            lng,
            roadName: null,
            snapDistance: 0,
            isSnapped: false
          });
        });
      }
    );

    req.on("error", () => {
      resolve({ lat, lng, roadName: null, snapDistance: 0, isSnapped: false });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ lat, lng, roadName: null, snapDistance: 0, isSnapped: false });
    });
  });
}

// ----------------------------------------------------
// WebSocket Real-Time Broadcast Service
// ----------------------------------------------------
const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on("connection", (ws) => {
  // Immediately transmit current state and active session history on connection
  ws.send(
    JSON.stringify({
      type: "state_init",
      data: {
        busLocation: latestBusLocation,
        session: {
          id: activeSession.id,
          status: activeSession.status,
          startTime: activeSession.startTime,
          stopTime: activeSession.stopTime,
          history: activeSession.history,
          distanceTraveledKm: getSessionDistanceKm(activeSession.history)
        },
        serverTime: Date.now()
      }
    })
  );

  ws.on("message", (msgStr) => {
    try {
      const msg = JSON.parse(msgStr);
      if (msg.type === "start_session") {
        startNewTrackingSession();
      } else if (msg.type === "stop_session") {
        stopActiveTrackingSession();
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      }
    } catch (err) {
      // Ignore malformed client frames
    }
  });
});

// ----------------------------------------------------
// Session Control Functions
// ----------------------------------------------------

function startNewTrackingSession() {
  const newSessionId = "session_" + Date.now();
  activeSession = {
    id: newSessionId,
    status: "running",
    startTime: Date.now(),
    stopTime: null,
    history: [] // Fresh clean array for this new session
  };

  broadcast({
    type: "session_started",
    sessionId: newSessionId,
    timestamp: activeSession.startTime
  });

  return activeSession;
}

function stopActiveTrackingSession() {
  activeSession.status = "stopped";
  activeSession.stopTime = Date.now();

  broadcast({
    type: "session_stopped",
    sessionId: activeSession.id,
    timestamp: activeSession.stopTime,
    historyCount: activeSession.history.length
  });

  return activeSession;
}

// ----------------------------------------------------
// REST Endpoints
// ----------------------------------------------------

// POST /start-session: Begins a new tracking session
app.post("/start-session", (req, res) => {
  const session = startNewTrackingSession();
  res.json({
    status: "success",
    message: "Tracking session started",
    sessionId: session.id,
    startTime: session.startTime
  });
});

// POST /stop-session: Stops tracking, preserving completed session route
app.post("/stop-session", (req, res) => {
  const session = stopActiveTrackingSession();
  res.json({
    status: "success",
    message: "Tracking session stopped",
    sessionId: session.id,
    stopTime: session.stopTime,
    completedPoints: session.history.length
  });
});

// POST /clear-history: Clears history of current session
app.post("/clear-history", (req, res) => {
  activeSession.history = [];
  broadcast({
    type: "history_cleared",
    sessionId: activeSession.id
  });
  res.json({ status: "success", message: "Route history cleared" });
});

// POST /update-location: Receives live GPS from hardware / conductor
app.post("/update-location", async (req, res) => {
  const body = req.body || {};
  const {
    lat,
    lng,
    accuracy,
    speed,
    heading,
    busId,
    source,
    timestamp,
    sessionId,
    startSession
  } = body;

  // Optional authentication check
  if (GPS_API_KEY) {
    const headerKey = req.headers["x-api-key"] || "";
    const authHeader = req.headers["authorization"] || "";
    const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const bodyKey = body.apiKey || "";

    if (
      headerKey !== GPS_API_KEY &&
      bearerKey !== GPS_API_KEY &&
      bodyKey !== GPS_API_KEY
    ) {
      return res.status(401).json({ error: "Unauthorized: Invalid GPS API key" });
    }
  }

  // Strict coordinate validation
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lng !== "number" ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180 ||
    (lat === 0 && lng === 0) || // Reject null island GPS initialization artifacts
    (accuracy !== undefined &&
      (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0))
  ) {
    return res.status(400).json({ error: "Invalid GPS coordinates" });
  }

  // Auto-start session if requested or if transmitter passed a new session
  if (startSession && activeSession.status !== "running") {
    startNewTrackingSession();
  }

  const now = Date.now();
  let computedHeading =
    typeof heading === "number" && !isNaN(heading) ? (heading + 360) % 360 : null;
  let computedSpeed =
    typeof speed === "number" && !isNaN(speed) && speed >= 0 ? Math.round(speed) : null;

  // Speed and bearing calculation from previous point
  if (latestBusLocation) {
    const distKm = getDistanceKm(latestBusLocation.lat, latestBusLocation.lng, lat, lng);
    const timeSec = Math.max((now - latestBusLocation.updatedAt) / 1000, 1);

    // Bearing calculation for movement > 3 meters
    if (computedHeading === null && distKm > 0.003) {
      computedHeading = Math.round(
        calculateBearing(latestBusLocation.lat, latestBusLocation.lng, lat, lng)
      );
    } else if (computedHeading === null) {
      computedHeading = latestBusLocation.heading || 0;
    }

    // Speed calculation if not reported by GPS chip
    if (computedSpeed === null && distKm > 0.002) {
      computedSpeed = Math.round(distKm / (timeSec / 3600));
      if (computedSpeed > 140) computedSpeed = 140; // clamp realistic bounds
    }
  }

  if (computedHeading === null) computedHeading = 0;
  if (computedSpeed === null) computedSpeed = 0;

  // Highway / Road Alignment via OSRM
  const roadMatch = await snapToNearestRoad(lat, lng);
  const displayLat = roadMatch.isSnapped ? roadMatch.lat : lat;
  const displayLng = roadMatch.isSnapped ? roadMatch.lng : lng;

  const locationPayload = {
    lat: displayLat,
    lng: displayLng,
    rawLat: lat,
    rawLng: lng,
    roadName: roadMatch.roadName,
    isSnapped: roadMatch.isSnapped,
    accuracy: accuracy !== undefined ? Math.round(accuracy) : null,
    speed: computedSpeed,
    heading: computedHeading,
    busId: busId || (latestBusLocation && latestBusLocation.busId) || "BUS-01",
    source: source || "gps",
    updatedAt: now,
    clientTimestamp: timestamp || now,
    sessionId: activeSession.id,
    sessionStatus: activeSession.status
  };

  latestBusLocation = locationPayload;

  // Record point to active session history if session is active
  if (activeSession.status === "running") {
    // Prevent duplicate coordinate clustering (< 1.5m movement)
    const history = activeSession.history;
    const lastPoint = history[history.length - 1];
    let isDuplicate = false;

    if (lastPoint) {
      const distM = getDistanceKm(lastPoint.lat, lastPoint.lng, displayLat, displayLng) * 1000;
      if (distM < 1.5 && (now - lastPoint.timestamp) < 2000) {
        isDuplicate = true;
      }
    }

    if (!isDuplicate) {
      history.push({
        lat: displayLat,
        lng: displayLng,
        rawLat: lat,
        rawLng: lng,
        speed: computedSpeed,
        heading: computedHeading,
        roadName: roadMatch.roadName,
        timestamp: now
      });

      if (history.length > MAX_SESSION_HISTORY) {
        history.shift();
      }
    }
  }

  // Push immediate real-time update to all WebSocket connected browser clients
  broadcast({
    type: "location_update",
    data: locationPayload,
    sessionDistanceKm: getSessionDistanceKm(activeSession.history),
    sessionStatus: activeSession.status
  });

  res.json({
    status: "success",
    message: "Location updated",
    serverTime: now,
    lat: displayLat,
    lng: displayLng,
    rawLat: lat,
    rawLng: lng,
    roadName: roadMatch.roadName,
    speed: computedSpeed,
    sessionStatus: activeSession.status
  });
});

// GET /get-location: Polling fallback and initial state query
app.get("/get-location", (req, res) => {
  if (!latestBusLocation) {
    return res.json({
      hasLocation: false,
      sessionStatus: activeSession.status,
      sessionId: activeSession.id,
      history: []
    });
  }

  const now = Date.now();
  const ageSeconds = Math.round((now - latestBusLocation.updatedAt) / 1000);

  let connectionStatus = "online";
  if (activeSession.status === "stopped") {
    connectionStatus = "stopped";
  } else if (ageSeconds > 90) {
    connectionStatus = "offline";
  } else if (ageSeconds > 25) {
    connectionStatus = "stale";
  }

  res.json({
    ...latestBusLocation,
    hasLocation: true,
    serverTime: now,
    ageSeconds,
    status: connectionStatus,
    isStale: connectionStatus === "stale",
    isOffline: connectionStatus === "offline",
    distanceTraveledKm: getSessionDistanceKm(activeSession.history),
    sessionId: activeSession.id,
    sessionStatus: activeSession.status,
    history: activeSession.history
  });
});

// Health check
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    hasActiveBus: !!latestBusLocation,
    sessionStatus: activeSession.status,
    sessionId: activeSession.id,
    historyPoints: activeSession.history.length,
    lastUpdateAgeSeconds: latestBusLocation
      ? Math.round((Date.now() - latestBusLocation.updatedAt) / 1000)
      : null
  });
});

// ----------------------------------------------------
// Server Startup with Port Fallback
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;

function startServer(port) {
  const srv = server.listen(port, () => {
    console.log(`🚌 Bus Tracker Server running on port ${port}`);
    console.log(`👉 Live Tracking: http://localhost:${port}/track.html`);
    console.log(`👉 Conductor Console: http://localhost:${port}/conductor.html`);
  });

  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const nextPort = Number(port) + 1;
      console.warn(`⚠️ Port ${port} is in use. Trying port ${nextPort}...`);
      startServer(nextPort);
    } else {
      console.error("Server error:", err);
    }
  });

  return srv;
}

startServer(PORT);

module.exports = { app, server };
