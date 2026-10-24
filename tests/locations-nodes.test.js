const assert = require("assert");
const locationsNodes = require("../modules/locations-nodes.js");

// 1. Manifest validation
assert.strictEqual(locationsNodes.HeliactylModule.name, "Locations & Nodes");
assert.strictEqual(locationsNodes.HeliactylModule.version, "1.1.2");
assert.strictEqual(locationsNodes.HeliactylModule.author.name, "aachul123");
console.log("✔ Manifest validation passed");

// 2. Permission hierarchy testing
(async function testPermissionHierarchy() {
  // Helper to create mock db and request with specific permissions
  function createTestEnv(permissions, isRoot = false) {
    const mockDb = {
      user: {
        findUnique: async () => ({
          id: 1,
          roles: [
            {
              role: {
                permissions: JSON.stringify(permissions)
              }
            }
          ]
        })
      }
    };

    const req = {
      session: {
        userinfo: { id: 1 },
        pterodactyl: { id: 1 },
        adminStatusCache: {
          isAdmin: isRoot,
          timestamp: Date.now()
        }
      }
    };

    return { mockDb, req };
  }

  const res = {};

  // Case 1: User with only admin.nodes.view
  const { mockDb: db1, req: viewOnlyReq } = createTestEnv(["admin.nodes.view"]);
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(viewOnlyReq, res, db1, "admin.nodes.view"),
    true,
    "admin.nodes.view should permit view"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(viewOnlyReq, res, db1, "admin.nodes.edit"),
    false,
    "admin.nodes.view should NOT permit edit"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(viewOnlyReq, res, db1, "admin.nodes.manage"),
    false,
    "admin.nodes.view should NOT permit manage"
  );

  // Case 2: User with admin.nodes.edit (without explicit admin.nodes.view)
  const { mockDb: db2, req: editOnlyReq } = createTestEnv(["admin.nodes.edit"]);
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(editOnlyReq, res, db2, "admin.nodes.view"),
    true,
    "admin.nodes.edit should permit view"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(editOnlyReq, res, db2, "admin.nodes.edit"),
    true,
    "admin.nodes.edit should permit edit"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(editOnlyReq, res, db2, "admin.nodes.manage"),
    false,
    "admin.nodes.edit should NOT permit manage"
  );

  // Case 3: User with admin.nodes.manage (without explicit admin.nodes.view or admin.nodes.edit)
  const { mockDb: db3, req: manageOnlyReq } = createTestEnv(["admin.nodes.manage"]);
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(manageOnlyReq, res, db3, "admin.nodes.view"),
    true,
    "admin.nodes.manage should permit view"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(manageOnlyReq, res, db3, "admin.nodes.edit"),
    true,
    "admin.nodes.manage should permit edit"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(manageOnlyReq, res, db3, "admin.nodes.manage"),
    true,
    "admin.nodes.manage should permit manage"
  );

  // Case 4: Default parameter (requiredPerm = 'admin.nodes.view')
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(editOnlyReq, res, db2),
    true,
    "Default requiredPerm should be satisfied by admin.nodes.edit"
  );
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(manageOnlyReq, res, db3),
    true,
    "Default requiredPerm should be satisfied by admin.nodes.manage"
  );

  // Case 5: Unauthorized user
  const { mockDb: db4, req: unauthReq } = createTestEnv(["user.basic"]);
  assert.strictEqual(
    await locationsNodes.checkAdminStatus(unauthReq, res, db4, "admin.nodes.view"),
    false,
    "unauthorized user should not satisfy view"
  );

  console.log("✔ All permission hierarchy test assertions passed successfully!");
  process.exit(0);
})();

