const http = require("http");
const { io: ClientIO } = require("socket.io-client");

const TEST_PORT = 3904;
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
  console.log("🧪 TESTING MULTI-BUS SELECTION & INDEPENDENT TRACKING");
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

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket connection timed out")), 5000);
    passengerSocket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    passengerSocket.on("connect_error", (e) => {
      console.log("Socket connect error:", e.message);
    });
  });
  console.log("Passenger Socket.IO connected.\n");

  const receivedSocketEvents = [];
  passengerSocket.on("location_update", (data) => receivedSocketEvents.push({ event: "location_update", data }));
  passengerSocket.on("bus_off_route", (data) => receivedSocketEvents.push({ event: "bus_off_route", data }));
  passengerSocket.on("buses_update", (data) => receivedSocketEvents.push({ event: "buses_update", data }));
  passengerSocket.on("bus_state", (data) => receivedSocketEvents.push({ event: "bus_state", data }));

  try {
    // ----------------------------------------------------
    // TEST 1: GET /api/buses lists available buses
    // ----------------------------------------------------
    console.log("--- TEST 1: GET /api/buses returns available buses list ---");
    const busesRes = await request("GET", "/api/buses");
    assert(busesRes.status === 200, "GET /api/buses returns 200 OK");
    assert(Array.isArray(busesRes.data), "Response is an array of buses");
    assert(busesRes.data.length >= 3, `Found at least 3 buses (found: ${busesRes.data.length})`);

    const busIds = busesRes.data.map(b => b.busId);
    assert(busIds.includes("BUS-01"), "Lists BUS-01");
    assert(busIds.includes("BUS-02"), "Lists BUS-02");
    assert(busIds.includes("BUS-03"), "Lists BUS-03");

    // Fetch routes to obtain exact geometric points
    const routesRes = await request("GET", "/api/routes");
    assert(routesRes.status === 200, "GET /api/routes returns 200 OK");
    const route1 = routesRes.data.find(r => r.id === "route_1793686398582") || routesRes.data[0];
    const route2 = routesRes.data.find(r => r.id === "route_1793685867911") || routesRes.data[1];

    const r1Point = route1.geometry[0];
    const r2Point = route2.geometry[0];

    // ----------------------------------------------------
    // TEST 2: Start Tracking for BUS-01 on Route 1
    // ----------------------------------------------------
    console.log("\n--- TEST 2: Start tracking session for BUS-01 on Route 1 ---");
    const startBus1 = await request("POST", "/start-session", {
      busId: "BUS-01",
      routeId: route1.id,
      lat: r1Point[0],
      lng: r1Point[1],
      accuracy: 10
    });
    assert(startBus1.status === 200, "BUS-01 start tracking succeeded");
    assert(startBus1.data.routeId === route1.id, "Assigned route is Route 1");

    // ----------------------------------------------------
    // TEST 3: Start Tracking for BUS-02 on Route 2
    // ----------------------------------------------------
    console.log("\n--- TEST 3: Start tracking session for BUS-02 on Route 2 ---");
    const startBus2 = await request("POST", "/start-session", {
      busId: "BUS-02",
      routeId: route2.id,
      lat: r2Point[0],
      lng: r2Point[1],
      accuracy: 10
    });
    assert(startBus2.status === 200, "BUS-02 start tracking succeeded");
    assert(startBus2.data.routeId === route2.id, "Assigned route is Route 2");

    // ----------------------------------------------------
    // TEST 4: Telemetry Update for BUS-01 (On-Route)
    // ----------------------------------------------------
    console.log("\n--- TEST 4: Post on-route telemetry for BUS-01 ---");
    const updateBus1 = await request("POST", "/update-location", {
      busId: "BUS-01",
      lat: route1.geometry[5][0],
      lng: route1.geometry[5][1],
      accuracy: 8,
      speed: 35,
      heading: 90
    });
    assert(updateBus1.status === 200, "BUS-01 update location accepted");
    assert(updateBus1.data.isOffRoute === false, "BUS-01 is marked ON-ROUTE");
    assert(updateBus1.data.busId === "BUS-01", "Payload identifies BUS-01");

    // ----------------------------------------------------
    // TEST 5: Telemetry Update for BUS-02 (Off-Route)
    // ----------------------------------------------------
    console.log("\n--- TEST 5: Post off-route telemetry for BUS-02 ---");
    // Off Route 2 (shifted into Arabian Sea: -0.2 deg longitude)
    const updateBus2 = await request("POST", "/update-location", {
      busId: "BUS-02",
      lat: r2Point[0],
      lng: r2Point[1] - 0.2, // > 20 km away from Route 2 geometry
      accuracy: 10,
      speed: 20,
      heading: 0
    });
    assert(updateBus2.status === 200, "BUS-02 update handled gracefully");
    assert(updateBus2.data.isOffRoute === true, "BUS-02 correctly flagged OFF-ROUTE");
    assert(updateBus2.data.status === "off_route", "BUS-02 status is off_route");

    // ----------------------------------------------------
    // TEST 6: Query GET /get-location for specific buses
    // ----------------------------------------------------
    console.log("\n--- TEST 6: Query /get-location?busId=... for individual buses ---");
    const getBus1 = await request("GET", "/get-location?busId=BUS-01");
    assert(getBus1.status === 200, "GET /get-location?busId=BUS-01 returns 200");
    assert(getBus1.data.busId === "BUS-01", "Returns BUS-01 data");
    assert(getBus1.data.hasLocation === true, "BUS-01 has active location");
    assert(getBus1.data.isOffRoute === false, "BUS-01 is not off route");
    assert(typeof getBus1.data.lat === "number", "BUS-01 latitude is available to passenger");

    const getBus2 = await request("GET", "/get-location?busId=BUS-02");
    assert(getBus2.status === 200, "GET /get-location?busId=BUS-02 returns 200");
    assert(getBus2.data.busId === "BUS-02", "Returns BUS-02 data");
    assert(getBus2.data.isOffRoute === true, "BUS-02 flagged off-route");
    assert(getBus2.data.hasLocation === false, "BUS-02 off-route location is HIDDEN from passenger");
    assert(getBus2.data.lat === undefined, "BUS-02 coordinates NOT exposed to passenger");

    const getBus3 = await request("GET", "/get-location?busId=BUS-03");
    assert(getBus3.status === 200, "GET /get-location?busId=BUS-03 returns 200");
    assert(getBus3.data.busId === "BUS-03", "Returns BUS-03 data");
    assert(getBus3.data.sessionStatus === "stopped", "BUS-03 session is idle/stopped");

    // ----------------------------------------------------
    // TEST 7: Query Socket.IO query_bus event
    // ----------------------------------------------------
    console.log("\n--- TEST 7: Passenger Socket query_bus for BUS-01 ---");
    const busStatePromise = new Promise((resolve) => {
      const handler = (state) => {
        if (state && state.busId === "BUS-01") {
          passengerSocket.off("bus_state", handler);
          resolve(state);
        }
      };
      passengerSocket.on("bus_state", handler);
    });
    passengerSocket.emit("query_bus", "BUS-01");
    const stateBus1 = await busStatePromise;
    assert(stateBus1.busId === "BUS-01", "Received bus_state for BUS-01 via Socket.IO");
    assert(stateBus1.busLocation !== null, "BUS-01 has valid location in socket state");

    // ----------------------------------------------------
    // TEST 8: GET /api/buses shows updated live statuses
    // ----------------------------------------------------
    console.log("\n--- TEST 8: Verify GET /api/buses statuses reflect multi-bus state ---");
    const updatedBuses = await request("GET", "/api/buses");
    const b1 = updatedBuses.data.find(b => b.busId === "BUS-01");
    const b2 = updatedBuses.data.find(b => b.busId === "BUS-02");
    const b3 = updatedBuses.data.find(b => b.busId === "BUS-03");

    assert(b1 && b1.status === "live", "BUS-01 status is 'live'");
    assert(b2 && b2.status === "off_route", "BUS-02 status is 'off_route'");
    assert(b3 && (b3.status === "idle" || b3.status === "stopped"), "BUS-03 status is 'idle' or 'stopped'");

    // ----------------------------------------------------
    // TEST 9: Stop Sessions for buses independently
    // ----------------------------------------------------
    console.log("\n--- TEST 9: Stop tracking session for BUS-01 and BUS-02 ---");
    const stopBus1 = await request("POST", "/stop-session", { busId: "BUS-01" });
    assert(stopBus1.status === 200, "BUS-01 session stopped successfully");
    assert(stopBus1.data.busId === "BUS-01", "Stop response identifies BUS-01");

    const stopBus2 = await request("POST", "/stop-session", { busId: "BUS-02" });
    assert(stopBus2.status === 200, "BUS-02 session stopped successfully");
    assert(stopBus2.data.busId === "BUS-02", "Stop response identifies BUS-02");

    // Clean up
    passengerSocket.disconnect();

    console.log("\n=========================================================");
    console.log(`RESULTS: Passed: ${passed}, Failed: ${failed}`);
    console.log("=========================================================\n");

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error("Test execution error:", err);
    process.exit(1);
  }
}

setTimeout(runTests, 500);
