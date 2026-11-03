const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_DIR = path.join(__dirname, "data");
const ROUTES_FILE = path.join(DATA_DIR, "routes.json");

// Ensure data directory and routes file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(ROUTES_FILE)) {
  fs.writeFileSync(ROUTES_FILE, JSON.stringify([], null, 2), "utf8");
}

function readRoutesFromFile() {
  try {
    if (!fs.existsSync(ROUTES_FILE)) return [];
    const raw = fs.readFileSync(ROUTES_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.error("Error reading routes from file:", err);
    return [];
  }
}

function writeRoutesToFile(routes) {
  try {
    fs.writeFileSync(ROUTES_FILE, JSON.stringify(routes, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Error saving routes to file:", err);
    return false;
  }
}

// Haversine distance in km
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
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

/**
 * Calculates road-following route geometry using OSRM driving router.
 * If OSRM is unreachable or times out, falls back to geodesic straight-line segments.
 */
function fetchRoadRouteGeometry(waypoints) {
  return new Promise((resolve) => {
    if (!waypoints || waypoints.length < 2) {
      return resolve({
        geometry: waypoints || [],
        distanceKm: 0,
        durationMin: 0,
        isRoadSnapped: false
      });
    }

    // Format coordinates for OSRM: {lon},{lat};{lon},{lat}...
    const coordString = waypoints
      .map((pt) => {
        const lat = typeof pt.lat === "number" ? pt.lat : pt[0];
        const lng = typeof pt.lng === "number" ? pt.lng : pt[1];
        return `${lng},${lat}`;
      })
      .join(";");

    const url = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;

    const req = https.get(
      url,
      {
        headers: { "User-Agent": "BusTrackerRoutePlanner/2.0" },
        timeout: 4000
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (json.code === "Ok" && json.routes && json.routes[0]) {
              const r = json.routes[0];
              // Convert GeoJSON coordinates [lon, lat] -> Leaflet [lat, lng]
              const leafCoords = r.geometry.coordinates.map((c) => [c[1], c[0]]);
              return resolve({
                geometry: leafCoords,
                distanceKm: Math.round((r.distance / 1000) * 100) / 100,
                durationMin: Math.max(1, Math.round(r.duration / 60)),
                isRoadSnapped: true
              });
            }
          } catch (e) {
            // Fall through to straight line
          }
          resolve(fallbackStraightLine(waypoints));
        });
      }
    );

    req.on("error", () => resolve(fallbackStraightLine(waypoints)));
    req.on("timeout", () => {
      req.destroy();
      resolve(fallbackStraightLine(waypoints));
    });
  });
}

function fallbackStraightLine(waypoints) {
  let totalKm = 0;
  const geometry = waypoints.map((pt) => [
    typeof pt.lat === "number" ? pt.lat : pt[0],
    typeof pt.lng === "number" ? pt.lng : pt[1]
  ]);

  for (let i = 0; i < geometry.length - 1; i++) {
    totalKm += haversineDistanceKm(
      geometry[i][0],
      geometry[i][1],
      geometry[i + 1][0],
      geometry[i + 1][1]
    );
  }

  // Estimate transit speed at ~30 km/h
  const durationMin = Math.max(1, Math.round((totalKm / 30) * 60));

  return {
    geometry,
    distanceKm: Math.round(totalKm * 100) / 100,
    durationMin,
    isRoadSnapped: false
  };
}

const routeStore = {
  getAll() {
    const routes = readRoutesFromFile();
    return routes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  getById(id) {
    const routes = readRoutesFromFile();
    return routes.find((r) => r.id === id) || null;
  },

  getActive() {
    const routes = readRoutesFromFile();
    return routes.find((r) => r.isActive) || null;
  },

  async create(routeData) {
    const routes = readRoutesFromFile();
    const id = "route_" + Date.now();
    const now = Date.now();

    let waypoints = routeData.waypoints || [];
    let geometry = routeData.geometry || [];
    let distanceKm = routeData.distanceKm;
    let durationMin = routeData.durationMin;

    // Recalculate road geometry if not provided
    if ((!geometry || geometry.length === 0) && waypoints.length >= 2) {
      const calc = await fetchRoadRouteGeometry(waypoints);
      geometry = calc.geometry;
      distanceKm = calc.distanceKm;
      durationMin = calc.durationMin;
    }

    const newRoute = {
      id,
      name: routeData.name || "Untitled Bus Route",
      description: routeData.description || "",
      startName: routeData.startName || (waypoints[0] ? `Origin (${waypoints[0].lat.toFixed(4)}, ${waypoints[0].lng.toFixed(4)})` : "Start"),
      destinationName: routeData.destinationName || (waypoints[waypoints.length - 1] ? `Destination (${waypoints[waypoints.length - 1].lat.toFixed(4)}, ${waypoints[waypoints.length - 1].lng.toFixed(4)})` : "End"),
      distanceKm: typeof distanceKm === "number" ? distanceKm : 0,
      durationMin: typeof durationMin === "number" ? durationMin : 0,
      waypoints: waypoints,
      geometry: geometry,
      stops: (routeData.stops || []).map((s, idx) => ({
        id: s.id || `stop_${idx + 1}`,
        name: s.name || `Bus Stop ${idx + 1}`,
        lat: typeof s.lat === "number" ? s.lat : s[0],
        lng: typeof s.lng === "number" ? s.lng : s[1],
        sequence: s.sequence || idx + 1
      })),
      isActive: Boolean(routeData.isActive),
      createdAt: now,
      updatedAt: now
    };

    if (newRoute.isActive) {
      routes.forEach((r) => (r.isActive = false));
    }

    routes.unshift(newRoute);
    writeRoutesToFile(routes);
    return newRoute;
  },

  async update(id, routeData) {
    const routes = readRoutesFromFile();
    const index = routes.findIndex((r) => r.id === id);
    if (index === -1) return null;

    const existing = routes[index];
    const now = Date.now();

    let waypoints = routeData.waypoints !== undefined ? routeData.waypoints : existing.waypoints;
    let geometry = routeData.geometry !== undefined ? routeData.geometry : existing.geometry;
    let distanceKm = routeData.distanceKm !== undefined ? routeData.distanceKm : existing.distanceKm;
    let durationMin = routeData.durationMin !== undefined ? routeData.durationMin : existing.durationMin;

    if (routeData.recalculateRoad && waypoints && waypoints.length >= 2) {
      const calc = await fetchRoadRouteGeometry(waypoints);
      geometry = calc.geometry;
      distanceKm = calc.distanceKm;
      durationMin = calc.durationMin;
    }

    const updated = {
      ...existing,
      name: routeData.name !== undefined ? routeData.name : existing.name,
      description: routeData.description !== undefined ? routeData.description : existing.description,
      startName: routeData.startName !== undefined ? routeData.startName : existing.startName,
      destinationName: routeData.destinationName !== undefined ? routeData.destinationName : existing.destinationName,
      distanceKm: typeof distanceKm === "number" ? distanceKm : existing.distanceKm,
      durationMin: typeof durationMin === "number" ? durationMin : existing.durationMin,
      waypoints,
      geometry,
      stops: routeData.stops !== undefined ? routeData.stops : existing.stops,
      isActive: routeData.isActive !== undefined ? Boolean(routeData.isActive) : existing.isActive,
      updatedAt: now
    };

    if (updated.isActive) {
      routes.forEach((r) => {
        if (r.id !== id) r.isActive = false;
      });
    }

    routes[index] = updated;
    writeRoutesToFile(routes);
    return updated;
  },

  delete(id) {
    const routes = readRoutesFromFile();
    const filtered = routes.filter((r) => r.id !== id);
    if (filtered.length === routes.length) return false;
    writeRoutesToFile(filtered);
    return true;
  },

  setActive(id) {
    const routes = readRoutesFromFile();
    let activatedRoute = null;
    routes.forEach((r) => {
      if (r.id === id) {
        r.isActive = true;
        activatedRoute = r;
      } else {
        r.isActive = false;
      }
    });
    if (activatedRoute) {
      writeRoutesToFile(routes);
    }
    return activatedRoute;
  },

  calculateRoadRoute: fetchRoadRouteGeometry
};

module.exports = routeStore;

