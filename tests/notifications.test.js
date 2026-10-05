const assert = require("assert");
const notificationsModule = require("../modules/notifications.js");

// Validate HeliactylModule manifest
assert.strictEqual(notificationsModule.HeliactylModule.name, "Notifications");
assert.strictEqual(typeof notificationsModule.load, "function");

console.log("✔ Manifest validation passed");

// Mock Express app and db
const routes = {};
const mockApp = {
  get(path, middleware, handler) {
    routes[`GET ${path}`] = { middleware, handler };
  },
  post(path, middleware, handler) {
    routes[`POST ${path}`] = { middleware, handler };
  },
  delete(path, middleware, handler) {
    routes[`DELETE ${path}`] = { middleware, handler };
  }
};

let notificationsStore = [
  { id: "notif-1", userId: "user-1", action: "ticket:reply", name: "Staff replied to ticket #1", read: false, createdAt: new Date("2026-10-05T10:00:00Z") },
  { id: "notif-2", userId: "user-1", action: "security:2fa", name: "2FA enabled", read: true, createdAt: new Date("2026-10-05T09:00:00Z") },
  { id: "notif-3", userId: "user-1", action: "coins:bonus", name: "Daily bonus", read: false, createdAt: new Date("2026-10-05T08:00:00Z") },
  { id: "notif-4", userId: "user-2", action: "ticket:create", name: "Ticket created", read: false, createdAt: new Date("2026-10-05T07:00:00Z") }
];

const mockDb = {
  notification: {
    async findMany(args) {
      let filtered = notificationsStore.filter(n => {
        if (n.userId !== args.where.userId) return false;
        if (args.where.read !== undefined && n.read !== args.where.read) return false;
        return true;
      });
      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const skip = args.skip || 0;
      const take = args.take || filtered.length;
      return filtered.slice(skip, skip + take);
    },
    async count(args) {
      let filtered = notificationsStore.filter(n => {
        if (n.userId !== args.where.userId) return false;
        if (args.where.read !== undefined && n.read !== args.where.read) return false;
        return true;
      });
      return filtered.length;
    },
    async updateMany(args) {
      let count = 0;
      for (const n of notificationsStore) {
        if (args.where.id && n.id !== args.where.id) continue;
        if (n.userId !== args.where.userId) continue;
        if (args.where.read !== undefined && n.read !== args.where.read) continue;
        Object.assign(n, args.data);
        count++;
      }
      return { count };
    },
    async deleteMany(args) {
      const initialLen = notificationsStore.length;
      notificationsStore = notificationsStore.filter(n => {
        if (args.where.id && n.id === args.where.id && n.userId === args.where.userId) return false;
        return true;
      });
      return { count: initialLen - notificationsStore.length };
    }
  }
};

(async () => {
  await notificationsModule.load(mockApp, mockDb);

  assert(routes["GET /api/v5/notifications"], "GET /api/v5/notifications route should be registered");
  assert(routes["POST /api/v5/notifications/:id/read"], "POST /api/v5/notifications/:id/read should be registered");
  assert(routes["POST /api/v5/notifications/read-all"], "POST /api/v5/notifications/read-all should be registered");
  assert(routes["DELETE /api/v5/notifications/:id"], "DELETE /api/v5/notifications/:id should be registered");

  console.log("✔ Routes registration passed");

  function createReq(userId, query = {}, params = {}) {
    return {
      session: { userinfo: { id: userId } },
      query,
      params
    };
  }

  function createRes() {
    return {
      statusCode: 200,
      jsonBody: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonBody = data;
        return this;
      }
    };
  }

  // Test 1: GET /api/v5/notifications default
  {
    const req = createReq("user-1", {});
    const res = createRes();
    await routes["GET /api/v5/notifications"].handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonBody.data.length, 3);
    assert.strictEqual(res.jsonBody.unreadCount, 2);
    assert.strictEqual(res.jsonBody.pagination.total, 3);
    assert.strictEqual(res.jsonBody.pagination.page, 1);
    assert.strictEqual(res.jsonBody.pagination.limit, 20);
    console.log("✔ Test 1: GET /api/v5/notifications default passed");
  }

  // Test 2: GET /api/v5/notifications unreadOnly=true
  {
    const req = createReq("user-1", { unreadOnly: "true" });
    const res = createRes();
    await routes["GET /api/v5/notifications"].handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonBody.data.length, 2);
    assert.strictEqual(res.jsonBody.unreadCount, 2);
    assert.strictEqual(res.jsonBody.pagination.total, 2);
    console.log("✔ Test 2: GET unreadOnly passed");
  }

  // Test 3: POST /api/v5/notifications/:id/read
  {
    const req = createReq("user-1", {}, { id: "notif-1" });
    const res = createRes();
    await routes["POST /api/v5/notifications/:id/read"].handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { success: true });
    const item = notificationsStore.find(n => n.id === "notif-1");
    assert.strictEqual(item.read, true);
    console.log("✔ Test 3: POST :id/read passed");
  }

  // Test 4: POST /api/v5/notifications/read-all
  {
    const req = createReq("user-1");
    const res = createRes();
    await routes["POST /api/v5/notifications/read-all"].handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonBody.success, true);
    assert.strictEqual(res.jsonBody.updatedCount, 1); // Only notif-3 was still unread for user-1
    const unread = notificationsStore.filter(n => n.userId === "user-1" && !n.read);
    assert.strictEqual(unread.length, 0);
    console.log("✔ Test 4: POST read-all passed");
  }

  // Test 5: DELETE /api/v5/notifications/:id
  {
    const req = createReq("user-1", {}, { id: "notif-1" });
    const res = createRes();
    await routes["DELETE /api/v5/notifications/:id"].handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { success: true });
    const item = notificationsStore.find(n => n.id === "notif-1");
    assert.strictEqual(item, undefined);
    console.log("✔ Test 5: DELETE :id passed");
  }

  console.log("🎉 All notification tests passed successfully!");
})();

