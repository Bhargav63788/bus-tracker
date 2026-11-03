const http = require("http");

// Port to run test server on
const TEST_PORT = 3899;
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
  console.log("==========================================");
  console.log("🧪 TESTING MAP-BASED ROUTE DRAWING SYSTEM");
  console.log("==========================================\n");

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

  try {
    // 1. Test Static Route Serving
    console.log("--- 1. Testing Route Editor Page Serving ---");
    const editorPage = await request("GET", "/route-editor.html");
    assert(editorPage.status === 200, "GET /route-editor.html returns 200 OK");
    assert(editorPage.raw.includes("Visual Road Route Creator"), "route-editor.html contains title");
    assert(editorPage.raw.includes("btnToggleDraw"), "route-editor.html contains Start Drawing button");
    assert(editorPage.raw.includes("btnToggleStops"), "route-editor.html contains Add Bus Stops button");

    const editorAlias = await request("GET", "/routes");
    assert(editorAlias.status === 200, "GET /routes alias serves route editor");

    // 2. Test Road Calculation Endpoint (OSRM / Geodesic)
    console.log("\n--- 2. Testing Road Geometry Calculation Endpoint ---");
    // Coordinates in Bangalore: Majestic Bus Station to MG Road
    const testWaypoints = [
      [12.9778, 77.5713],
      [12.9756, 77.6094]
    ];
    const calcRes = await request("POST", "/api/routes/calculate", {
      waypoints: testWaypoints
    });
    assert(calcRes.status === 200, "POST /api/routes/calculate returns 200 OK");
    assert(Array.isArray(calcRes.data.geometry), "Calculated route returns geometry array");
    assert(calcRes.data.geometry.length >= 2, `Geometry has points (count: ${calcRes.data.geometry.length})`);
    assert(calcRes.data.distanceKm > 0, `Distance calculated: ${calcRes.data.distanceKm} km`);
    assert(calcRes.data.durationMin > 0, `Duration estimated: ${calcRes.data.durationMin} min`);
    console.log(`ℹ️ Road route snapped: ${calcRes.data.isRoadSnapped ? "Yes (via OSRM)" : "Fallback (Geodesic)"}`);

    // 3. Test Route Creation & Persistence
    console.log("\n--- 3. Testing Route Creation & Database Persistence ---");
    const newRoutePayload = {
      name: "Test City Route 101",
      description: "Majestic to MG Road via Cubbon Park",
      distanceKm: calcRes.data.distanceKm,
      durationMin: calcRes.data.durationMin,
      waypoints: [
        { lat: 12.9778, lng: 77.5713 },
        { lat: 12.9756, lng: 77.6094 }
      ],
      geometry: calcRes.data.geometry,
      stops: [
        { id: "stop_1", name: "Majestic Terminal", lat: 12.9778, lng: 77.5713, sequence: 1 },
        { id: "stop_2", name: "Cubbon Park Metro", lat: 12.9760, lng: 77.5920, sequence: 2 },
        { id: "stop_3", name: "MG Road Station", lat: 12.9756, lng: 77.6094, sequence: 3 }
      ],
      isActive: true
    };

    const createRes = await request("POST", "/api/routes", newRoutePayload);
    assert(createRes.status === 201, "POST /api/routes returns 201 Created");
    assert(createRes.data.id && createRes.data.id.startsWith("route_"), `Route created with ID: ${createRes.data.id}`);
    assert(createRes.data.stops.length === 3, "All 3 designated bus stops saved");
    assert(createRes.data.isActive === true, "Route marked as active");
    const createdRouteId = createRes.data.id;

    // 4. Test Route Retrieval (GET /api/routes and GET /api/routes/:id)
    console.log("\n--- 4. Testing Route Listing & Retrieval ---");
    const listRes = await request("GET", "/api/routes");
    assert(listRes.status === 200, "GET /api/routes returns 200 OK");
    assert(Array.isArray(listRes.data), "GET /api/routes returns array");
    const foundInList = listRes.data.find(r => r.id === createdRouteId);
    assert(!!foundInList, "Created route appears in routes list");

    const getRes = await request("GET", `/api/routes/${createdRouteId}`);
    assert(getRes.status === 200, "GET /api/routes/:id returns 200 OK");
    assert(getRes.data.name === "Test City Route 101", "Fetched route has correct name");

    // 5. Test Active Route Endpoint
    console.log("\n--- 5. Testing Active Route Endpoint ---");
    const activeRes = await request("GET", "/api/routes/active");
    assert(activeRes.status === 200, "GET /api/routes/active returns 200 OK");
    assert(activeRes.data.id === createdRouteId, "Active route matches newly activated route");

    // 6. Test Route Update (Editing previously saved route)
    console.log("\n--- 6. Testing Route Editing (PUT /api/routes/:id) ---");
    const updatePayload = {
      name: "Test City Route 101 - Modified Express",
      description: "Updated description for express service"
    };
    const updateRes = await request("PUT", `/api/routes/${createdRouteId}`, updatePayload);
    assert(updateRes.status === 200, "PUT /api/routes/:id returns 200 OK");
    assert(updateRes.data.name === "Test City Route 101 - Modified Express", "Route name updated successfully");

    // 7. Test Route Deletion
    console.log("\n--- 7. Testing Route Deletion ---");
    const deleteRes = await request("DELETE", `/api/routes/${createdRouteId}`);
    assert(deleteRes.status === 200, "DELETE /api/routes/:id returns 200 OK");

    const verifyDeleted = await request("GET", `/api/routes/${createdRouteId}`);
    assert(verifyDeleted.status === 404, "Deleted route now returns 404 Not Found");

    console.log("\n==========================================");
    console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("==========================================");

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test execution error:", err);
    process.exit(1);
  }
}

// Wait briefly for server to bind if needed, then run
setTimeout(runTests, 500);

