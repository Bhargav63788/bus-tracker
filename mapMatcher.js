/**
 * Map Matcher & Route-Constrained GPS Positioning Engine
 * 
 * Provides:
 * 1. Road-level map matching onto the selected saved route geometry.
 * 2. Sequential forward-progress tracking to prevent jumping to parallel roads or opposite lanes.
 * 3. Orthogonal projection onto the road centerline so the bus marker stays exactly on the road.
 * 4. Road tangent heading calculation for realistic Google Maps-style orientation.
 * 5. Stationary jitter filtering when stopping at bus stops / traffic signals.
 * 6. Corridor boundary validation (off-route detection).
 */

const DEFAULT_ROUTE_TOLERANCE_METERS = parseInt(process.env.ROUTE_TOLERANCE_METERS, 10) || 100;
const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

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

function calculateBearing(lat1, lon1, lat2, lon2) {
  const dLon = toRadians(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRadians(lat2));
  const x =
    Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
    Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

/**
 * Calculates minimum orthogonal distance from point P to line segment [A, B] in meters.
 * Also returns projection scalar t, nearest point coordinates, and segment bearing.
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
      nearestPoint: [aLat, aLng],
      t: 0,
      bearing: 0
    };
  }

  // Projection scalar t onto line AB
  let t = (px * dx + py * dy) / segLenSq;
  t = Math.max(0, Math.min(1, t)); // Clamp to segment

  const projX = t * dx;
  const projY = t * dy;

  const nearestLat = aLat + t * (bLat - aLat);
  const nearestLng = aLng + t * (bLng - aLng);
  const bearing = calculateBearing(aLat, aLng, bLat, bLng);

  return {
    distance: Math.hypot(px - projX, py - projY),
    nearestPoint: [nearestLat, nearestLng],
    t,
    bearing
  };
}

/**
 * Matches a raw GPS coordinate to the nearest valid road position along a saved route.
 * 
 * @param {number} lat - Raw GPS latitude
 * @param {number} lng - Raw GPS longitude
 * @param {Array<Array<number>>} geometry - Route coordinates [[lat, lng], ...]
 * @param {Object} [options]
 * @param {number} [options.accuracy] - Device reported GPS accuracy in meters
 * @param {number} [options.speed] - Current vehicle speed in km/h
 * @param {number} [options.heading] - Current vehicle heading in degrees (0-360)
 * @param {number} [options.timestamp] - Fix timestamp (ms)
 * @param {number} [options.toleranceMeters] - Permitted corridor tolerance (default 100m)
 * @param {Object} [options.prevMatch] - Previous matched state for continuity & forward progression
 * @returns {Object} Map matching result with matchedLat, matchedLng, matchedHeading, isWithinRoute, etc.
 */
function matchPointToRoute(lat, lng, geometry, options = {}) {
  // 1. Sanity check coordinates
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
      rawLat: lat,
      rawLng: lng,
      matchedLat: null,
      matchedLng: null,
      matchedHeading: 0,
      error: "Invalid GPS coordinates"
    };
  }

  if (!geometry || !Array.isArray(geometry) || geometry.length < 2) {
    return {
      isWithinRoute: false,
      distanceMeters: Infinity,
      effectiveTolerance: DEFAULT_ROUTE_TOLERANCE_METERS,
      rawLat: lat,
      rawLng: lng,
      matchedLat: null,
      matchedLng: null,
      matchedHeading: 0,
      error: "Route geometry has insufficient points"
    };
  }

  // 2. Tolerance & GPS accuracy buffering
  const baseTolerance = typeof options.toleranceMeters === "number" && options.toleranceMeters > 0
    ? options.toleranceMeters
    : DEFAULT_ROUTE_TOLERANCE_METERS;

  const rawAccuracy = typeof options.accuracy === "number" && options.accuracy > 0 ? options.accuracy : 0;
  // If phone reports accuracy 25m, buffer by excess uncertainty above 15m, capped at +35m
  const accuracyBuffer = rawAccuracy > 15 ? Math.min(rawAccuracy - 15, 35) : 0;
  const effectiveTolerance = Math.round(baseTolerance + accuracyBuffer);

  const prevMatch = options.prevMatch || null;
  const rawHeading = typeof options.heading === "number" && !isNaN(options.heading) ? (options.heading + 360) % 360 : null;
  const rawSpeed = typeof options.speed === "number" && !isNaN(options.speed) ? Math.max(0, options.speed) : null;

  // 3. Define candidate search window
  // If we have previous state, search locally around prevMatch.segmentIndex first
  let candidatesRange = { start: 0, end: geometry.length - 2 };
  let isLocalWindow = false;

  if (prevMatch && typeof prevMatch.segmentIndex === "number" && prevMatch.segmentIndex >= 0) {
    // Look backward 3 segments, forward up to 30 segments (or ~1.5 km of road)
    const startIdx = Math.max(0, prevMatch.segmentIndex - 3);
    const endIdx = Math.min(geometry.length - 2, prevMatch.segmentIndex + 30);
    candidatesRange = { start: startIdx, end: endIdx };
    isLocalWindow = true;
  }

  function findBestCandidate(startIdx, endIdx) {
    let best = null;
    let minScore = Infinity;
    let minOrthogonalDist = Infinity;

    for (let i = startIdx; i <= endIdx; i++) {
      const a = geometry[i];
      const b = geometry[i + 1];

      const proj = distancePointToSegmentMeters(lat, lng, a[0], a[1], b[0], b[1]);

      if (proj.distance < minOrthogonalDist) {
        minOrthogonalDist = proj.distance;
      }

      // Compute weighted score (lower is better)
      let score = proj.distance;

      if (prevMatch && typeof prevMatch.segmentIndex === "number") {
        // Penalty for moving backward along the route
        if (i < prevMatch.segmentIndex) {
          const backSteps = prevMatch.segmentIndex - i;
          score += backSteps * 6; // Penalize moving back unless GPS distance is very close
        }

        // Bearing alignment penalty/reward
        if (rawHeading !== null && (rawSpeed === null || rawSpeed > 3)) {
          let diffH = Math.abs(rawHeading - proj.bearing) % 360;
          if (diffH > 180) diffH = 360 - diffH;

          if (diffH < 40) {
            score -= 10; // Reward heading aligned with road direction
          } else if (diffH > 110) {
            score += 35; // Penalize opposite direction (prevents snapping to oncoming lane / parallel road)
          }
        }
      }

      if (score < minScore) {
        minScore = score;
        best = {
          index: i,
          score,
          proj,
          dist: proj.distance,
          nearestPoint: proj.nearestPoint,
          bearing: proj.bearing,
          t: proj.t
        };
      }
    }

    return { best, minOrthogonalDist };
  }

  let result = findBestCandidate(candidatesRange.start, candidatesRange.end);

  // If local window search didn't find any segment within tolerance (or conductor jumped far ahead),
  // fallback to a full route search to re-acquire the bus
  if (isLocalWindow && result.minOrthogonalDist > effectiveTolerance) {
    result = findBestCandidate(0, geometry.length - 2);
  }

  const bestCandidate = result.best;
  const finalDistance = bestCandidate ? bestCandidate.dist : Infinity;

  // 4. Off-Route Check
  if (!bestCandidate || finalDistance > effectiveTolerance) {
    return {
      isWithinRoute: false,
      distanceMeters: Math.round(finalDistance * 10) / 10,
      effectiveTolerance,
      rawLat: lat,
      rawLng: lng,
      matchedLat: null,
      matchedLng: null,
      matchedHeading: rawHeading || 0,
      segmentIndex: bestCandidate ? bestCandidate.index : -1,
      nearestPoint: bestCandidate ? bestCandidate.nearestPoint : null
    };
  }

  // 5. On-Route: Calculate Matched Road Position & Heading
  let matchedLat = bestCandidate.nearestPoint[0];
  let matchedLng = bestCandidate.nearestPoint[1];
  let matchedHeading = Math.round(bestCandidate.bearing);

  // Stationary Jitter Filtering:
  // When the bus is stopped at a stop or traffic light, GPS pings wander within ~3-8m radius.
  // If speed is very low or distance from previous matched point is tiny, keep the previous position/heading
  if (prevMatch && prevMatch.matchedLat && prevMatch.matchedLng) {
    const distFromPrev = haversineMeters(prevMatch.matchedLat, prevMatch.matchedLng, matchedLat, matchedLng);

    const isStationary =
      (rawSpeed !== null && rawSpeed < 2.0) ||
      (distFromPrev < 2.0 && (!rawSpeed || rawSpeed < 4.0));

    if (isStationary) {
      if (distFromPrev < 1.5) {
        // Maintain exact previous position to eliminate resting jitter
        matchedLat = prevMatch.matchedLat;
        matchedLng = prevMatch.matchedLng;
      }
      if (typeof prevMatch.matchedHeading === "number") {
        // Maintain previous heading instead of random GPS rotation when stopped
        matchedHeading = prevMatch.matchedHeading;
      }
    }
  }

  return {
    isWithinRoute: true,
    distanceMeters: Math.round(finalDistance * 10) / 10,
    effectiveTolerance,
    rawLat: lat,
    rawLng: lng,
    matchedLat: Number(matchedLat.toFixed(6)),
    matchedLng: Number(matchedLng.toFixed(6)),
    matchedHeading: (matchedHeading + 360) % 360,
    segmentIndex: bestCandidate.index,
    t: bestCandidate.t,
    roadBearing: bestCandidate.bearing,
    nearestPoint: bestCandidate.nearestPoint
  };
}

/**
 * Backward-compatible validation wrapper matching the interface of routeValidator.js
 */
function validatePointOnRoute(lat, lng, geometry, options = {}) {
  const match = matchPointToRoute(lat, lng, geometry, options);
  return {
    isWithinRoute: match.isWithinRoute,
    distanceMeters: match.distanceMeters,
    effectiveTolerance: match.effectiveTolerance,
    nearestPoint: match.nearestPoint,
    matchedLat: match.matchedLat,
    matchedLng: match.matchedLng,
    matchedHeading: match.matchedHeading,
    segmentIndex: match.segmentIndex,
    error: match.error
  };
}

module.exports = {
  DEFAULT_ROUTE_TOLERANCE_METERS,
  haversineMeters,
  calculateBearing,
  distancePointToSegmentMeters,
  matchPointToRoute,
  validatePointOnRoute
};

