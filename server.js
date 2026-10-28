const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// In-memory bus state (no hardcoded cities or routes)
let busLocation = null;
const locationHistory = []; // Real path traveled by the bus
const MAX_HISTORY = 200;

// Optional API key for hardware GPS / ticket machine
const GPS_API_KEY = process.env.GPS_API_KEY || "";

// Serve web pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/track.html", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/conductor.html", (req, res) => res.sendFile(path.join(__dirname, "conductor.html")));
app.get("/bus.png", (req, res) => res.sendFile(path.join(__dirname, "bus.png")));

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

// Bearing in degrees (0-360)
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

// Calculate total distance traveled from history
function getTotalDistanceTraveledKm() {
  let total = 0;
  for (let i = 0; i < locationHistory.length - 1; i++) {
    total += getDistanceKm(
      locationHistory[i].lat,
      locationHistory[i].lng,
      locationHistory[i + 1].lat,
      locationHistory[i + 1].lng
    );
  }
  return Math.round(total * 100) / 100;
}

// POST /update-location
// Receives live GPS from ticket machine hardware or conductor phone
app.post("/update-location", (req, res) => {
  const body = req.body || {};
  const { lat, lng, accuracy, speed, heading, busId, source, timestamp } = body;

  // Optional authentication check
  if (GPS_API_KEY) {
    const headerKey = req.headers["x-api-key"] || "";
    const authHeader = req.headers["authorization"] || "";
    const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const bodyKey = body.apiKey || "";

    if (headerKey !== GPS_API_KEY && bearerKey !== GPS_API_KEY && bodyKey !== GPS_API_KEY) {
      return res.status(401).json({ error: "Unauthorized: Invalid GPS API key" });
    }
  }

  // Validate coordinates
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lng !== "number" ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180 ||
    (accuracy !== undefined &&
      (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0))
  ) {
    return res.status(400).json({ error: "Invalid GPS coordinates" });
  }

  const now = Date.now();
  let computedHeading = typeof heading === "number" && !isNaN(heading) ? (heading + 360) % 360 : null;
  let computedSpeed = typeof speed === "number" && !isNaN(speed) && speed >= 0 ? Math.round(speed) : null;

  // Calculate bearing & speed from previous position if not provided
  if (busLocation) {
    const distKm = getDistanceKm(busLocation.lat, busLocation.lng, lat, lng);
    const timeSec = Math.max((now - busLocation.updatedAt) / 1000, 1);

    if (computedHeading === null && distKm > 0.003) {
      computedHeading = Math.round(calculateBearing(busLocation.lat, busLocation.lng, lat, lng));
    } else if (computedHeading === null) {
      computedHeading = busLocation.heading || 0;
    }

    if (computedSpeed === null && distKm > 0.002) {
      computedSpeed = Math.round((distKm / (timeSec / 3600)));
      if (computedSpeed > 140) computedSpeed = 140; // clamp unrealistic jumps
    }
  }

  if (computedHeading === null) computedHeading = 0;
  if (computedSpeed === null) computedSpeed = 0;

  busLocation = {
    lat,
    lng,
    accuracy: accuracy !== undefined ? Math.round(accuracy) : null,
    speed: computedSpeed,
    heading: computedHeading,
    busId: busId || (busLocation && busLocation.busId) || "BUS-01",
    source: source || "gps",
    updatedAt: now,
    clientTimestamp: timestamp || now
  };

  // Add to actual driven path history
  locationHistory.push({
    lat,
    lng,
    speed: computedSpeed,
    timestamp: now
  });
  if (locationHistory.length > MAX_HISTORY) {
    locationHistory.shift();
  }

  res.json({
    status: "success",
    message: "Location updated",
    serverTime: now,
    lat,
    lng,
    speed: computedSpeed
  });
});

// GET /get-location
// Returns live GPS coordinates, status, and the real route path driven
app.get("/get-location", (req, res) => {
  if (!busLocation) {
    return res.json(null);
  }

  const now = Date.now();
  const ageSeconds = Math.round((now - busLocation.updatedAt) / 1000);

  let status = "online";
  if (ageSeconds > 90) {
    status = "offline";
  } else if (ageSeconds > 30) {
    status = "stale";
  }

  res.json({
    ...busLocation,
    serverTime: now,
    ageSeconds,
    status,
    isStale: status !== "online",
    distanceTraveledKm: getTotalDistanceTraveledKm(),
    history: locationHistory // Real driven route points
  });
});

// Clear route history endpoint (if starting a new trip)
app.post("/clear-history", (req, res) => {
  locationHistory.length = 0;
  res.json({ status: "success", message: "Route history cleared" });
});

// Health check
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    hasActiveBus: !!busLocation,
    lastUpdateAgeSeconds: busLocation ? Math.round((Date.now() - busLocation.updatedAt) / 1000) : null
  });
});

const PORT = process.env.PORT || 3000;

function startServer(port) {
  const srv = app.listen(port, () => {
    console.log(`🚌 Bus Tracker Server running on port ${port}`);
    console.log(`👉 Open http://localhost:${port}/track.html in your browser`);
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

const server = startServer(PORT);

module.exports = { app, server };
