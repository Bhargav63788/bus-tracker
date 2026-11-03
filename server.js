const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const routeStore = require("./routeStore");
const routeValidator = require("./routeValidator");

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
// State Management: Multiple Buses & Tracking Sessions
// ----------------------------------------------------
const DEFAULT_BUSES = [
  { id: "BUS-01", name: "BUS-01", defaultRouteId: "route_1793686398582" }, // kundapura - udupi
  { id: "BUS-02", name: "BUS-02", defaultRouteId: "route_1793685867911" }, // siddapura - kundapura
  { id: "BUS-03", name: "BUS-03", defaultRouteId: null }
];

const busStates = new Map();

function getOrCreateBusState(busId = "BUS-01") {
  const safeBusId = (busId || "BUS-01").toUpperCase();
  if (!busStates.has(safeBusId)) {
    const config = DEFAULT_BUSES.find((b) => b.id === safeBusId) || { id: safeBusId, name: safeBusId, defaultRouteId: null };
    const defaultRoute = config.defaultRouteId ? routeStore.getById(config.defaultRouteId) : null;
    busStates.set(safeBusId, {
      busId: safeBusId,
      name: config.name,
      session: {
        id: "session_" + safeBusId + "_" + Date.now(),
        busId: safeBusId,
        status: "stopped",
        startTime: null,
        stopTime: null,
        routeId: defaultRoute ? defaultRoute.id : null,
        routeName: defaultRoute ? defaultRoute.name : null,
        isOffRoute: false,
        offRouteCount: 0,
        history: []
      },
      latestLocation: null
    });
  }
  return busStates.get(safeBusId);
}

// Pre-initialize default buses
DEFAULT_BUSES.forEach((b) => getOrCreateBusState(b.id));

function getAvailableBusesSummary() {
  const list = [];
  for (const [id, state] of busStates.entries()) {
    const route = state.session.routeId ? routeStore.getById(state.session.routeId) : null;
    let status = "idle";
    if (state.session.status === "running") {
      status = state.session.isOffRoute ? "off_route" : "live";
    } else if (state.session.status === "stopped" && state.session.history.length > 0) {
      status = "stopped";
    }

    list.push({
      busId: id,
      name: state.name || id,
      status, // "live" | "off_route" | "stopped" | "idle"
      isOffRoute: Boolean(state.session.isOffRoute),
      sessionStatus: state.session.status,
      routeId: route ? route.id : null,
      routeName: route ? route.name : "Unassigned Route",
      distanceTraveledKm: getSessionDistanceKm(state.session.history),
      hasLocation: Boolean(state.latestLocation && !state.latestLocation.isOffRoute),
      speed: state.latestLocation && !state.latestLocation.isOffRoute ? state.latestLocation.speed : null,
      lastUpdate: state.latestLocation ? state.latestLocation.updatedAt : null
    });
  }
  return list;
}

let activeSession = getOrCreateBusState("BUS-01").session;
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
app.get("/route-editor.html", (req, res) => res.sendFile(path.join(__dirname, "route-editor.html")));
app.get("/routes.html", (req, res) => res.sendFile(path.join(__dirname, "route-editor.html")));
app.get("/routes", (req, res) => res.sendFile(path.join(__dirname, "route-editor.html")));
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

function startNewTrackingSession(options = {}) {
  const busId = (options.busId || "BUS-01").toUpperCase();
  const busState = getOrCreateBusState(busId);
  const { routeId, lat, lng, accuracy } = options;

  let assignedRoute = null;
  if (routeId) {
    assignedRoute = routeStore.getById(routeId);
    if (!assignedRoute) {
      return {
        error: "Selected bus route not found",
        status: 404
      };
    }
  } else if (busState.session.routeId) {
    assignedRoute = routeStore.getById(busState.session.routeId);
  } else {
    assignedRoute = routeStore.getActive();
  }

  if (!assignedRoute) {
    return {
      error: "Please select a bus route before starting tracking.",
      status: 400
    };
  }

  // Strict route check: Conductor must be inside or sufficiently close to the route
  if (typeof lat === "number" && typeof lng === "number") {
    const validation = routeValidator.validatePointOnRoute(lat, lng, assignedRoute.geometry, { accuracy });
    if (!validation.isWithinRoute) {
      console.log(
        `[SESSION] Blocked tracking start: Conductor for ${busId} is ${validation.distanceMeters}m away from route "${assignedRoute.name}" (allowed: ${validation.effectiveTolerance}m)`
      );
      return {
        error: "You are outside the selected bus route. Move to the route to start tracking.",
        status: 403,
        distanceMeters: validation.distanceMeters,
        effectiveToleranceMeters: validation.effectiveTolerance,
        routeId: assignedRoute.id,
        routeName: assignedRoute.name,
        busId
      };
    }
  }

  // Activate selected route in persistent routeStore
  routeStore.setActive(assignedRoute.id);

  const newSessionId = "session_" + busId + "_" + Date.now();
  busState.session = {
    id: newSessionId,
    busId,
    status: "running",
    startTime: Date.now(),
    stopTime: null,
    routeId: assignedRoute.id,
    routeName: assignedRoute.name,
    isOffRoute: false,
    offRouteCount: 0,
    history: []
  };

  activeSession = busState.session;

  // Broadcast session start and active route to all passenger dashboards
  io.emit("session_started", {
    busId,
    sessionId: newSessionId,
    routeId: assignedRoute.id,
    routeName: assignedRoute.name,
    timestamp: busState.session.startTime
  });

  io.emit("route_activated", assignedRoute);
  io.emit("buses_update", getAvailableBusesSummary());

  console.log(`[SESSION] Started new tracking session: ${newSessionId} for ${busId} on route "${assignedRoute.name}" (${assignedRoute.id})`);
  return busState.session;
}

function stopActiveTrackingSession(options = {}) {
  const busId = (options.busId || (options.id ? options.id : null) || (activeSession && activeSession.busId) || "BUS-01").toUpperCase();
  const busState = getOrCreateBusState(busId);

  busState.session.status = "stopped";
  busState.session.stopTime = Date.now();
  if (busState.latestLocation) {
    busState.latestLocation.status = "stopped";
  }

  activeSession = busState.session;

  // Broadcast session stop to all passenger dashboards
  io.emit("session_stopped", {
    busId,
    sessionId: busState.session.id,
    routeId: busState.session.routeId,
    routeName: busState.session.routeName,
    timestamp: busState.session.stopTime,
    historyCount: busState.session.history.length
  });

  io.emit("buses_update", getAvailableBusesSummary());

  console.log(`[SESSION] Stopped tracking session for ${busId}: ${busState.session.id}`);
  return busState.session;
}

// ----------------------------------------------------
// Socket.IO Real-Time Connection Handling
// ----------------------------------------------------

io.on("connection", (socket) => {
  // Never expose off-route coordinates to passengers
  let sanitizedLocation = null;
  if (latestBusLocation && !latestBusLocation.isOffRoute) {
    sanitizedLocation = latestBusLocation;
  }

  const currentRoute = activeSession.routeId
    ? routeStore.getById(activeSession.routeId)
    : routeStore.getActive();

  const summary = getAvailableBusesSummary();

  // Send state_init with available buses list
  socket.emit("state_init", {
    availableBuses: summary,
    busLocation: sanitizedLocation,
    isOffRoute: latestBusLocation ? Boolean(latestBusLocation.isOffRoute) : false,
    activeRoute: currentRoute,
    session: {
      id: activeSession.id,
      busId: activeSession.busId || "BUS-01",
      status: activeSession.status,
      routeId: activeSession.routeId,
      routeName: activeSession.routeName,
      isOffRoute: activeSession.isOffRoute,
      startTime: activeSession.startTime,
      stopTime: activeSession.stopTime,
      history: activeSession.history,
      distanceTraveledKm: getSessionDistanceKm(activeSession.history)
    },
    serverTime: Date.now()
  });

  // Handle passenger query for specific bus
  socket.on("query_bus", (busId) => {
    const state = getOrCreateBusState(busId);
    let loc = null;
    if (state.latestLocation && !state.latestLocation.isOffRoute) {
      loc = state.latestLocation;
    }
    const route = state.session.routeId ? routeStore.getById(state.session.routeId) : null;
    socket.emit("bus_state", {
      busId: state.busId,
      busLocation: loc,
      isOffRoute: state.session.isOffRoute,
      activeRoute: route,
      session: {
        id: state.session.id,
        busId: state.busId,
        status: state.session.status,
        routeId: state.session.routeId,
        routeName: state.session.routeName,
        isOffRoute: state.session.isOffRoute,
        history: state.session.history,
        distanceTraveledKm: getSessionDistanceKm(state.session.history)
      }
    });
  });

  // Handle conductor session actions over Socket.IO
  socket.on("conductor_start_session", (data) => {
    const result = startNewTrackingSession(data || {});
    if (result.error) {
      socket.emit("conductor_session_error", result);
    }
  });

  socket.on("conductor_stop_session", (data) => {
    stopActiveTrackingSession(data || {});
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
    busId: rawBusId,
    source,
    timestamp,
    startSession,
    routeId
  } = body;

  const busId = (rawBusId || (latestBusLocation && latestBusLocation.busId) || "BUS-01").toUpperCase();
  const busState = getOrCreateBusState(busId);

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

  // Determine assigned bus route
  const effectiveRouteId =
    routeId ||
    busState.session.routeId ||
    activeSession.routeId ||
    (routeStore.getActive() ? routeStore.getActive().id : null);
  const route = effectiveRouteId
    ? routeStore.getById(effectiveRouteId)
    : routeStore.getActive();

  if (!route) {
    return { error: "No bus route selected. Please select a route.", status: 400 };
  }

  // Auto-start session if requested and none is currently active
  if (startSession && busState.session.status !== "running") {
    const startRes = startNewTrackingSession({ busId, routeId: route.id, lat, lng, accuracy });
    if (startRes.error) {
      return { error: startRes.error, status: startRes.status || 403, data: startRes };
    }
  }

  const now = Date.now();

  // CONTINUOUS ROUTE VALIDATION
  const validation = routeValidator.validatePointOnRoute(lat, lng, route.geometry, { accuracy });

  // 1. CONDUCTOR IS OFF-ROUTE: Hide location from passengers immediately
  if (!validation.isWithinRoute) {
    busState.session.isOffRoute = true;
    busState.session.offRouteCount = (busState.session.offRouteCount || 0) + 1;
    activeSession = busState.session;

    // NEVER broadcast off-route coordinates to passengers!
    busState.latestLocation = {
      isOffRoute: true,
      status: "off_route",
      busId,
      routeId: route.id,
      routeName: route.name,
      distanceToRouteMeters: validation.distanceMeters,
      effectiveToleranceMeters: validation.effectiveTolerance,
      updatedAt: now,
      sessionId: busState.session.id
    };
    latestBusLocation = busState.latestLocation;

    // Emit off-route notification without GPS coordinates
    io.emit("bus_off_route", {
      busId,
      routeId: route.id,
      routeName: route.name,
      status: "off_route",
      message: `Bus ${busId} is currently off route (Location unavailable)`,
      distanceToRouteMeters: validation.distanceMeters,
      effectiveToleranceMeters: validation.effectiveTolerance,
      timestamp: now
    });

    io.emit("buses_update", getAvailableBusesSummary());

    return {
      status: 200,
      data: {
        status: "off_route",
        isOffRoute: true,
        message: "You are outside the selected bus route. Location publishing paused.",
        distanceToRouteMeters: validation.distanceMeters,
        effectiveToleranceMeters: validation.effectiveTolerance,
        routeName: route.name,
        routeId: route.id,
        sessionId: busState.session.id,
        busId
      }
    };
  }

  // 2. CONDUCTOR IS ON-ROUTE: Resume publishing to passengers
  busState.session.isOffRoute = false;
  activeSession = busState.session;

  let computedHeading =
    typeof heading === "number" && !isNaN(heading) ? (heading + 360) % 360 : null;
  let computedSpeed =
    typeof speed === "number" && !isNaN(speed) && speed >= 0 ? Math.round(speed) : null;

  // Derive speed and heading from sequential positions if device didn't provide them
  const prevLoc = busState.latestLocation;
  if (prevLoc && !prevLoc.isOffRoute && prevLoc.lat) {
    const distKm = getDistanceKm(prevLoc.lat, prevLoc.lng, lat, lng);
    const timeSec = Math.max((now - prevLoc.updatedAt) / 1000, 1);

    if (computedHeading === null && distKm > 0.003) {
      computedHeading = Math.round(
        calculateBearing(prevLoc.lat, prevLoc.lng, lat, lng)
      );
    } else if (computedHeading === null) {
      computedHeading = prevLoc.heading || 0;
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
    busId,
    source: source || "conductor_mobile",
    updatedAt: now,
    clientTimestamp: timestamp || now,
    sessionId: busState.session.id,
    sessionStatus: busState.session.status,
    routeId: route.id,
    routeName: route.name,
    isOffRoute: false,
    distanceToRouteMeters: validation.distanceMeters,
    effectiveToleranceMeters: validation.effectiveTolerance
  };

  busState.latestLocation = locationPayload;
  latestBusLocation = locationPayload;

  // Append point to active session history if tracking is running
  if (busState.session.status === "running") {
    const history = busState.session.history;
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

  const distanceKm = getSessionDistanceKm(busState.session.history);

  // Broadcast the live GPS update to all passenger dashboards immediately
  io.emit("location_update", {
    ...locationPayload,
    distanceTraveledKm: distanceKm,
    sessionDistanceKm: distanceKm,
    sessionStatus: busState.session.status
  });

  io.emit("buses_update", getAvailableBusesSummary());

  return {
    status: 200,
    data: {
      status: "success",
      isOffRoute: false,
      message: "Location updated",
      serverTime: now,
      lat: locationPayload.lat,
      lng: locationPayload.lng,
      speed: computedSpeed,
      distanceTraveledKm: distanceKm,
      distanceToRouteMeters: validation.distanceMeters,
      effectiveToleranceMeters: validation.effectiveTolerance,
      sessionStatus: busState.session.status,
      sessionId: busState.session.id,
      routeId: route.id,
      routeName: route.name,
      busId
    }
  };
}

// ----------------------------------------------------
// REST Endpoints
// ----------------------------------------------------

// POST /start-session: Conductor begins a new tracking session
app.post("/start-session", (req, res) => {
  const body = req.body || {};
  const result = startNewTrackingSession(body);
  if (result.error) {
    return res.status(result.status || 400).json(result);
  }
  res.json({
    status: "success",
    message: "Tracking session started on route",
    sessionId: result.id,
    routeId: result.routeId,
    routeName: result.routeName,
    startTime: result.startTime
  });
});

// POST /stop-session: Conductor stops tracking, keeping completed route
app.post("/stop-session", (req, res) => {
  const session = stopActiveTrackingSession(req.body || {});
  res.json({
    status: "success",
    message: "Tracking session stopped",
    busId: session.busId,
    sessionId: session.id,
    stopTime: session.stopTime,
    completedPoints: session.history.length
  });
});

// GET /api/buses: Return list of all available buses with their routes and live status
app.get("/api/buses", (req, res) => {
  res.json(getAvailableBusesSummary());
});

// POST /clear-history: Reset route history
app.post("/clear-history", (req, res) => {
  activeSession.history = [];
  io.emit("history_cleared", { sessionId: activeSession.id });
  res.json({ status: "success", message: "Route history cleared" });
});

// ----------------------------------------------------
// Visual Route Planning & Road Drawing API
// ----------------------------------------------------

// Calculate road-following route from waypoints via OSRM
app.post("/api/routes/calculate", async (req, res) => {
  const { waypoints } = req.body || {};
  if (!waypoints || !Array.isArray(waypoints) || waypoints.length < 2) {
    return res.status(400).json({ error: "At least 2 waypoints are required to calculate a road route." });
  }
  const result = await routeStore.calculateRoadRoute(waypoints);
  res.json(result);
});

// List all saved routes
app.get("/api/routes", (req, res) => {
  const routes = routeStore.getAll();
  res.json(routes);
});

// Get currently active route
app.get("/api/routes/active", (req, res) => {
  const active = routeStore.getActive();
  res.json(active);
});

// Get specific route by ID
app.get("/api/routes/:id", (req, res) => {
  const route = routeStore.getById(req.params.id);
  if (!route) return res.status(404).json({ error: "Route not found" });
  res.json(route);
});

// Create and save a new route
app.post("/api/routes", async (req, res) => {
  const routeData = req.body || {};
  if (!routeData.waypoints || routeData.waypoints.length < 2) {
    return res.status(400).json({ error: "A valid route requires at least 2 points (Start and Destination)." });
  }
  const saved = await routeStore.create(routeData);
  io.emit("route_created", saved);
  res.status(201).json(saved);
});

// Update an existing route
app.put("/api/routes/:id", async (req, res) => {
  const updated = await routeStore.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: "Route not found" });
  io.emit("route_updated", updated);
  res.json(updated);
});

// Delete a route
app.delete("/api/routes/:id", (req, res) => {
  const deleted = routeStore.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Route not found" });
  io.emit("route_deleted", { id: req.params.id });
  res.json({ status: "success", message: "Route deleted successfully" });
});

// Activate a route for live tracking
app.post("/api/routes/:id/activate", (req, res) => {
  const activated = routeStore.setActive(req.params.id);
  if (!activated) return res.status(404).json({ error: "Route not found" });
  io.emit("route_activated", activated);
  res.json({ status: "success", route: activated });
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
  const reqBusId = req.query.busId ? req.query.busId.toUpperCase() : null;
  const busState = reqBusId
    ? getOrCreateBusState(reqBusId)
    : (latestBusLocation ? getOrCreateBusState(latestBusLocation.busId) : getOrCreateBusState("BUS-01"));

  const targetLoc = busState.latestLocation;
  const targetSession = busState.session;

  if (!targetLoc) {
    return res.json({
      busId: busState.busId,
      hasLocation: false,
      isOffRoute: false,
      sessionStatus: targetSession.status,
      sessionId: targetSession.id,
      history: []
    });
  }

  // If the bus is off-route, NEVER reveal off-route coordinates to passengers!
  if (targetLoc.isOffRoute) {
    return res.json({
      busId: busState.busId,
      hasLocation: false,
      isOffRoute: true,
      status: "off_route",
      message: `Bus ${busState.busId} is currently off route (Location unavailable)`,
      routeId: targetLoc.routeId,
      routeName: targetLoc.routeName,
      sessionId: targetSession.id,
      sessionStatus: targetSession.status,
      history: []
    });
  }

  const now = Date.now();
  const ageSeconds = Math.round((now - targetLoc.updatedAt) / 1000);

  let connectionStatus = "online";
  if (targetSession.status === "stopped") {
    connectionStatus = "stopped";
  } else if (ageSeconds > 90) {
    connectionStatus = "offline";
  } else if (ageSeconds > 25) {
    connectionStatus = "stale";
  }

  res.json({
    ...targetLoc,
    hasLocation: true,
    isOffRoute: false,
    serverTime: now,
    ageSeconds,
    status: connectionStatus,
    isStale: connectionStatus === "stale",
    isOffline: connectionStatus === "offline",
    distanceTraveledKm: getSessionDistanceKm(targetSession.history),
    sessionId: targetSession.id,
    sessionStatus: targetSession.status,
    history: targetSession.history
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
