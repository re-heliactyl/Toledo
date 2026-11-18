const crypto = require('crypto');
const axios = require('axios');
const loadConfig = require('../handlers/config.js');
const settings = loadConfig('./config.toml');
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');
const { createAuthRateLimit } = require('../handlers/rateLimit');
const { getClientIp, normalizeIp, getIpv6Subnet64 } = require('../handlers/antiVpnAllowlist');

const HeliactylModule = {
  "name": "Advent Calendar",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Seasonal advent calendar: one box per day with random coins, resources or bundles",
  "author": {
    "name": "Pandev22",
    "email": "matheus@overnode.fr",
    "url": "https://github.com/pandev22"
  },
  "dependencies": [], "permissions": [], "routes": [], "config": {}, "hooks": [],
  "tags": ['core', 'seasonal'], "license": "MIT"
};
module.exports.HeliactylModule = HeliactylModule;

const TOTAL_DAYS = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESOURCE_TYPES = {
  ram: { field: 'extraRam', label: (n) => `${n} MB RAM` },
  disk: { field: 'extraDisk', label: (n) => `${n} MB disk` },
  cpu: { field: 'extraCpu', label: (n) => `${n}% CPU` },
  servers: { field: 'extraServers', label: (n) => `${n} server slot${n > 1 ? 's' : ''}` }
};
const BUNDLE_TYPES = {
  auto_renew: 'Auto Renew',
  upgraded_pack: 'Upgraded Pack',
  god_pack: 'God Pack'
};

class AdventError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'AdventError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Parses "DD/MM/YYYY HH:mm" in the server's local time zone. */
function parseStart(value) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*$/.exec(String(value || ''));
  if (!m) return null;
  const [day, month, year, hour, minute] = m.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute;
  return valid ? { year, month, day, hour, minute } : null;
}

const toInt = (v, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const toPercent = (v) => Math.min(100, Math.max(0, Number(v) || 0));
const range = (section, minKey = 'min', maxKey = 'max') => {
  const a = toInt(section?.[minKey]);
  const b = toInt(section?.[maxKey]);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
};

let warnedChances = false;

function getAdventConfig() {
  const a = settings.advent || {};
  const start = parseStart(a.start);

  let coins = toPercent(a.chances?.coins);
  let resources = toPercent(a.chances?.resources);
  let bundle = toPercent(a.chances?.bundle);
  const total = coins + resources + bundle;
  if (total > 100) {
    if (!warnedChances) {
      console.warn(`[ADVENT] [advent.chances] add up to ${total}%, scaling them down to 100%`);
      warnedChances = true;
    }
    coins = (coins / total) * 100;
    resources = (resources / total) * 100;
    bundle = (bundle / total) * 100;
  }

  const resourceOptions = Object.keys(RESOURCE_TYPES)
    .map((type) => ({ type, enabled: a.resources?.[type]?.enabled !== false, ...range(a.resources?.[type]) }))
    .filter((r) => r.enabled && r.max > 0);

  const bundleOptions = Object.keys(BUNDLE_TYPES)
    .map((type) => {
      const b = a.bundle?.[type] || {};
      return { type, enabled: b.enabled === true, weight: toPercent(b.chance), ...range(b, 'min_days', 'max_days') };
    })
    .filter((b) => b.enabled && b.weight > 0 && b.max > 0);

  return {
    enabled: a.enabled === true,
    start,
    // Stable id for this edition, so a new start date starts a fresh calendar.
    key: start ? `${start.year}${String(start.month).padStart(2, '0')}${String(start.day).padStart(2, '0')}` : null,
    chances: { coins, resources, bundle },
    coins: range(a.coins),
    resourceOptions,
    bundleOptions,
    discord: {
      enabled: a.discord?.enabled !== false,
      webhook: String(a.discord?.webhook || settings.logging?.webhook || '').trim()
    }
  };
}

function isAdventVisible() {
  const cfg = getAdventConfig();
  return cfg.enabled && !!cfg.start;
}
module.exports.isAdventVisible = isAdventVisible;

// Day N unlocks at start + (N - 1) calendar days, in server local time (DST-safe).
function dayStart(start, day) {
  return new Date(start.year, start.month - 1, start.day + day - 1, start.hour, start.minute, 0, 0);
}

function getTimeline(start, now = new Date()) {
  const opensAt = dayStart(start, 1);
  const endsAt = dayStart(start, TOTAL_DAYS + 1);
  let currentDay = null;
  if (now >= opensAt && now < endsAt) {
    for (let d = TOTAL_DAYS; d >= 1; d--) {
      if (now >= dayStart(start, d)) { currentDay = d; break; }
    }
  }
  const phase = now < opensAt ? 'upcoming' : now >= endsAt ? 'ended' : 'active';
  const nextUnlockAt = phase === 'upcoming' ? opensAt : phase === 'active' && currentDay < TOTAL_DAYS ? dayStart(start, currentDay + 1) : null;
  return { opensAt, endsAt, currentDay, phase, nextUnlockAt };
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

const randomBetween = (min, max) => crypto.randomInt(min, max + 1);
// Uniform float in [0, 100) with 0.01% precision.
const rollPercent = () => crypto.randomInt(0, 10000) / 100;

function pickWeighted(options) {
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = (crypto.randomInt(0, 1_000_000) / 1_000_000) * total;
  for (const o of options) {
    roll -= o.weight;
    if (roll < 0) return o;
  }
  return options[options.length - 1];
}

/** Draws a reward. A category without any usable option falls through to an empty box. */
function rollReward(cfg) {
  const roll = rollPercent();
  const { coins, resources, bundle } = cfg.chances;

  if (roll < coins) {
    if (cfg.coins.max <= 0) return { kind: 'empty' };
    const amount = randomBetween(Math.max(1, cfg.coins.min), cfg.coins.max);
    return { kind: 'coins', amount, label: `${amount} coins` };
  }
  if (roll < coins + resources) {
    if (!cfg.resourceOptions.length) return { kind: 'empty' };
    const opt = cfg.resourceOptions[crypto.randomInt(0, cfg.resourceOptions.length)];
    const amount = randomBetween(Math.max(1, opt.min), opt.max);
    return { kind: 'resource', resource: opt.type, amount, label: RESOURCE_TYPES[opt.type].label(amount) };
  }
  if (roll < coins + resources + bundle) {
    if (!cfg.bundleOptions.length) return { kind: 'empty' };
    const opt = pickWeighted(cfg.bundleOptions);
    const days = randomBetween(Math.max(1, opt.min), opt.max);
    return { kind: 'bundle', bundle: opt.type, days, label: `${BUNDLE_TYPES[opt.type]} (${days} day${days > 1 ? 's' : ''})` };
  }
  return { kind: 'empty' };
}

/**
 * Grants a won bundle by extending the user's current coverage of that perk.
 * Uses separate `source: 'advent'` records so paid Stripe packs are never altered.
 */
async function grantBundle(tx, userId, type, days) {
  const now = new Date();
  const coveringTypes = type === 'god_pack' ? ['god_pack'] : [type, 'god_pack'];
  const current = await tx.userPack.findFirst({
    where: { userId, type: { in: coveringTypes }, status: 'active', expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
    select: { expiresAt: true }
  });
  const base = current ? current.expiresAt : now;
  const expiresAt = new Date(base.getTime() + days * DAY_MS);

  const types = type === 'god_pack' ? ['god_pack', 'auto_renew', 'upgraded_pack'] : [type];
  await tx.userPack.createMany({
    data: types.map((t) => ({ userId, type: t, status: 'active', source: 'advent', expiresAt }))
  });
  return expiresAt;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function announceReward(cfg, user, day, reward) {
  if (!cfg.discord.enabled || !cfg.discord.webhook || reward.kind === 'empty') return;
  const who = user.discordId ? `<@${user.discordId}> (${user.username})` : `**${user.username}**`;
  axios.post(cfg.discord.webhook, {
    allowed_mentions: { parse: [] },
    embeds: [{
      color: 0xFFFFFF,
      title: `Advent Calendar · Day ${day}`,
      description: `${who} opened day ${day} and won **${reward.label}**`,
      author: { name: settings.website?.name || 'Heliactyl' },
      thumbnail: settings.website?.logo ? { url: settings.website.logo } : undefined,
      timestamp: new Date().toISOString()
    }]
  }).catch((err) => console.error('[ADVENT] Discord webhook failed:', err.response?.status || err.message));
}

// ---------------------------------------------------------------------------
// Request context (stored with each claim for auditing)
// ---------------------------------------------------------------------------

function parseUserAgent(ua) {
  const lower = String(ua || '').toLowerCase();
  if (!lower) return { browser: null, os: null, device: null };

  let browser = 'Other';
  if (lower.includes('crios/')) browser = 'Chrome';
  else if (lower.includes('fxios/') || lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('edg/') || lower.includes('edga/') || lower.includes('edgios/')) browser = 'Edge';
  else if (lower.includes('opr/') || lower.includes('opera/')) browser = 'Opera';
  else if (lower.includes('samsungbrowser/')) browser = 'Samsung Internet';
  else if (lower.includes('chrome/')) browser = 'Chrome';
  else if (lower.includes('safari/')) browser = 'Safari';
  else if (lower.includes('overnode') || lower.includes('electron/') || lower.includes('tauri')) browser = 'Desktop app';

  let os = 'Other';
  if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ipod')) os = 'iOS';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('mac os x') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('cros')) os = 'ChromeOS';
  else if (lower.includes('linux')) os = 'Linux';

  let device = 'desktop';
  if (lower.includes('ipad') || lower.includes('tablet') || (lower.includes('android') && !lower.includes('mobile'))) device = 'tablet';
  else if (lower.includes('mobile') || lower.includes('iphone') || lower.includes('ipod')) device = 'mobile';

  return { browser, os, device };
}

function getRequestContext(req) {
  const ipAddress = normalizeIp(getClientIp(req)) || null;
  let ipSubnet = ipAddress;
  if (ipAddress && ipAddress.includes(':')) {
    const subnet = getIpv6Subnet64(ipAddress);
    ipSubnet = subnet ? `${subnet.compressedPrefix || `${subnet.shortPrefix}:`}/64` : ipAddress;
  }
  const country = String(req.headers['cf-ipcountry'] || '').trim().toUpperCase();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 1024) || null;
  const language = String(req.headers['accept-language'] || '').split(',')[0].trim().slice(0, 64) || null;
  return {
    ipAddress,
    ipSubnet,
    country: /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null,
    userAgent,
    language,
    ...parseUserAgent(userAgent)
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const claimId = (cfg, day, userId) => `advent:${cfg.key}:${day}:${userId}`;

module.exports.load = function (app, db) {
  const authz = createAuthz(db);
  const openRateLimit = createAuthRateLimit({ windowMs: 60 * 1000, limit: 10 });

  const requireCalendar = () => {
    const cfg = getAdventConfig();
    if (!cfg.enabled) throw new AdventError('The advent calendar is not available', 'DISABLED', 404);
    if (!cfg.start) throw new AdventError('The advent calendar start date is invalid', 'MISCONFIGURED', 503);
    return cfg;
  };

  const sendError = (res, err, tag) => {
    if (err.name === 'AdventError') return res.status(err.status).json({ error: err.message, code: err.code });
    console.error(`[ADVENT] ${tag}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  };

  app.get('/api/advent/status', validate(schemas.emptyPayload, 'query'), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const cfg = requireCalendar();
      const userId = authz.getSessionUser(req).id;
      const now = new Date();
      const timeline = getTimeline(cfg.start, now);

      const claims = await db.adventClaim.findMany({
        where: { userId, edition: cfg.key },
        select: { day: true, rewardKind: true, label: true, createdAt: true }
      });
      const opened = new Map(claims.map((c) => [c.day, { kind: c.rewardKind, label: c.label, openedAt: c.createdAt.toISOString() }]));

      const days = [];
      for (let d = 1; d <= TOTAL_DAYS; d++) {
        const reward = opened.get(d);
        let state = 'locked';
        if (reward) state = 'opened';
        else if (timeline.currentDay === d) state = 'today';
        else if (now >= dayStart(cfg.start, d + 1)) state = 'missed';
        days.push({ day: d, unlocksAt: dayStart(cfg.start, d).toISOString(), state, reward: reward || null });
      }

      res.json({
        phase: timeline.phase,
        currentDay: timeline.currentDay,
        totalDays: TOTAL_DAYS,
        serverTime: now.toISOString(),
        opensAt: timeline.opensAt.toISOString(),
        endsAt: timeline.endsAt.toISOString(),
        nextUnlockAt: timeline.nextUnlockAt ? timeline.nextUnlockAt.toISOString() : null,
        days
      });
    } catch (err) {
      sendError(res, err, 'Status error');
    }
  });

  app.post('/api/advent/open', openRateLimit, validate(schemas.adventOpen), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const cfg = requireCalendar();
      const userId = authz.getSessionUser(req).id;
      const day = Number(req.body.day);
      const { currentDay, phase } = getTimeline(cfg.start);

      if (phase === 'upcoming' || (currentDay !== null && day > currentDay)) {
        throw new AdventError('This box is not unlocked yet', 'LOCKED');
      }
      if (phase === 'ended' || day !== currentDay) {
        throw new AdventError('This box can no longer be opened', 'MISSED');
      }

      const account = await db.user.findUnique({ where: { id: userId }, select: { username: true, discordId: true } });
      if (!account) return res.status(401).json({ error: 'Unauthorized' });
      const context = getRequestContext(req);
      const reward = rollReward(cfg);
      let expiresAt = null;
      let coinsAfter = null;

      try {
        await db.$transaction(async (tx) => {
          // The unique externalId makes opening a box idempotent, even under concurrent requests.
          await tx.transaction.create({
            data: {
              userId,
              type: 'advent_reward',
              amount: reward.kind === 'coins' ? reward.amount : 0,
              description: reward.kind === 'empty' ? `Advent calendar · Day ${day}: empty box` : `Advent calendar · Day ${day}: ${reward.label}`,
              details: JSON.stringify({ ...reward, day, edition: cfg.key }),
              externalId: claimId(cfg, day, userId)
            }
          });

          if (reward.kind === 'coins') {
            await tx.user.update({ where: { id: userId }, data: { coins: { increment: reward.amount } } });
          } else if (reward.kind === 'resource') {
            await tx.user.update({ where: { id: userId }, data: { [RESOURCE_TYPES[reward.resource].field]: { increment: reward.amount } } });
          } else if (reward.kind === 'bundle') {
            expiresAt = await grantBundle(tx, userId, reward.bundle, reward.days);
          }

          coinsAfter = (await tx.user.findUnique({ where: { id: userId }, select: { coins: true } }))?.coins ?? null;

          // Audit trail: what was won, by whom, and from where. Unique per edition/day/user.
          await tx.adventClaim.create({
            data: {
              userId,
              username: account.username,
              discordId: account.discordId || null,
              edition: cfg.key,
              day,
              rewardKind: reward.kind,
              rewardType: reward.resource || reward.bundle || null,
              amount: reward.amount || 0,
              bundleDays: reward.days || null,
              label: reward.label || null,
              packExpiresAt: expiresAt,
              coinsAfter,
              ...context
            }
          });
        });
      } catch (err) {
        if (err?.code === 'P2002') throw new AdventError('You already opened this box', 'ALREADY_OPENED', 409);
        throw err;
      }

      if (reward.kind === 'bundle' && reward.bundle === 'god_pack') {
        try { await app.bundleManager?.assignDiscordRole(userId); } catch { /* role sync is best effort */ }
      }

      if (reward.kind !== 'empty') {
        db.notification.create({ data: { userId, action: 'advent:reward', name: `Advent calendar day ${day}: ${reward.label}` } }).catch(() => {});
        announceReward(cfg, account, day, reward);
      }

      res.json({
        success: true,
        day,
        reward: { kind: reward.kind, label: reward.label || null, expiresAt: expiresAt ? expiresAt.toISOString() : null },
        coins: coinsAfter
      });
    } catch (err) {
      sendError(res, err, 'Open error');
    }
  });
};

// Exposed for tests/advent-calendar.test.js
module.exports._internal = { parseStart, getTimeline, rollReward, getAdventConfig, parseUserAgent, TOTAL_DAYS };
