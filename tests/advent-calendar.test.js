const assert = require("assert");
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const advent = require("../modules/advent.js");

const { parseStart, getTimeline, rollReward, getAdventConfig, TOTAL_DAYS } = advent._internal;
const DAY_MS = 24 * 60 * 60 * 1000;

assert.strictEqual(advent.HeliactylModule.name, "Advent Calendar");
console.log("PASS: Manifest validation passed");

// --- Start date parsing (server local time) ---
assert.deepStrictEqual(parseStart("01/12/2026 00:00"), { year: 2026, month: 12, day: 1, hour: 0, minute: 0 });
assert.deepStrictEqual(parseStart(" 5/1/2027 18:30 "), { year: 2027, month: 1, day: 5, hour: 18, minute: 30 });
assert.strictEqual(parseStart("31/02/2026 00:00"), null);
assert.strictEqual(parseStart("2026-12-01 00:00"), null);
assert.strictEqual(parseStart(""), null);
console.log("PASS: Start date parsing");

// --- Timeline ---
{
  const start = parseStart("01/12/2026 00:00");
  const before = getTimeline(start, new Date(2026, 10, 30, 23, 59));
  assert.strictEqual(before.phase, "upcoming");
  assert.strictEqual(before.currentDay, null);
  assert.strictEqual(before.nextUnlockAt.getTime(), new Date(2026, 11, 1, 0, 0).getTime());

  const day1 = getTimeline(start, new Date(2026, 11, 1, 0, 0));
  assert.strictEqual(day1.phase, "active");
  assert.strictEqual(day1.currentDay, 1);

  const day24 = getTimeline(start, new Date(2026, 11, 24, 23, 59));
  assert.strictEqual(day24.currentDay, 24);
  assert.strictEqual(day24.nextUnlockAt, null);

  const after = getTimeline(start, new Date(2026, 11, 25, 0, 0));
  assert.strictEqual(after.phase, "ended");
  assert.strictEqual(after.currentDay, null);
}
console.log("PASS: Timeline");

// --- Helpers: config, mock db, mock app ---
function pad(n) { return String(n).padStart(2, "0"); }
function formatStart(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// Calendar started yesterday at the current minute, so "today" is day 2.
function activeStart() {
  const d = new Date(Date.now() - DAY_MS);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - 1);
  return formatStart(d);
}

function setAdvent(overrides) {
  settings.advent = {
    enabled: true,
    start: activeStart(),
    chances: { coins: 0, resources: 0, bundle: 0 },
    coins: { min: 10, max: 20 },
    resources: { ram: { min: 128, max: 256 }, disk: { enabled: false, max: 0 }, cpu: { enabled: false, max: 0 }, servers: { enabled: false, max: 0 } },
    bundle: {
      auto_renew: { enabled: false, chance: 0, min_days: 1, max_days: 1 },
      upgraded_pack: { enabled: false, chance: 0, min_days: 1, max_days: 1 },
      god_pack: { enabled: false, chance: 0, min_days: 1, max_days: 1 }
    },
    discord: { enabled: false },
    ...overrides
  };
}

function createDb() {
  const state = {
    users: { "user-1": { id: "user-1", username: "alice", discordId: null, coins: 100, extraRam: 0, extraDisk: 0, extraCpu: 0, extraServers: 0 } },
    transactions: [],
    packs: [],
    claims: [],
    notifications: []
  };
  const db = {
    state,
    async $transaction(fn) {
      // Roll back on failure, like a real database transaction.
      const snapshot = JSON.stringify({ users: state.users, transactions: state.transactions.length, packs: state.packs.length, claims: state.claims.length });
      try {
        return await fn(db);
      } catch (err) {
        const s = JSON.parse(snapshot);
        state.users = s.users;
        state.transactions.length = s.transactions;
        state.packs.length = s.packs;
        state.claims.length = s.claims;
        throw err;
      }
    },
    transaction: {
      async create({ data }) {
        if (data.externalId && state.transactions.some((t) => t.externalId === data.externalId)) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        const row = { ...data, createdAt: new Date() };
        state.transactions.push(row);
        return row;
      },
      async findMany({ where }) {
        return state.transactions.filter((t) => t.userId === where.userId && t.type === where.type && t.externalId.startsWith(where.externalId.startsWith));
      }
    },
    user: {
      async update({ where, data }) {
        const u = state.users[where.id];
        for (const [k, v] of Object.entries(data)) u[k] += v.increment;
        return u;
      },
      async findUnique({ where }) { return state.users[where.id]; }
    },
    userPack: {
      async findFirst({ where }) {
        const now = where.expiresAt.gt;
        const rows = state.packs
          .filter((p) => p.userId === where.userId && where.type.in.includes(p.type) && p.status === "active" && p.expiresAt > now)
          .sort((a, b) => b.expiresAt - a.expiresAt);
        return rows[0] || null;
      },
      async createMany({ data }) { state.packs.push(...data); return { count: data.length }; }
    },
    adventClaim: {
      async create({ data }) {
        if (state.claims.some((c) => c.edition === data.edition && c.day === data.day && c.userId === data.userId)) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        const row = { ...data, createdAt: new Date() };
        state.claims.push(row);
        return row;
      },
      async findMany({ where }) {
        return state.claims.filter((c) => c.userId === where.userId && c.edition === where.edition);
      }
    },
    notification: { async create({ data }) { state.notifications.push(data); return data; } }
  };
  return db;
}

function mount(db) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes["GET " + path] = handlers[handlers.length - 1]; },
    post(path, ...handlers) { routes["POST " + path] = handlers[handlers.length - 1]; },
    bundleManager: { roleAssigned: 0, async assignDiscordRole() { this.roleAssigned++; } }
  };
  advent.load(app, db);
  return { routes, app };
}

const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const req = (body = {}, { ip = "203.0.113.7", headers = {} } = {}) => ({
  session: { userinfo: { id: "user-1" } },
  body,
  query: {},
  ip,
  headers: { "user-agent": UA_IPHONE, "accept-language": "fr-FR,fr;q=0.9", "cf-ipcountry": "FR", ...headers }
});
function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

(async () => {
  // Disabled calendar
  {
    setAdvent({ enabled: false });
    const { routes } = mount(createDb());
    const r = res();
    await routes["GET /api/advent/status"](req(), r);
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(advent.isAdventVisible(), false);
    console.log("PASS: Disabled calendar is hidden");
  }

  // Coins reward, idempotent opening, day checks
  {
    setAdvent({ chances: { coins: 100, resources: 0, bundle: 0 } });
    assert.strictEqual(advent.isAdventVisible(), true);
    const db = createDb();
    const { routes } = mount(db);

    const status = res();
    await routes["GET /api/advent/status"](req(), status);
    assert.strictEqual(status.statusCode, 200);
    assert.strictEqual(status.body.phase, "active");
    assert.strictEqual(status.body.currentDay, 2);
    assert.strictEqual(status.body.days.length, TOTAL_DAYS);
    assert.strictEqual(status.body.days[0].state, "missed");
    assert.strictEqual(status.body.days[1].state, "today");
    assert.strictEqual(status.body.days[2].state, "locked");

    const missed = res();
    await routes["POST /api/advent/open"](req({ day: 1 }), missed);
    assert.strictEqual(missed.statusCode, 400);
    assert.strictEqual(missed.body.code, "MISSED");

    const locked = res();
    await routes["POST /api/advent/open"](req({ day: 3 }), locked);
    assert.strictEqual(locked.body.code, "LOCKED");

    const open = res();
    await routes["POST /api/advent/open"](req({ day: 2 }), open);
    assert.strictEqual(open.statusCode, 200);
    assert.strictEqual(open.body.reward.kind, "coins");
    const won = db.state.users["user-1"].coins - 100;
    assert.ok(won >= 10 && won <= 20, `coins won out of range: ${won}`);
    assert.strictEqual(db.state.notifications.length, 1);

    // Audit row: who, what, from where
    assert.strictEqual(db.state.claims.length, 1);
    const claim = db.state.claims[0];
    assert.strictEqual(claim.userId, "user-1");
    assert.strictEqual(claim.username, "alice");
    assert.strictEqual(claim.day, 2);
    assert.strictEqual(claim.rewardKind, "coins");
    assert.strictEqual(claim.amount, won);
    assert.strictEqual(claim.coinsAfter, 100 + won);
    assert.strictEqual(claim.ipAddress, "203.0.113.7");
    assert.strictEqual(claim.ipSubnet, "203.0.113.7");
    assert.strictEqual(claim.country, "FR");
    assert.strictEqual(claim.browser, "Safari");
    assert.strictEqual(claim.os, "iOS");
    assert.strictEqual(claim.device, "mobile");
    assert.strictEqual(claim.language, "fr-FR");
    assert.strictEqual(claim.userAgent, UA_IPHONE);

    const again = res();
    await routes["POST /api/advent/open"](req({ day: 2 }), again);
    assert.strictEqual(again.statusCode, 409);
    assert.strictEqual(again.body.code, "ALREADY_OPENED");
    assert.strictEqual(db.state.users["user-1"].coins - 100, won, "second open must not pay twice");

    const after = res();
    await routes["GET /api/advent/status"](req(), after);
    assert.strictEqual(after.body.days[1].state, "opened");
    assert.strictEqual(after.body.days[1].reward.kind, "coins");
    console.log("PASS: Coins reward, one box per day, missed/locked days");
  }

  // Resource reward only uses enabled types
  {
    setAdvent({ chances: { coins: 0, resources: 100, bundle: 0 } });
    const db = createDb();
    const { routes } = mount(db);
    const r = res();
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
    await routes["POST /api/advent/open"](req({ day: 2 }, { ip: "2001:db8:abcd:12:1111:2222:3333:4444", headers: { "user-agent": ua, "cf-ipcountry": "XX" } }), r);
    assert.strictEqual(r.body.reward.kind, "resource");
    const claim = db.state.claims[0];
    assert.strictEqual(claim.rewardKind, "resource");
    assert.strictEqual(claim.rewardType, "ram");
    assert.strictEqual(claim.ipSubnet, "2001:db8:abcd:12::/64");
    assert.strictEqual(claim.country, null, "unknown Cloudflare country is not stored");
    assert.strictEqual(claim.browser, "Edge");
    assert.strictEqual(claim.os, "Windows");
    assert.strictEqual(claim.device, "desktop");
    const ram = db.state.users["user-1"].extraRam;
    assert.ok(ram >= 128 && ram <= 256, `ram out of range: ${ram}`);
    assert.strictEqual(db.state.users["user-1"].extraDisk, 0);
    console.log("PASS: Resource reward");
  }

  // God pack extends existing coverage, grants subsidiaries and Discord role
  {
    setAdvent({
      chances: { coins: 0, resources: 0, bundle: 100 },
      bundle: { god_pack: { enabled: true, chance: 100, min_days: 3, max_days: 3 } }
    });
    const db = createDb();
    const existing = new Date(Date.now() + 10 * DAY_MS);
    db.state.packs.push({ userId: "user-1", type: "god_pack", status: "active", expiresAt: existing, stripeSubscriptionId: "sub_1" });
    const { routes, app } = mount(db);
    const r = res();
    await routes["POST /api/advent/open"](req({ day: 2 }), r);
    assert.strictEqual(r.body.reward.kind, "bundle");
    const won = db.state.packs.filter((p) => p.source === "advent");
    assert.deepStrictEqual(won.map((p) => p.type).sort(), ["auto_renew", "god_pack", "upgraded_pack"]);
    for (const p of won) assert.strictEqual(p.expiresAt.getTime(), existing.getTime() + 3 * DAY_MS);
    assert.strictEqual(app.bundleManager.roleAssigned, 1);
    assert.strictEqual(db.state.claims[0].rewardType, "god_pack");
    assert.strictEqual(db.state.claims[0].bundleDays, 3);
    assert.strictEqual(db.state.claims[0].packExpiresAt.getTime(), existing.getTime() + 3 * DAY_MS);
    console.log("PASS: Bundle reward extends coverage");
  }

  // Empty box when nothing is configured
  {
    setAdvent({});
    const db = createDb();
    const { routes } = mount(db);
    const r = res();
    await routes["POST /api/advent/open"](req({ day: 2 }), r);
    assert.strictEqual(r.body.reward.kind, "empty");
    assert.strictEqual(db.state.notifications.length, 0);
    assert.strictEqual(db.state.transactions.length, 1, "empty boxes still count as opened");
    assert.strictEqual(db.state.claims[0].rewardKind, "empty");
    console.log("PASS: Empty box");
  }

  // Odds roughly follow the configured percentages
  {
    setAdvent({
      chances: { coins: 50, resources: 30, bundle: 10 },
      bundle: { auto_renew: { enabled: true, chance: 100, min_days: 1, max_days: 2 } }
    });
    const cfg = getAdventConfig();
    const counts = { coins: 0, resource: 0, bundle: 0, empty: 0 };
    const N = 20000;
    for (let i = 0; i < N; i++) counts[rollReward(cfg).kind]++;
    const near = (kind, pct) => assert.ok(Math.abs((counts[kind] / N) * 100 - pct) < 2, `${kind}: ${(counts[kind] / N) * 100}% vs ${pct}%`);
    near("coins", 50); near("resource", 30); near("bundle", 10); near("empty", 10);
    console.log("PASS: Reward distribution");
  }

  // Percentages above 100 are scaled down
  {
    setAdvent({ chances: { coins: 100, resources: 100, bundle: 0 } });
    const { chances } = getAdventConfig();
    assert.strictEqual(Math.round(chances.coins + chances.resources + chances.bundle), 100);
    console.log("PASS: Chances normalization");
  }

  console.log("All advent calendar tests passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
