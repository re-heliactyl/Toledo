"use strict";

const assert = require("assert");
const crypto = require("crypto");
const updater = require("../modules/updater.js");

async function runTests() {
  console.log("--- Testing Updater Module ---");

  // 1. Verify Manifest
  assert.ok(updater.HeliactylModule, "Manifest exists");
  assert.strictEqual(updater.HeliactylModule.name, "Updater");
  assert.strictEqual(updater.HeliactylModule.version, "1.2.1");
  assert.strictEqual(updater.HeliactylModule.api_level, 4);
  assert.strictEqual(updater.HeliactylModule.target_platform, "10.0.0");
  assert.strictEqual(updater.HeliactylModule.author.name, "aachul123");
  console.log("  Manifest verification passed");

  // 2. Test routes setup and mock DB / App
  const routes = {};
  const mockApp = {
    get: (path, handler) => { routes["GET " + path] = handler; },
    post: (path, handler) => { routes["POST " + path] = handler; }
  };

  const store = {};
  const mockDb = {
    heliactyl: {
      findUnique: async ({ where }) => {
        return store[where.key] ? { value: store[where.key] } : null;
      },
      upsert: async ({ where, update, create }) => {
        store[where.key] = update.value;
        return { value: store[where.key] };
      }
    },
    user: {
      findUnique: async () => ({
        id: 1,
        username: "admin",
        email: "admin@example.com",
        pterodactylId: 100,
        roles: [
          { role: { permissions: JSON.stringify(["admin.updater.manage", "*"]) } }
        ]
      })
    }
  };

  await updater.load(mockApp, mockDb);

  assert.ok(routes["GET /api/admin/updater/config"], "GET /api/admin/updater/config exists");
  assert.ok(routes["POST /api/admin/updater/config"], "POST /api/admin/updater/config exists");
  assert.ok(routes["GET /api/admin/updater/status"], "GET /api/admin/updater/status exists");
  assert.ok(routes["POST /api/admin/updater/trigger"], "POST /api/admin/updater/trigger exists");
  assert.ok(routes["POST /api/webhooks/github"], "POST /api/webhooks/github exists");
  console.log("  Routes registered successfully");

  // 3. Test Config GET and POST
  let resStatus = 200;
  let resData = null;
  const mockRes = {
    status: (code) => { resStatus = code; return mockRes; },
    json: (data) => { resData = data; return mockRes; }
  };
  const adminReq = {
    session: {
      userinfo: { id: 1 },
      pterodactyl: { id: 100 },
      adminStatusCache: { isAdmin: true, timestamp: Date.now() }
    },
    body: {}
  };

  // Initial config should have defaults
  await routes["GET /api/admin/updater/config"](adminReq, mockRes);
  assert.strictEqual(resData.enabled, true);
  assert.strictEqual(resData.checkInterval, 30);
  assert.strictEqual(resData.maxBackups, 3);
  console.log("  Initial config returns defaults");

  // 4. Test Webhook when secret is empty / not configured
  const noSecretReq = {
    headers: {
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=abcdef"
    },
    body: { ref: "refs/heads/main" }
  };
  resStatus = 200;
  resData = null;
  await routes["POST /api/webhooks/github"](noSecretReq, mockRes);
  assert.strictEqual(resStatus, 403, "Webhook without configured secret must be rejected with 403");
  assert.strictEqual(resData.error, "Webhook secret not configured");
  console.log("  Unconfigured webhook secret rejected with 403");

  // Update config with a valid secret
  adminReq.body = { enabled: false, checkInterval: 60, maxBackups: 5, webhookSecret: "secret123" };
  await routes["POST /api/admin/updater/config"](adminReq, mockRes);
  assert.strictEqual(resData.success, true);
  assert.strictEqual(resData.config.enabled, false);
  assert.strictEqual(resData.config.checkInterval, 60);
  assert.strictEqual(resData.config.maxBackups, 5);
  console.log("  Config update persists correctly");

  // Secret is masked on retrieval
  await routes["GET /api/admin/updater/config"](adminReq, mockRes);
  assert.strictEqual(resData.webhookSecret, "*********");
  console.log("  Webhook secret is masked on GET");

  // Invalid checkInterval validation
  adminReq.body = { checkInterval: 2 };
  await routes["POST /api/admin/updater/config"](adminReq, mockRes);
  assert.strictEqual(resStatus, 400);
  console.log("  Invalid checkInterval rejection passed");

  // 5. Test Webhook with missing signature header
  resStatus = 200;
  resData = null;
  const missingSigReq = {
    headers: { "x-github-event": "push" },
    body: { ref: "refs/heads/main" }
  };
  await routes["POST /api/webhooks/github"](missingSigReq, mockRes);
  assert.strictEqual(resStatus, 401, "Webhook without signature header must be rejected with 401");
  assert.strictEqual(resData.error, "Missing or invalid signature header");
  console.log("  Missing signature header rejected with 401");

  // 6. Test Webhook with invalid signature prefix (not sha256=)
  resStatus = 200;
  resData = null;
  const invalidFormatReq = {
    headers: {
      "x-github-event": "push",
      "x-hub-signature-256": "sha1=abcdef"
    },
    body: { ref: "refs/heads/main" }
  };
  await routes["POST /api/webhooks/github"](invalidFormatReq, mockRes);
  assert.strictEqual(resStatus, 401, "Webhook with non-sha256 signature format must be rejected with 401");
  console.log("  Invalid signature prefix rejected with 401");

  // 7. Test Webhook with wrong signature
  resStatus = 200;
  resData = null;
  const wrongSigReq = {
    headers: {
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000"
    },
    body: { ref: "refs/heads/main" }
  };
  await routes["POST /api/webhooks/github"](wrongSigReq, mockRes);
  assert.strictEqual(resStatus, 403, "Webhook with incorrect signature must be rejected with 403");
  assert.strictEqual(resData.error, "Invalid webhook signature");
  console.log("  Forged/wrong signature rejected with 403");

  // 8. Test Webhook with valid signature (rawBody buffer)
  const payload = JSON.stringify({ action: "ping" });
  const rawBody = Buffer.from(payload, "utf8");
  const validHash = crypto.createHmac("sha256", "secret123").update(rawBody).digest("hex");

  resStatus = 200;
  resData = null;
  const validPingReq = {
    headers: {
      "x-github-event": "ping",
      "x-hub-signature-256": "sha256=" + validHash
    },
    rawBody: rawBody,
    body: JSON.parse(payload)
  };
  await routes["POST /api/webhooks/github"](validPingReq, mockRes);
  assert.strictEqual(resStatus, 200, "Valid webhook must return 200");
  assert.strictEqual(resData.status, "ignored");
  assert.strictEqual(resData.event, "ping");
  console.log("  Valid HMAC-SHA256 signature verified and accepted");

  // 9. Test Webhook release event trigger with valid signature
  const releasePayload = JSON.stringify({ action: "published" });
  const releaseRawBody = Buffer.from(releasePayload, "utf8");
  const releaseHash = crypto.createHmac("sha256", "secret123").update(releaseRawBody).digest("hex");

  resStatus = 200;
  resData = null;
  const validReleaseReq = {
    headers: {
      "x-github-event": "release",
      "x-hub-signature-256": "sha256=" + releaseHash
    },
    rawBody: releaseRawBody,
    body: JSON.parse(releasePayload)
  };
  await routes["POST /api/webhooks/github"](validReleaseReq, mockRes);
  assert.strictEqual(resStatus, 200);
  assert.strictEqual(resData.status, "updating");
  console.log("  Valid release webhook triggers update check");

  console.log("All updater module tests passed successfully!");
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
