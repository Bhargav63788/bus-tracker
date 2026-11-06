const http = require("http");
const { io: ClientIO } = require("socket.io-client");
const mapMatcher = require("./mapMatcher");

const TEST_PORT = 3908;
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
  console.log("🧪 TESTING GOOGLE MAPS-STYLE REAL-TIME BUS TRACKING");
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

  // Passenger Socket.IO client
  const passengerSocket = ClientIO(`http://127.0.0.1:${TEST_PORT}`, {
    transports: ["websocket", "polling"],
    forceNew: true
  });

  const conductorSocket = ClientIO(`http://127.0.0.1:${TEST_PORT}`, {
    transports: ["websocket", "polling"],
    forceNew: true
  });

  await Promise.all([
    new Promise((resolve) => passengerSocket.on("connect", resolve)),
    new Promise((resolve) => conductorSocket.on("connect", resolve))
  ]);

  console.log("Passenger and Conductor Socket.IO clients connected.\n");

  const passengerEvents = [];
  passengerSocket.on("location_update", (data) => passengerEvents.push(data));
  passengerSocket.on("bus_off_route", (data) => passengerEvents.push({ type: "off_route", ...data }));

  try {
    // ----------------------------------------------------
    // TEST 1: Unit testing mapMatcher projection & road snapping
    // ----------------------------------------------------
    console.log("--- TEST 1: Map Matcher Orthogonal Road Snapping ---");
    // Sample straight segment from A (13.0, 74.0) to B (13.0, 74.01) (Eastbound)
    const segA = [13.0, 74.0];
    const segB = [13.0, 74.01];
    const geom = [segA, segB];

    // Point P slightly North of road (13.00018, 74.005) (~20m lateral drift)
    const driftPoint = [13.00018, 74.005];
    const match = mapMatcher.matchPointToRoute(driftPoint[0], driftPoint[1], geom, {
      accuracy: 10,
      speed: 40,
      heading: 90
    });

    assert(match.isWithinRoute === true, "Drifted point is recognized on-route");
    assert(Math.abs(match.matchedLat - 13.0) < 0.00001, "Matched latitude snapped onto road centerline (lat 13.0)");
    assert(Math.abs(match.matchedLng - 74.005) < 0.0001, "Matched longitude is projected along the segment");
    assert(Math.abs(match.matchedHeading - 90) <= 2, "Heading matched to road bearing (Eastbound ~90 deg)");
    assert(match.distanceMeters >= 15 && match.distanceMeters <= 25, `Lateral distance to road correctly reported (~20m, got: ${match.distanceMeters}m)`);

    // ----------------------------------------------------
    // TEST 2: Start Conductor Tracking Session on Route 1
    // ----------------------------------------------------
    console.log("\n--- TEST 2: Conductor Starts Live Session on Saved Route ---");
    const routesRes = await request("GET", "/api/routes");
    const route1 = routesRes.data.find((r) => r.id === "route_1793686398582") || routesRes.data[0];

    const startPt = route1.geometry[0];
    const startRes = await request("POST", "/start-session", {
      busId: "BUS-01",
      routeId: route1.id,
      lat: startPt[0],
      lng: startPt[1],
      accuracy: 8
    });

    assert(startRes.status === 200, "Conductor started session successfully");

    // ----------------------------------------------------
    // TEST 3: Real-Time Mobile GPS with Lateral Drift (Snap to Road)
    // ----------------------------------------------------
    console.log("\n--- TEST 3: Conductor Sends Drifting GPS Fix (Must Snap to Exact Road) ---");
    passengerEvents.length = 0;

    // Pick a point along the road (pt 15), but add a 12m lateral GPS drift
    const roadPt = route1.geometry[15];
    // Offset slightly in latitude (~12m drift off the road)
    const rawJitterLat = roadPt[0] + 0.00011;
    const rawJitterLng = roadPt[1];

    conductorSocket.emit("conductor_location_update", {
      busId: "BUS-01",
      routeId: route1.id,
      lat: rawJitterLat,
      lng: rawJitterLng,
      accuracy: 12,
      speed: 35,
      heading: 180,
      timestamp: Date.now()
    });

    // Wait for Passenger Socket event
    await new Promise((r) => setTimeout(r, 200));

    assert(passengerEvents.length > 0, "Passenger received real-time location update over Socket.IO");
    const latestPassengerLoc = passengerEvents[passengerEvents.length - 1];

    assert(latestPassengerLoc.busId === "BUS-01", "Payload matches BUS-01");
    assert(latestPassengerLoc.isOffRoute === false, "Reported ON-ROUTE");
    assert(latestPassengerLoc.rawLat === rawJitterLat, "Original raw GPS latitude preserved for reference");
    assert(Math.abs(latestPassengerLoc.lat - roadPt[0]) < Math.abs(rawJitterLat - roadPt[0]), "Matched latitude is corrected closer to road centerline than noisy raw GPS");
    assert(latestPassengerLoc.heading > 0, `Orientation heading provided for Google Maps marker (${latestPassengerLoc.heading} deg)`);

    // ----------------------------------------------------
    // TEST 4: Continuous Sequential Progression (No Teleportation)
    // ----------------------------------------------------
    console.log("\n--- TEST 4: Continuous Movement along Route ---");
    passengerEvents.length = 0;

    // Conductor moves to pt 16, pt 17
    for (let i = 16; i <= 18; i++) {
      const pt = route1.geometry[i];
      conductorSocket.emit("conductor_location_update", {
        busId: "BUS-01",
        routeId: route1.id,
        lat: pt[0],
        lng: pt[1],
        accuracy: 6,
        speed: 42,
        timestamp: Date.now()
      });
      await new Promise((r) => setTimeout(r, 80));
    }

    await new Promise((r) => setTimeout(r, 150));
    assert(passengerEvents.length >= 3, `Passenger received continuous GPS updates without refresh (count: ${passengerEvents.length})`);
    const lastLoc = passengerEvents[passengerEvents.length - 1];
    assert(lastLoc.speed === 42, "Reliable speed correctly passed to passenger UI");
    assert(lastLoc.segmentIndex >= 15, `Progresses forward along route segments (segmentIndex: ${lastLoc.segmentIndex})`);

    // ----------------------------------------------------
    // TEST 5: Off-Route Shielding (Coordinates Hidden from Passenger)
    // ----------------------------------------------------
    console.log("\n--- TEST 5: Off-Route Drift Exceeding Corridor (> 100m) ---");
    passengerEvents.length = 0;

    conductorSocket.emit("conductor_location_update", {
      busId: "BUS-01",
      routeId: route1.id,
      lat: roadPt[0],
      lng: roadPt[1] - 0.05, // ~5 km off into the Arabian Sea
      accuracy: 10,
      speed: 25,
      timestamp: Date.now()
    });

    await new Promise((r) => setTimeout(r, 200));

    const offRouteEvent = passengerEvents.find((e) => e.type === "off_route" || e.isOffRoute);
    assert(offRouteEvent !== undefined, "Passenger received off-route notification");
    assert(offRouteEvent.lat === undefined && offRouteEvent.lng === undefined, "CRITICAL: Off-route GPS coordinates are completely shielded from passenger");

    // Query GET /get-location during off-route
    const pollLoc = await request("GET", "/get-location?busId=BUS-01");
    assert(pollLoc.data.isOffRoute === true, "GET /get-location indicates isOffRoute: true");
    assert(pollLoc.data.hasLocation === false, "GET /get-location hasLocation: false");
    assert(pollLoc.data.lat === undefined, "GET /get-location coordinates hidden");

    // ----------------------------------------------------
    // TEST 6: Conductor Returns to Route (Seamless Resumption)
    // ----------------------------------------------------
    console.log("\n--- TEST 6: Conductor Returns to Route Corridor ---");
    passengerEvents.length = 0;

    const returnPt = route1.geometry[20];
    conductorSocket.emit("conductor_location_update", {
      busId: "BUS-01",
      routeId: route1.id,
      lat: returnPt[0],
      lng: returnPt[1],
      accuracy: 8,
      speed: 38,
      timestamp: Date.now()
    });

    await new Promise((r) => setTimeout(r, 200));

    const resumedLoc = passengerEvents.find((e) => !e.isOffRoute && e.lat);
    assert(resumedLoc !== undefined, "Passenger map automatically resumed receiving live GPS updates upon return to route");
    assert(resumedLoc.isOffRoute === false, "Resumed location marked ON-ROUTE");
    assert(typeof resumedLoc.lat === "number" && typeof resumedLoc.lng === "number", "Resumed location contains valid road coordinates");

    // Clean up
    await request("POST", "/stop-session", { busId: "BUS-01" });
    passengerSocket.disconnect();
    conductorSocket.disconnect();

    console.log("\n=========================================================");
    console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("=========================================================\n");

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test execution error:", err);
    passengerSocket.disconnect();
    conductorSocket.disconnect();
    process.exit(1);
  }
}

setTimeout(runTests, 500);

