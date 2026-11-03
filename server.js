const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with cross-origin support and heartbeat configuration for Render
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  transports: ["websocket", "polling"]
});

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
const MAX_SESSION_HISTORY = 2000;

// Optional authentication key for conductor location updates
const GPS_API_KEY = process.env.GPS_API_KEY || "";

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

  // Broadcast session start to all passenger dashboards
  io.emit("session_started", {
    sessionId: newSessionId,
    timestamp: activeSession.startTime
  });

  console.log(`[SESSION] Started new tracking session: ${newSessionId}`);
  return activeSession;
}

function stopActiveTrackingSession() {
  activeSession.status = "stopped";
  activeSession.stopTime = Date.now();

  // Broadcast session stop to all passenger dashboards
  io.emit("session_stopped", {
    sessionId: activeSession.id,
    timestamp: activeSession.stopTime,
    historyCount: activeSession.history.length
  });

  console.log(`[SESSION] Stopped tracking session: ${activeSession.id}`);
  return activeSession;
}

// ----------------------------------------------------
// Socket.IO Real-Time Connection Handling
// ----------------------------------------------------

io.on("connection", (socket) => {
  // Immediately send initial state to the newly connected client
  socket.emit("state_init", {
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
  });

  // Handle conductor session actions over Socket.IO
  socket.on("conductor_start_session", () => {
    startNewTrackingSession();
  });

  socket.on("conductor_stop_session", () => {
    stopActiveTrackingSession();
  });

  socket.on("conductor_location_update", (data) => {
    processLocationUpdate(data);
  });
});

// ----------------------------------------------------
// Core Location Processing Function
// ----------------------------------------------------

function processLocationUpdate(body = {}) {
  const {
    lat,
    lng,
    accuracy,
    speed,
    heading,
    busId,
    source,
    timestamp,
    startSession
  } = body;

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
    return { error: "Invalid GPS coordinates", status: 400 };
  }

  // Auto-start session if requested and none is currently active
  if (startSession && activeSession.status !== "running") {
    startNewTrackingSession();
  }

  const now = Date.now();
  let computedHeading =
    typeof heading === "number" && !isNaN(heading) ? (heading + 360) % 360 : null;
  let computedSpeed =
    typeof speed === "number" && !isNaN(speed) && speed >= 0 ? Math.round(speed) : null;

  // Derive speed and heading from sequential positions if device didn't provide them
  if (latestBusLocation) {
    const distKm = getDistanceKm(latestBusLocation.lat, latestBusLocation.lng, lat, lng);
    const timeSec = Math.max((now - latestBusLocation.updatedAt) / 1000, 1);

    if (computedHeading === null && distKm > 0.003) {
      computedHeading = Math.round(
        calculateBearing(latestBusLocation.lat, latestBusLocation.lng, lat, lng)
      );
    } else if (computedHeading === null) {
      computedHeading = latestBusLocation.heading || 0;
    }

    if (computedSpeed === null && distKm > 0.002) {
      computedSpeed = Math.round(distKm / (timeSec / 3600));
      if (computedSpeed > 140) computedSpeed = 140; // clamp realistic bounds
    }
  }

  if (computedHeading === null) computedHeading = 0;
  if (computedSpeed === null) computedSpeed = 0;

  // Actual GPS coordinates are preserved directly without artificial warping
  const locationPayload = {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    rawLat: lat,
    rawLng: lng,
    accuracy: accuracy !== undefined ? Math.round(accuracy) : null,
    speed: computedSpeed,
    heading: computedHeading,
    busId: busId || (latestBusLocation && latestBusLocation.busId) || "BUS-01",
    source: source || "conductor_mobile",
    updatedAt: now,
    clientTimestamp: timestamp || now,
    sessionId: activeSession.id,
    sessionStatus: activeSession.status
  };

  latestBusLocation = locationPayload;

  // Append point to active session history if tracking is running
  if (activeSession.status === "running") {
    const history = activeSession.history;
    const lastPoint = history[history.length - 1];
    let isDuplicate = false;

    // Reject exact duplicate point if sent repeatedly within 1 second with < 0.5m difference
    if (lastPoint) {
      const distM = getDistanceKm(lastPoint.lat, lastPoint.lng, lat, lng) * 1000;
      if (distM < 0.5 && now - lastPoint.timestamp < 1000) {
        isDuplicate = true;
      }
    }

    if (!isDuplicate) {
      history.push({
        lat: locationPayload.lat,
        lng: locationPayload.lng,
        speed: computedSpeed,
        heading: computedHeading,
        timestamp: now
      });

      if (history.length > MAX_SESSION_HISTORY) {
        history.shift();
      }
    }
  }

  const distanceKm = getSessionDistanceKm(activeSession.history);

  // Broadcast the live GPS update to all passenger dashboards immediately
  io.emit("location_update", {
    ...locationPayload,
    distanceTraveledKm: distanceKm,
    sessionDistanceKm: distanceKm,
    sessionStatus: activeSession.status
  });

  return {
    status: 200,
    data: {
      status: "success",
      message: "Location updated",
      serverTime: now,
      lat: locationPayload.lat,
      lng: locationPayload.lng,
      speed: computedSpeed,
      distanceTraveledKm: distanceKm,
      sessionStatus: activeSession.status,
      sessionId: activeSession.id
    }
  };
}

// ----------------------------------------------------
// REST Endpoints
// ----------------------------------------------------

// POST /start-session: Conductor begins a new tracking session
app.post("/start-session", (req, res) => {
  const session = startNewTrackingSession();
  res.json({
    status: "success",
    message: "Tracking session started",
    sessionId: session.id,
    startTime: session.startTime
  });
});

// POST /stop-session: Conductor stops tracking, keeping completed route
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

// POST /clear-history: Reset route history
app.post("/clear-history", (req, res) => {
  activeSession.history = [];
  io.emit("history_cleared", { sessionId: activeSession.id });
  res.json({ status: "success", message: "Route history cleared" });
});

// POST /update-location: Receives live GPS from conductor phone/laptop browser
app.post("/update-location", (req, res) => {
  const body = req.body || {};

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

  const result = processLocationUpdate(body);
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }

  res.json(result.data);
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
    console.log(`👉 Passenger Map: http://localhost:${port}/track.html`);
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

module.exports = { app, server, io };
