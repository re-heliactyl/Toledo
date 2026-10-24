
"use strict";

const assert = require("assert");
const {
  requireServerPermission,
  isServerOwner,
  ownsServer
} = require("../modules/server/core.js");

async function runTests() {
  console.log("=== Testing Subuser Authorization & RBAC Middleware ===");

  // Helper to create mock res
  function createMockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
      send(data) {
        this.body = data;
        return this;
      }
    };
  }

  // 1. Test requireServerPermission with server owner
  {
    console.log("Test 1: requireServerPermission allows server owner");
    const req = {
      isOwner: true,
      serverPermissions: ['*'],
      params: { id: "test-server" }
    };
    const res = createMockRes();
    let nextCalled = false;
    const middleware = requireServerPermission("control.console");
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true, "Next should be called for server owner");
    assert.strictEqual(res.statusCode, 200);
    console.log("  Passed");
  }

  // 2. Test requireServerPermission with subuser having permission
  {
    console.log("Test 2: requireServerPermission allows subuser with exact permission");
    const req = {
      isOwner: false,
      serverPermissions: ["control.console", "file.read"],
      params: { id: "test-server" }
    };
    const res = createMockRes();
    let nextCalled = false;
    const middleware = requireServerPermission("control.console");
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true, "Next should be called for subuser with permission");
    assert.strictEqual(res.statusCode, 200);
    console.log("  Passed");
  }

  // 3. Test requireServerPermission with subuser having one of multiple permissions
  {
    console.log("Test 3: requireServerPermission allows subuser matching array permissions");
    const req = {
      isOwner: false,
      serverPermissions: ["websocket.connect"],
      params: { id: "test-server" }
    };
    const res = createMockRes();
    let nextCalled = false;
    const middleware = requireServerPermission(["websocket.connect", "control.console"]);
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true, "Next should be called for subuser with websocket.connect");
    console.log("  Passed");
  }

  // 4. Test requireServerPermission denies subuser without permission
  {
    console.log("Test 4: requireServerPermission blocks subuser missing permission");
    const req = {
      isOwner: false,
      serverPermissions: ["file.read"], // has file.read, but requests control.console
      params: { id: "test-server" }
    };
    const res = createMockRes();
    let nextCalled = false;
    const middleware = requireServerPermission("control.console");
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "Next must NOT be called when permission is missing");
    assert.strictEqual(res.statusCode, 403, "Response status must be 403");
    assert.ok(res.body?.error, "Response should contain error explanation");
    console.log("  Passed (Status: 403, Error: " + res.body.error + ")");
  }

  // 5. Test requireServerPermission denies subuser on file write without file.create
  {
    console.log("Test 5: requireServerPermission blocks unauthorized file modification");
    const req = {
      isOwner: false,
      serverPermissions: ["file.read"], // only read, no write/create
      params: { id: "test-server" }
    };
    const res = createMockRes();
    let nextCalled = false;
    const middleware = requireServerPermission(["file.create", "file.update"]);
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "Subuser without write permission must be blocked");
    assert.strictEqual(res.statusCode, 403, "Response status must be 403");
    console.log("  Passed (Status: 403)");
  }

  // 6. Test requireServerPermission denies subuser on file delete without file.delete
  {
    console.log("Test 6: requireServerPermission blocks unauthorized file deletion");
    const req = {
      isOwner: false,
      serverPermissions: ["file.read", "file.create"],
      params: { id: "test-server" }
    };
    const res = createMockRes();
    let nextCalled = false;
    const middleware = requireServerPermission("file.delete");
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "Subuser without file.delete must be blocked");
    assert.strictEqual(res.statusCode, 403, "Response status must be 403");
    console.log("  Passed (Status: 403)");
  }

  // 7. Verify isServerOwner restricts access to non-owners
  {
    console.log("Test 7: isServerOwner rejects missing server ID");
    const req = { params: {} };
    const res = createMockRes();
    let nextCalled = false;
    await isServerOwner(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 400);
    console.log("  Passed");
  }

  console.log("=== All Subuser Authorization tests passed successfully! ===");
}

runTests().catch(err => {
  console.error("Test failure:", err);
  process.exit(1);
});
