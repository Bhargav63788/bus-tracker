const http = require("http");
const { io: ClientIO } = require("socket.io-client");

const TEST_PORT = 3902;
process.env.PORT = TEST_PORT;

const { server, app, io } = require("./server");

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: path,
      method: method,
      headers: {
        "Content-Type": "application/json"
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("=========================================================");
  console.log("🧪 TESTING ROUTE-RESTRICTED REAL-TIME BUS TRACKING");
  console.log("=========================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  }

  // Connect Passenger Socket.IO client
  let passengerSocket = null;
  const socketEvents = {
    locationUpdates: [],
    offRouteEvents: [],
    sessionStarts: [],
    sessionStops: [],
    routeActivations: []
  };

  try {
    passengerSocket = ClientIO(`http://127.0.0.1:${TEST_PORT}`, {
      transports: ["websocket", "polling"]
    });

    passengerSocket.on("location_update", (data) => socketEvents.locationUpdates.push(data));
    passengerSocket.on("bus_off_route", (data) => socketEvents.offRouteEvents.push(data));
    passengerSocket.on("session_started", (data) => socketEvents.sessionStarts.push(data));
    passengerSocket.on("session_stopped", (data) => socketEvents.sessionStops.push(data));
    passengerSocket.on("route_activated", (data) => socketEvents.routeActivations.push(data));

    await new Promise((r) => passengerSocket.on("connect", r));
    console.log("ℹ️ Passenger Socket.IO client connected successfully\n");

    // ----------------------------------------------------
    // Step 1: Verify Saved Routes
    // ----------------------------------------------------
    console.log("--- 1. Route Discovery & Selection ---");
    const routesRes = await request("GET", "/api/routes");
    assert(routesRes.status === 200, "GET /api/routes returns 200 OK");
    assert(Array.isArray(routesRes.data) && routesRes.data.length >= 2, `Found ${routesRes.data.length} saved routes in database`);

    const route1 = routesRes.data.find(r => r.name.toLowerCase().includes("kundapura") && r.name.toLowerCase().includes("udupi"));
    const route2 = routesRes.data.find(r => r.name.toLowerCase().includes("siddapura"));
    assert(!!route1, `Route 1 identified: "${route1 ? route1.name : 'none'}" (${route1 ? route1.geometry.length : 0} points)`);
    assert(!!route2, `Route 2 identified: "${route2 ? route2.name : 'none'}" (${route2 ? route2.geometry.length : 0} points)`);

    // ----------------------------------------------------
    // Step 2: Conductor Attempts to Start Tracking OUTSIDE Route
    // ----------------------------------------------------
    console.log("\n--- 2. Start Tracking OUTSIDE Selected Route (Must be Blocked) ---");
    // Coordinates in Bangalore (12.9716, 77.5946), >300km away from Kundapura-Udupi route
    const outsideCoords = { lat: 12.9716, lng: 77.5946, accuracy: 15 };
    const blockedRes = await request("POST", "/start-session", {
      routeId: route1.id,
      lat: outsideCoords.lat,
      lng: outsideCoords.lng,
      accuracy: outsideCoords.accuracy
    });

    assert(blockedRes.status === 403, `Start rejected with HTTP 403 Forbidden (got ${blockedRes.status})`);
    assert(
      blockedRes.data.error === "You are outside the selected bus route. Move to the route to start tracking.",
      "Exact required error message returned"
    );
    assert(blockedRes.data.distanceMeters > 100000, `Reported off-route distance: ${(blockedRes.data.distanceMeters / 1000).toFixed(1)} km`);

    // Verify tracking session did NOT start
    const statusAfterBlock = await request("GET", "/api/status");
    assert(statusAfterBlock.data.sessionStatus === "stopped", "Tracking session remains stopped");

    // ----------------------------------------------------
    // Step 3: Conductor Starts Tracking INSIDE Selected Route
    // ----------------------------------------------------
    console.log("\n--- 3. Start Tracking INSIDE Selected Route ---");
    const route1Start = route1.geometry[0]; // [13.622987, 74.692112]
    const startRes = await request("POST", "/start-session", {
      routeId: route1.id,
      lat: route1Start[0],
      lng: route1Start[1],
      accuracy: 10
    });

    assert(startRes.status === 200, "Start accepted with HTTP 200 OK");
    assert(startRes.data.status === "success", "Session started successfully");
    assert(startRes.data.routeId === route1.id, `Session tied to route ${route1.name}`);

    // Wait for Socket.IO event
    await new Promise(r => setTimeout(r, 200));
    assert(socketEvents.sessionStarts.length > 0, "Passenger received session_started Socket.IO event");

    // ----------------------------------------------------
    // Step 4: Conductor Moves Along Route (ON ROUTE)
    // ----------------------------------------------------
    console.log("\n--- 4. Conductor Moves Along Route (Continuous Validation: ON ROUTE) ---");
    socketEvents.locationUpdates.length = 0;

    // Send point 1: exactly on route (pt 10)
    const onRoutePt1 = route1.geometry[10];
    const update1 = await request("POST", "/update-location", {
      lat: onRoutePt1[0],
      lng: onRoutePt1[1],
      accuracy: 10,
      speed: 35,
      routeId: route1.id
    });
    assert(update1.status === 200, "Update 1 accepted");
    assert(update1.data.isOffRoute === false, "Location confirmed ON ROUTE (isOffRoute: false)");
    assert(update1.data.distanceToRouteMeters <= 5, `Distance to route: ${update1.data.distanceToRouteMeters}m`);

    // Send point 2: 40 meters off route (within 100m tolerance)
    // 0.00035 deg is ~38m
    const nearRoutePt2 = [onRoutePt1[0] + 0.00035, onRoutePt1[1]];
    const update2 = await request("POST", "/update-location", {
      lat: nearRoutePt2[0],
      lng: nearRoutePt2[1],
      accuracy: 12,
      speed: 38,
      routeId: route1.id
    });
    assert(update2.data.isOffRoute === false, `Near point (dist: ${update2.data.distanceToRouteMeters}m) allowed within 100m corridor`);

    await new Promise(r => setTimeout(r, 200));
    assert(socketEvents.locationUpdates.length >= 2, "Passenger received live location_update events");
    assert(socketEvents.locationUpdates[0].lat === onRoutePt1[0], "Passenger received accurate coordinates");

    // Check GET /get-location for passenger polling
    const pollOnRoute = await request("GET", "/get-location");
    assert(pollOnRoute.data.hasLocation === true, "GET /get-location hasLocation is true");
    assert(pollOnRoute.data.isOffRoute === false, "GET /get-location isOffRoute is false");
    assert(typeof pollOnRoute.data.lat === "number", "GET /get-location returns valid lat/lng when on-route");

    // ----------------------------------------------------
    // Step 5: Conductor Leaves Route (OFF ROUTE - Strict Shielding)
    // ----------------------------------------------------
    console.log("\n--- 5. Conductor Leaves Route (OFF ROUTE - Location Shielding) ---");
    socketEvents.locationUpdates.length = 0;
    socketEvents.offRouteEvents.length = 0;

    // Move conductor 500 meters away perpendicularly (west of route)
    const offRoutePt = [onRoutePt1[0], onRoutePt1[1] - 0.005];
    const offUpdate = await request("POST", "/update-location", {
      lat: offRoutePt[0],
      lng: offRoutePt[1],
      accuracy: 10,
      speed: 25,
      routeId: route1.id
    });

    assert(offUpdate.status === 200, "Off-route update handled by backend");
    assert(offUpdate.data.isOffRoute === true, "Backend flags isOffRoute: true");
    assert(offUpdate.data.status === "off_route", "Status set to off_route");
    assert(offUpdate.data.distanceToRouteMeters > 100, `Distance to route: ${offUpdate.data.distanceToRouteMeters}m exceeds 100m tolerance`);

    await new Promise(r => setTimeout(r, 200));

    // Passenger verification: Location publishing paused & coordinates hidden!
    assert(socketEvents.locationUpdates.length === 0, "CRITICAL: NO location_update was broadcast to passengers");
    assert(socketEvents.offRouteEvents.length > 0, "Passenger received bus_off_route notification event");
    const offEvent = socketEvents.offRouteEvents[0];
    assert(offEvent.lat === undefined && offEvent.lng === undefined, "CRITICAL: bus_off_route event contains NO latitude or longitude");

    // Verify GET /get-location hides off-route coordinates from polling passengers
    const pollOffRoute = await request("GET", "/get-location");
    assert(pollOffRoute.data.hasLocation === false, "GET /get-location hasLocation is FALSE while off-route");
    assert(pollOffRoute.data.isOffRoute === true, "GET /get-location isOffRoute is TRUE");
    assert(pollOffRoute.data.lat === undefined && pollOffRoute.data.lng === undefined, "CRITICAL: GET /get-location contains NO coordinates while off-route");

    // ----------------------------------------------------
    // Step 6: Conductor Returns to Route (Publishing Resumes)
    // ----------------------------------------------------
    console.log("\n--- 6. Conductor Returns to Route (Publishing Resumes) ---");
    socketEvents.locationUpdates.length = 0;

    // Move back on route (pt 150)
    const returnedPt = route1.geometry[150];
    const resumeUpdate = await request("POST", "/update-location", {
      lat: returnedPt[0],
      lng: returnedPt[1],
      accuracy: 10,
      speed: 40,
      routeId: route1.id
    });

    assert(resumeUpdate.data.isOffRoute === false, "Recovered to route: isOffRoute is false");
    await new Promise(r => setTimeout(r, 200));
    assert(socketEvents.locationUpdates.length > 0, "Location publishing to passengers automatically RESUMED");
    assert(socketEvents.locationUpdates[0].lat === returnedPt[0], "Passenger received new valid on-route GPS coordinates");

    // ----------------------------------------------------
    // Step 7: Multi-Route Isolation Test (Route 2: Siddapura - Kundapura)
    // ----------------------------------------------------
    console.log("\n--- 7. Second Route Test (Route Isolation: Siddapura - Kundapura) ---");
    const route2Start = route2.geometry[0];
    const r2StartRes = await request("POST", "/start-session", {
      routeId: route2.id,
      lat: route2Start[0],
      lng: route2Start[1],
      accuracy: 10
    });

    assert(r2StartRes.status === 200, "Route 2 tracking started successfully");
    assert(r2StartRes.data.routeId === route2.id, `Session tied to Route 2: ${route2.name}`);

    // Send point on Route 2: [13.6300, 74.7200]
    const r2Pt = route2.geometry[20];
    const r2Update = await request("POST", "/update-location", {
      lat: r2Pt[0],
      lng: r2Pt[1],
      accuracy: 10,
      routeId: route2.id
    });
    assert(r2Update.data.isOffRoute === false, `Location on Route 2 valid (${r2Update.data.distanceToRouteMeters}m from route)`);

    // Send point in Udupi (valid on Route 1, but >30km away from Route 2!)
    const udupiPt = route1.geometry[route1.geometry.length - 1]; // Udupi point
    const r2OffUpdate = await request("POST", "/update-location", {
      lat: udupiPt[0],
      lng: udupiPt[1],
      accuracy: 10,
      routeId: route2.id
    });
    assert(r2OffUpdate.data.isOffRoute === true, "Udupi point correctly flagged as OFF ROUTE for Route 2 (Siddapura-Kundapura)");
    assert(r2OffUpdate.data.distanceToRouteMeters > 5000, `Distance to Route 2: ${(r2OffUpdate.data.distanceToRouteMeters / 1000).toFixed(1)} km`);

    // ----------------------------------------------------
    // Step 8: Conductor Stops Tracking
    // ----------------------------------------------------
    console.log("\n--- 8. Stop Tracking ---");
    const stopRes = await request("POST", "/stop-session");
    assert(stopRes.status === 200, "POST /stop-session returns 200 OK");
    await new Promise(r => setTimeout(r, 200));
    assert(socketEvents.sessionStops.length > 0, "Passenger received session_stopped event");

    const finalStatus = await request("GET", "/api/status");
    assert(finalStatus.data.sessionStatus === "stopped", "Session status is stopped");

    console.log("\n=========================================================");
    console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("=========================================================");

    passengerSocket.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test execution error:", err);
    if (passengerSocket) passengerSocket.disconnect();
    process.exit(1);
  }
}

setTimeout(runTests, 500);
