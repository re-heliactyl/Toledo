const assert = require("assert");
const bcrypt = require("bcrypt");
const authModule = require("../modules/auth.js");

// 1. Manifest validation
assert.strictEqual(authModule.HeliactylModule.name, "Authentication");
assert.strictEqual(authModule.HeliactylModule.version, "1.1.1");
console.log("PASS: Manifest validation passed");

(async () => {
  const routes = {};
  const middlewares = [];
  const mockApp = {
    use(fn) {
      middlewares.push(fn);
    },
    post(path, ...handlers) {
      routes["POST " + path] = handlers[handlers.length - 1];
    },
    get(path, ...handlers) {
      routes["GET " + path] = handlers[handlers.length - 1];
    },
    delete(path, ...handlers) {
      routes["DELETE " + path] = handlers[handlers.length - 1];
    }
  };

  const passwordHash = await bcrypt.hash("secret123", 10);

  const mockDb = {
    user: {
      findUnique({ where }) {
        if (where.email === "2fa-user@example.com") {
          return Promise.resolve({
            id: "user-2fa-1",
            username: "twofa_user",
            email: "2fa-user@example.com",
            password: passwordHash,
            twoFactorEnabled: true,
            discordId: null,
            pterodactylId: 101,
            isBanned: false
          });
        }
        if (where.email === "normal-user@example.com") {
          return Promise.resolve({
            id: "user-normal-1",
            username: "normal_user",
            email: "normal-user@example.com",
            password: passwordHash,
            twoFactorEnabled: false,
            discordId: null,
            pterodactylId: 102,
            isBanned: false
          });
        }
        if (where.id === "user-2fa-1") {
          return Promise.resolve({
            id: "user-2fa-1",
            username: "twofa_user",
            email: "2fa-user@example.com",
            twoFactorEnabled: true,
            discordId: null,
            pterodactylId: 101,
            isBanned: false
          });
        }
        return Promise.resolve(null);
      },
      update: () => Promise.resolve({})
    },
    authToken: {
      findUnique({ where }) {
        if (where.token === "valid-magic-2fa") {
          return Promise.resolve({
            token: "valid-magic-2fa",
            type: "magic",
            userId: "user-2fa-1",
            usedAt: null,
            expiresAt: new Date(Date.now() + 600000)
          });
        }
        return Promise.resolve(null);
      },
      updateMany({ where }) {
        if (where.token === "valid-magic-2fa") {
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }
    },
    notification: {
      create: () => Promise.resolve({})
    }
  };

  await authModule.load(mockApp, mockDb);

  // Assert dead middleware is completely removed
  assert.strictEqual(middlewares.length, 0, "No dead middleware should be registered with app.use");
  console.log("PASS: Dead req.login middleware removal verified");

  // Test 1: POST /auth/login with 2FA enabled
  const loginHandler = routes["POST /auth/login"];
  assert.ok(loginHandler, "POST /auth/login handler must exist");

  const req1 = {
    body: { email: "2fa-user@example.com", password: "secret123" },
    session: {},
    headers: { "user-agent": "test-agent" },
    path: "/auth/login"
  };
  let jsonRes1 = null;
  const res1 = {
    status(code) { this.statusCode = code; return this; },
    json(data) { jsonRes1 = data; return this; }
  };

  await loginHandler(req1, res1);
  assert.strictEqual(req1.session.twoFactorPending, true, "twoFactorPending must be true");
  assert.strictEqual(req1.session.twoFactorUserId, "user-2fa-1", "twoFactorUserId must match user.id");
  assert.strictEqual(req1.session.userinfo, undefined, "userinfo must NOT be set when 2FA is pending");
  assert.strictEqual(req1.session.pterodactyl, undefined, "pterodactyl session must NOT be set when 2FA is pending");
  assert.deepStrictEqual(jsonRes1, { requires2FA: true, twoFactorPending: true }, "Must return requires2FA response");
  console.log("PASS: POST /auth/login halts and sets twoFactorPending when user has 2FA enabled");

  // Test 2: GET /auth/magic-login with 2FA enabled
  const magicHandler = routes["GET /auth/magic-login"];
  assert.ok(magicHandler, "GET /auth/magic-login handler must exist");

  const req2 = {
    query: { token: "valid-magic-2fa" },
    session: {},
    headers: { "user-agent": "test-agent" },
    path: "/auth/magic-login"
  };
  let redirectUrl2 = null;
  const res2 = {
    status(code) { this.statusCode = code; return this; },
    json(data) { return this; },
    redirect(url) { redirectUrl2 = url; return this; }
  };

  await magicHandler(req2, res2);
  assert.strictEqual(req2.session.twoFactorPending, true, "twoFactorPending must be true for magic login");
  assert.strictEqual(req2.session.twoFactorUserId, "user-2fa-1", "twoFactorUserId must match user.id for magic login");
  assert.strictEqual(req2.session.userinfo, undefined, "userinfo must NOT be set for magic login when 2FA pending");
  assert.strictEqual(redirectUrl2, "/auth/2fa", "Must redirect to /auth/2fa");
  console.log("PASS: GET /auth/magic-login halts and redirects to /auth/2fa when user has 2FA enabled");

  console.log("ALL TESTS PASSED SUCCESSFULLY");
})().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
