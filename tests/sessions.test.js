const assert = require("assert");
const geoip = require("geoip-lite");
const sessionsModule = require("../modules/sessions.js");

// 1. Manifest validation
assert.strictEqual(sessionsModule.HeliactylModule.name, "Sessions");
assert.strictEqual(sessionsModule.HeliactylModule.version, "1.1.1");
assert.strictEqual(sessionsModule.HeliactylModule.api_level, 4);
assert.strictEqual(sessionsModule.HeliactylModule.author.name, "aachul123");
assert.ok(sessionsModule.HeliactylModule.dependencies.includes("geoip-lite"));
assert.strictEqual(typeof sessionsModule.load, "function");
console.log("✔ Manifest validation passed");

// 2. Ensure NO outbound network requests occur
let outboundFetchAttempted = false;
const originalFetch = global.fetch;
global.fetch = () => {
  outboundFetchAttempted = true;
  throw new Error("Outbound fetch must not be called for geolocation lookups!");
};

// Mock Express app and db
const routes = {};
const mockApp = {
  get(path, ...handlers) { routes[`GET ${path}`] = { middleware: handlers.slice(0, -1), handler: handlers[handlers.length - 1] }; },
  post(path, ...handlers) { routes[`POST ${path}`] = { middleware: handlers.slice(0, -1), handler: handlers[handlers.length - 1] }; },
  delete(path, ...handlers) { routes[`DELETE ${path}`] = { middleware: handlers.slice(0, -1), handler: handlers[handlers.length - 1] }; },
  sessionStore: {
    get(sid, cb) { cb(null, null); },
    destroy(sid, cb) { cb(null); }
  }
};

const mockDb = {
  notification: {
    async create() { return {}; }
  }
};

async function runTests() {
  // Load the module onto mock app
  await sessionsModule.load(mockApp, mockDb);

  // Verify routes are registered
  assert.ok(routes["GET /api/user/sessions"], "GET /api/user/sessions must be registered");
  assert.ok(routes["POST /api/user/sessions/revoke-others"], "POST /api/user/sessions/revoke-others must be registered");
  assert.ok(routes["DELETE /api/user/sessions/revoke-others"], "DELETE /api/user/sessions/revoke-others must be registered");
  assert.ok(routes["DELETE /api/user/sessions/others"], "DELETE /api/user/sessions/others must be registered");
  assert.ok(routes["DELETE /api/user/sessions/:sid"], "DELETE /api/user/sessions/:sid must be registered");
  console.log("✔ Routes registration passed");

  // Verify direct in-memory geoip resolution
  const publicGeo = geoip.lookup("8.8.8.8");
  assert.ok(publicGeo, "geoip-lite should resolve public IP 8.8.8.8");
  assert.strictEqual(publicGeo.country, "US");

  const privateGeo = geoip.lookup("127.0.0.1");
  assert.strictEqual(privateGeo, null, "geoip-lite should return null for 127.0.0.1");
  console.log("✔ In-memory geoip resolution verified");

  // Mock request / response for GET /api/user/sessions
  const getSessionsHandler = routes["GET /api/user/sessions"].handler;
  const mockReq = {
    sessionID: "sid-current-123",
    session: {
      sessionIp: "82.64.0.1", // French public IP
      userAgent: "Mozilla/5.0 Test",
      createdAt: Date.now() - 3600000,
      lastActivity: Date.now(),
      userinfo: { id: "user-123" },
      save(cb) { cb(); }
    },
    sessionStore: {
      db: {
        all(query, params, cb) {
          cb(null, [
            {
              sid: "sid-other-456",
              expired: Date.now() + 86400000,
              sess: JSON.stringify({
                userinfo: { id: "user-123" },
                sessionIp: "192.168.1.50", // Private LAN IP
                userAgent: "Mobile Safari",
                createdAt: Date.now() - 7200000,
                lastActivity: Date.now() - 1800000
              })
            }
          ]);
        }
      }
    },
    headers: { "user-agent": "Mozilla/5.0 Test" }
  };

  let jsonResponse = null;
  const mockRes = {
    json(data) {
      jsonResponse = data;
    },
    status(code) {
      return {
        json(data) { jsonResponse = { statusCode: code, ...data }; }
      };
    }
  };

  await getSessionsHandler(mockReq, mockRes);

  assert.ok(jsonResponse, "Response should be provided");
  assert.ok(Array.isArray(jsonResponse.sessions), "Response should contain sessions array");
  assert.strictEqual(jsonResponse.sessions.length, 2, "Should return 2 active sessions");

  const currentSession = jsonResponse.sessions.find(s => s.id === "sid-current-123");
  assert.ok(currentSession, "Current session should be found");
  assert.strictEqual(currentSession.isCurrent, true);
  assert.ok(currentSession.location, "Location should be resolved for public IP");
  assert.strictEqual(currentSession.location.country, "FR");
  assert.ok(currentSession.location.city, "City should be resolved");

  const otherSession = jsonResponse.sessions.find(s => s.id === "sid-other-456");
  assert.ok(otherSession, "Other session should be found");
  assert.strictEqual(otherSession.isCurrent, false);
  assert.strictEqual(otherSession.location, null, "Private LAN IP should have null location");

  // Verify zero outbound fetch calls were made
  assert.strictEqual(outboundFetchAttempted, false, "Zero outbound fetch calls occurred during lookup");
  console.log("✔ GET /api/user/sessions returned in-memory locations without network calls");

  global.fetch = originalFetch;
  console.log("🎉 All sessions security and geolocation tests passed successfully!");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
