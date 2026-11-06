/**
 * Route Validation & Distance Calculation Engine
 * 
 * Provides strict geodesic, orthogonal, and route-aware map matching calculations.
 * Ensures the bus only broadcasts GPS data when operating within
 * the permitted corridor of the selected route, and snaps the displayed marker
 * to the exact road geometry of the route.
 */

const mapMatcher = require("./mapMatcher");

module.exports = {
  DEFAULT_ROUTE_TOLERANCE_METERS: mapMatcher.DEFAULT_ROUTE_TOLERANCE_METERS,
  haversineMeters: mapMatcher.haversineMeters,
  calculateBearing: mapMatcher.calculateBearing,
  distancePointToSegmentMeters: mapMatcher.distancePointToSegmentMeters,
  getDistanceToRoute: (lat, lng, geometry) => {
    const match = mapMatcher.matchPointToRoute(lat, lng, geometry);
    return {
      minDistanceMeters: match.distanceMeters,
      nearestPoint: match.nearestPoint,
      segmentIndex: match.segmentIndex
    };
  },
  matchPointToRoute: mapMatcher.matchPointToRoute,
  validatePointOnRoute: mapMatcher.validatePointOnRoute
};
