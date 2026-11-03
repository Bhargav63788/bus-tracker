/**
 * Route Validation & Distance Calculation Engine
 * 
 * Provides strict geodesic and orthogonal point-to-route calculations.
 * Ensures the bus only broadcasts GPS data when operating within
 * the permitted corridor of the selected route.
 */

const DEFAULT_ROUTE_TOLERANCE_METERS = parseInt(process.env.ROUTE_TOLERANCE_METERS, 10) || 100;
const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Calculates distance between two coordinates in meters using the Haversine formula.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculates minimum orthogonal distance from point P to line segment [A, B] in meters.
 * Uses local equirectangular flat-earth projection relative to the segment midpoint,
 * providing sub-meter accuracy for local distances.
 */
function distancePointToSegmentMeters(pLat, pLng, aLat, aLng, bLat, bLng) {
  const midLat = toRadians((aLat + bLat) / 2);
  const cosMid = Math.cos(midLat);

  // Vector AB in meters
  const dx = toRadians(bLng - aLng) * cosMid * EARTH_RADIUS_METERS;
  const dy = toRadians(bLat - aLat) * EARTH_RADIUS_METERS;

  // Vector AP in meters
  const px = toRadians(pLng - aLng) * cosMid * EARTH_RADIUS_METERS;
  const py = toRadians(pLat - aLat) * EARTH_RADIUS_METERS;

  const segLenSq = dx * dx + dy * dy;

  // If segment is essentially a point
  if (segLenSq < 1e-6) {
    return {
      distance: Math.hypot(px, py),
      nearestPoint: [aLat, aLng]
    };
  }

  // Projection scalar t onto line AB
  let t = (px * dx + py * dy) / segLenSq;
  t = Math.max(0, Math.min(1, t)); // Clamp to segment

  const projX = t * dx;
  const projY = t * dy;

  const nearestLat = aLat + t * (bLat - aLat);
  const nearestLng = aLng + t * (bLng - aLng);

  return {
    distance: Math.hypot(px - projX, py - projY),
    nearestPoint: [nearestLat, nearestLng],
    t
  };
}

/**
 * Calculates minimum distance from a GPS point to a complete route polyline geometry.
 * 
 * @param {number} lat - Target latitude
 * @param {number} lng - Target longitude
 * @param {Array<Array<number>>} geometry - Route coordinates [[lat, lng], ...]
 * @returns {Object} { minDistanceMeters, nearestPoint: [lat, lng], segmentIndex }
 */
function getDistanceToRoute(lat, lng, geometry) {
  if (!geometry || !Array.isArray(geometry) || geometry.length === 0) {
    return { minDistanceMeters: Infinity, nearestPoint: null, segmentIndex: -1 };
  }

  // If only 1 point in geometry
  if (geometry.length === 1) {
    const pt = geometry[0];
    const dist = haversineMeters(lat, lng, pt[0], pt[1]);
    return {
      minDistanceMeters: dist,
      nearestPoint: pt,
      segmentIndex: 0
    };
  }

  let minDistanceMeters = Infinity;
  let nearestPoint = null;
  let nearestSegmentIndex = -1;

  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];

    const result = distancePointToSegmentMeters(lat, lng, a[0], a[1], b[0], b[1]);

    if (result.distance < minDistanceMeters) {
      minDistanceMeters = result.distance;
      nearestPoint = result.nearestPoint;
      nearestSegmentIndex = i;
    }
  }

  return {
    minDistanceMeters,
    nearestPoint,
    segmentIndex: nearestSegmentIndex
  };
}

/**
 * Validates whether a GPS position is on or within the permitted corridor of the route.
 * 
 * @param {number} lat - GPS latitude
 * @param {number} lng - GPS longitude
 * @param {Array<Array<number>>} geometry - Route coordinates [[lat, lng], ...]
 * @param {Object} options - Validation options
 * @param {number} [options.toleranceMeters] - Base route tolerance (default: 100m)
 * @param {number} [options.accuracy] - Device reported GPS accuracy in meters
 * @returns {Object} { isWithinRoute: boolean, distanceMeters: number, effectiveTolerance: number, nearestPoint: [lat, lng] }
 */
function validatePointOnRoute(lat, lng, geometry, options = {}) {
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
    (lat === 0 && lng === 0)
  ) {
    return {
      isWithinRoute: false,
      distanceMeters: Infinity,
      effectiveTolerance: DEFAULT_ROUTE_TOLERANCE_METERS,
      nearestPoint: null,
      error: "Invalid GPS coordinates"
    };
  }

  const baseTolerance = typeof options.toleranceMeters === "number" && options.toleranceMeters > 0
    ? options.toleranceMeters
    : DEFAULT_ROUTE_TOLERANCE_METERS;

  // Account for natural mobile GPS accuracy fluctuations (e.g. indoors, tall canopy)
  // If reported accuracy is e.g. 25m, buffer by the uncertainty beyond baseline 15m, capped at +30m.
  const accuracy = typeof options.accuracy === "number" && options.accuracy > 0 ? options.accuracy : 0;
  const accuracyBuffer = accuracy > 15 ? Math.min(accuracy - 15, 30) : 0;
  const effectiveTolerance = Math.round(baseTolerance + accuracyBuffer);

  const { minDistanceMeters, nearestPoint, segmentIndex } = getDistanceToRoute(lat, lng, geometry);

  const isWithinRoute = minDistanceMeters <= effectiveTolerance;

  return {
    isWithinRoute,
    distanceMeters: Math.round(minDistanceMeters * 10) / 10,
    effectiveTolerance,
    nearestPoint,
    segmentIndex
  };
}

module.exports = {
  DEFAULT_ROUTE_TOLERANCE_METERS,
  haversineMeters,
  distancePointToSegmentMeters,
  getDistanceToRoute,
  validatePointOnRoute
};

