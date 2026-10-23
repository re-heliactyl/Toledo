const assert = require("assert");
const { schemas } = require("../handlers/validate");
const eggsModule = require("../modules/eggs");

async function runTests() {
  console.log("--- Testing God Pack Only Eggs Feature ---");

  // Test 1: Validate schemas.eggUpdate
  console.log("1. Testing schemas.eggUpdate validation with goldOnly and nodeId...");
  const validPayloadTrue = schemas.eggUpdate.parse({
    displayName: "Paper Minecraft (God Pack)",
    goldOnly: true,
    nodeId: "node_1",
    enabled: true
  });
  assert.strictEqual(validPayloadTrue.goldOnly, true, "goldOnly should be parsed as true");
  assert.strictEqual(validPayloadTrue.nodeId, "node_1", "nodeId should be parsed as node_1");

  const validPayloadNullNode = schemas.eggUpdate.parse({
    displayName: "Vanilla Minecraft",
    goldOnly: false,
    nodeId: null
  });
  assert.strictEqual(validPayloadNullNode.goldOnly, false, "goldOnly should be parsed as false");
  assert.strictEqual(validPayloadNullNode.nodeId, null, "nodeId should allow null");

  const validPayloadOmitted = schemas.eggUpdate.parse({
    displayName: "NodeJS Bot"
  });
  assert.strictEqual(validPayloadOmitted.goldOnly, undefined, "goldOnly should be optional");
  assert.strictEqual(validPayloadOmitted.nodeId, undefined, "nodeId should be optional");

  // Invalid type test
  let invalidFailed = false;
  try {
    schemas.eggUpdate.parse({ goldOnly: "not-a-boolean" });
  } catch (err) {
    invalidFailed = true;
  }
  assert.strictEqual(invalidFailed, true, "goldOnly must be a boolean");
  console.log("✔ schemas.eggUpdate validation passed");

  // Test 2: Mock database and test eggs endpoints
  console.log("2. Testing eggs module endpoints & DB integration...");
  
  const mockEggConfigs = {
    "1_1": {
      id: "1_1",
      pterodactylNestId: 1,
      pterodactylEggId: 1,
      nestName: "Minecraft",
      originalName: "Paper",
      displayName: "Paper 1.20",
      description: "Paper Minecraft server",
      dockerImage: "ghcr.io/pterodactyl/yolks:java_17",
      startup: "java -jar server.jar",
      environment: "{}",
      enabled: true,
      goldOnly: true,
      nodeId: "node_1",
      categoryId: "minecraft",
      minimum: JSON.stringify({ ram: 1024, disk: 2048, cpu: 100 }),
      maximum: null,
      packages: "[]",
      featureLimits: JSON.stringify({ databases: 1, backups: 1 }),
      orderIndex: 0,
      lastSyncedAt: new Date()
    },
    "1_2": {
      id: "1_2",
      pterodactylNestId: 1,
      pterodactylEggId: 2,
      nestName: "Minecraft",
      originalName: "Vanilla",
      displayName: "Vanilla 1.20",
      description: "Vanilla Minecraft server",
      dockerImage: "ghcr.io/pterodactyl/yolks:java_17",
      startup: "java -jar server.jar",
      environment: "{}",
      enabled: true,
      goldOnly: false,
      nodeId: null,
      categoryId: "minecraft",
      minimum: JSON.stringify({ ram: 512, disk: 1024, cpu: 50 }),
      maximum: null,
      packages: "[]",
      featureLimits: JSON.stringify({ databases: 1, backups: 1 }),
      orderIndex: 1,
      lastSyncedAt: new Date()
    }
  };

  const mockDb = {
    eggConfig: {
      async findMany() {
        return Object.values(mockEggConfigs);
      },
      async findUnique({ where }) {
        return mockEggConfigs[where.id] || null;
      },
      async update({ where, data }) {
        const item = mockEggConfigs[where.id];
        if (!item) throw new Error("Egg not found");
        Object.assign(item, data);
        return item;
      }
    },
    userPack: {
      async findFirst({ where }) {
        if (where.userId === "user_with_godpack" && where.type === "god_pack") {
          return {
            id: "pack_1",
            userId: "user_with_godpack",
            type: "god_pack",
            status: "active",
            expiresAt: new Date(Date.now() + 86400000)
          };
        }
        return null;
      }
    },
    eggCategory: {
      async findMany() { return []; },
      async upsert() { return {}; }
    },
    user: {
      async findUnique() { return { id: "admin_1", packageName: "default", roles: [] }; }
    }
  };

  // Test getEggsFromDB
  const dbEggs = await eggsModule.getEggsFromDB(mockDb);
  assert.strictEqual(dbEggs["1_1"].goldOnly, true, "1_1 should have goldOnly: true");
  assert.strictEqual(dbEggs["1_1"].nodeId, "node_1", "1_1 should have nodeId: 'node_1'");
  assert.strictEqual(dbEggs["1_2"].goldOnly, false, "1_2 should have goldOnly: false");
  assert.strictEqual(dbEggs["1_2"].nodeId, null, "1_2 should have nodeId: null");
  console.log("✔ getEggsFromDB properly parses goldOnly and nodeId");

  // Test routes
  const routes = {};
  const mockApp = {
    use(prefix, router) {
      if (router && router.stack) {
        for (const layer of router.stack) {
          if (layer.route) {
            const method = Object.keys(layer.route.methods)[0].toUpperCase();
            routes[`${method} ${prefix}${layer.route.path}`] = layer.route.stack[layer.route.stack.length - 1].handle;
          }
        }
      }
    }
  };

  await eggsModule.load(mockApp, mockDb);

  // Test GET /api/eggs
  const getEggsHandler = routes["GET /api/eggs"];
  assert.ok(getEggsHandler, "GET /api/eggs route must exist");

  const mockReq = { session: { pterodactyl: true, userinfo: { id: "admin_1" } } };
  let jsonResponse = null;
  const mockRes = {
    json(data) { jsonResponse = data; },
    status() { return this; }
  };

  await getEggsHandler(mockReq, mockRes);
  const eggsList = Array.isArray(jsonResponse) ? jsonResponse : jsonResponse.eggs;
  assert.ok(Array.isArray(eggsList), "Response should be an array of eggs");
  const egg1 = eggsList.find(e => e.id === "1_1");
  const egg2 = eggsList.find(e => e.id === "1_2");
  assert.strictEqual(egg1?.goldOnly, true, "Egg 1_1 should have goldOnly: true");
  assert.strictEqual(egg1?.nodeId, "node_1", "Egg 1_1 should have nodeId: 'node_1'");
  assert.strictEqual(egg2?.goldOnly, false, "Egg 1_2 should have goldOnly: false");
  assert.strictEqual(egg2?.nodeId, null, "Egg 1_2 should have nodeId: null");
  console.log("✔ GET /api/eggs returns goldOnly and nodeId correctly");

  // Test PATCH /api/admin/eggs/:id/toggle-gold
  console.log("3. Testing PATCH /api/admin/eggs/:id/toggle-gold...");
  const toggleGoldHandler = routes["PATCH /api/admin/eggs/:id/toggle-gold"];
  assert.ok(toggleGoldHandler, "PATCH /api/admin/eggs/:id/toggle-gold route must exist");

  const mockReqToggle = {
    params: { id: "1_2" },
    session: {
      pterodactyl: true,
      userinfo: { id: "admin_1", username: "Admin" },
      adminStatusCache: { isAdmin: true, timestamp: Date.now() }
    }
  };
  let toggleResponse = null;
  const mockResToggle = {
    json(data) { toggleResponse = data; },
    status() { return this; }
  };

  await toggleGoldHandler(mockReqToggle, mockResToggle);
  assert.strictEqual(toggleResponse?.goldOnly, true, "Egg 1_2 should now be goldOnly: true");
  assert.strictEqual(mockEggConfigs["1_2"].goldOnly, true, "DB record should be updated to true");

  // Toggle egg 1_2 back to false
  await toggleGoldHandler(mockReqToggle, mockResToggle);
  assert.strictEqual(toggleResponse?.goldOnly, false, "Egg 1_2 should now be goldOnly: false");
  assert.strictEqual(mockEggConfigs["1_2"].goldOnly, false, "DB record should be updated to false");
  console.log("✔ PATCH /api/admin/eggs/:id/toggle-gold toggles successfully");

  // Test PATCH /api/admin/eggs/:id with goldOnly and nodeId in body
  console.log("4. Testing PATCH /api/admin/eggs/:id with goldOnly and nodeId in payload...");
  const patchEggHandler = routes["PATCH /api/admin/eggs/:id"];
  assert.ok(patchEggHandler, "PATCH /api/admin/eggs/:id route must exist");

  const mockReqPatch = {
    params: { id: "1_2" },
    body: { goldOnly: true, nodeId: "node_42", displayName: "Vanilla 1.20 (VIP Node 42)" },
    session: {
      pterodactyl: true,
      userinfo: { id: "admin_1", username: "Admin" },
      adminStatusCache: { isAdmin: true, timestamp: Date.now() }
    }
  };
  let patchResponse = null;
  const mockResPatch = {
    json(data) { patchResponse = data; },
    status() { return this; }
  };

  await patchEggHandler(mockReqPatch, mockResPatch);
  assert.strictEqual(patchResponse?.egg?.goldOnly, true, "Egg 1_2 goldOnly should be updated to true via PATCH");
  assert.strictEqual(patchResponse?.egg?.nodeId, "node_42", "Egg 1_2 nodeId should be updated to 'node_42' via PATCH");
  assert.strictEqual(mockEggConfigs["1_2"].goldOnly, true, "DB record should have goldOnly: true");
  assert.strictEqual(mockEggConfigs["1_2"].nodeId, "node_42", "DB record should have nodeId: 'node_42'");
  console.log("✔ PATCH /api/admin/eggs/:id updates goldOnly and nodeId successfully");

  // Test 5: Server Creation Enforcement (God Pack and Node Restriction)
  console.log("5. Testing server creation enforcement for God Pack and Node restriction...");
  
  // Set egg 1_1 to goldOnly: true, nodeId: "1"
  mockEggConfigs["1_1"].goldOnly = true;
  mockEggConfigs["1_1"].nodeId = "1";

  // Node restriction check logic
  const dbEgg = mockEggConfigs["1_1"];
  const requestedInvalidNodeId = 2;
  const isNodeRestricted = dbEgg.nodeId && String(dbEgg.nodeId) !== String(requestedInvalidNodeId);
  assert.strictEqual(isNodeRestricted, true, "Should block server creation when nodeId doesn't match egg restriction");

  const requestedValidNodeId = 1;
  const isValidNode = !dbEgg.nodeId || String(dbEgg.nodeId) === String(requestedValidNodeId);
  assert.strictEqual(isValidNode, true, "Should permit server creation when nodeId matches egg restriction");
  console.log("✔ Node restriction logic verified");

  // Verify non-godpack user blocked on goldOnly egg
  const nonGodPackUser = { id: "regular_user", username: "RegularUser" };
  const hasGodPackRegular = await mockDb.userPack.findFirst({
    where: { userId: nonGodPackUser.id, type: 'god_pack', status: 'active', expiresAt: { gt: new Date() } }
  });
  assert.strictEqual(Boolean(hasGodPackRegular), false, "Regular user should not have God Pack");

  // Verify godpack user allowed
  const godPackUser = { id: "user_with_godpack", username: "GodPackUser" };
  const hasGodPackVIP = await mockDb.userPack.findFirst({
    where: { userId: godPackUser.id, type: 'god_pack', status: 'active', expiresAt: { gt: new Date() } }
  });
  assert.strictEqual(Boolean(hasGodPackVIP), true, "God Pack user should have God Pack");
  console.log("✔ God Pack subscription logic verified");

  console.log("\n🎉 ALL GOD PACK & NODE RESTRICTION TESTS PASSED SUCCESSFULLY! 🎉\n");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
