"use strict";

const assert = require("assert");
const { schemas, validate } = require("../handlers/validate");
const {
  matchServerId,
  SERVER_ID_REGEX,
  ownsServer,
  isServerOwner
} = require("../modules/server/core.js");

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

async function runSecurityTests() {
  console.log("=== Running Server Ownership & Traversal Security Tests ===");

  // 1. Validate schema rejects malicious traversal IDs
  {
    console.log("Test 1: serverIdParam rejects path traversal payload (abcd1234-x/../victim01)");
    const maliciousIds = [
      "abcd1234-x/../victim01",
      "abcd1234-x%2F..%2Fvictim01",
      "../victim01",
      "victim01/..",
      "abcd1234-extra",
      "../../../etc/passwd",
      "server-01;rm",
      ""
    ];

    for (const badId of maliciousIds) {
      const parseResult = schemas.serverIdParam.safeParse({ id: badId });
      assert.strictEqual(
        parseResult.success,
        false,
        `Schema must reject malicious/invalid server ID: "${badId}"`
      );
    }
    console.log("  Passed");
  }

  // 2. Validate schema accepts valid server identifiers
  {
    console.log("Test 2: serverIdParam accepts valid Pterodactyl server IDs (short hex, numeric, UUID)");
    const validIds = [
      "abcd1234",
      "1a2b3c4d",
      "42",
      "123456",
      "87fa5413-ca98-4676-ad1d-d8fa8df7c31e",
      "ABCDEF01"
    ];

    for (const goodId of validIds) {
      const parseResult = schemas.serverIdParam.safeParse({ id: goodId });
      assert.strictEqual(
        parseResult.success,
        true,
        `Schema should accept valid ID: "${goodId}"`
      );
    }
    console.log("  Passed");
  }

  // 3. Test validate middleware integration with traversal attempt
  {
    console.log("Test 3: validate middleware rejects traversal with 400 Bad Request");
    const req = {
      params: { id: "abcd1234-x/../victim01" }
    };
    const res = createMockRes();
    let nextCalled = false;

    const middleware = validate(schemas.serverIdParam, "params");
    middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "Next must not be called on validation failure");
    assert.strictEqual(res.statusCode, 400, "Status must be 400");
    assert.strictEqual(res.body?.error, "Validation failed");
    console.log("  Passed (Status: 400, Validation failed)");
  }

  // 4. Test exact comparison in matchServerId (no hyphen splitting)
  {
    console.log("Test 4: matchServerId prevents hyphen split bypass");
    const attackerServer = {
      id: 101,
      identifier: "abcd1234",
      uuid: "abcd1234-1111-2222-3333-444455556666"
    };

    // Attacker passes prefix matching their own server but targeting victim
    const attackTarget = "abcd1234-x/../victim01";
    const isMatch = matchServerId(attackerServer, attackTarget);
    assert.strictEqual(isMatch, false, "matchServerId must NEVER match when target contains traversal/suffix");

    // Legitimate target matching
    assert.strictEqual(matchServerId(attackerServer, "abcd1234"), true, "Must match short identifier");
    assert.strictEqual(matchServerId(attackerServer, "ABCD1234"), true, "Must match case-insensitively");
    assert.strictEqual(matchServerId(attackerServer, "101"), true, "Must match internal ID");
    assert.strictEqual(matchServerId(attackerServer, "abcd1234-1111-2222-3333-444455556666"), true, "Must match full UUID");
    assert.strictEqual(matchServerId(attackerServer, "victim01"), false, "Must not match other servers");
    console.log("  Passed");
  }

  // 5. Test ownsServer rejects traversal IDs before auth/cache lookups
  {
    console.log("Test 5: ownsServer rejects traversal IDs directly with 400");
    const req = {
      params: { id: "abcd1234-x/../victim01" }
    };
    const res = createMockRes();
    let nextCalled = false;

    await ownsServer(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "ownsServer must block traversal ID");
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body?.error, "Invalid server ID format");
    console.log("  Passed (Status: 400, Invalid server ID format)");
  }

  // 6. Test isServerOwner rejects traversal IDs directly with 400
  {
    console.log("Test 6: isServerOwner rejects traversal IDs directly with 400");
    const req = {
      params: { id: "abcd1234-x/../victim01" }
    };
    const res = createMockRes();
    let nextCalled = false;

    await isServerOwner(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "isServerOwner must block traversal ID");
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body?.error, "Invalid server ID format");
    console.log("  Passed (Status: 400, Invalid server ID format)");
  }

  console.log("=== All Server Ownership Security tests passed successfully! ===");
  process.exit(0);
}

runSecurityTests().catch(err => {
  console.error("Test failure:", err);
  process.exit(1);
});
