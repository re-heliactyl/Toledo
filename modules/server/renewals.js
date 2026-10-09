const express = require("express");
const axios = require("axios");
const loadConfig = require("../../handlers/config");
const cache = require("../../handlers/cache");
const { isAuthenticated, ownsServer, isServerOwner, PANEL_URL, API_KEY, ADMIN_KEY } = require("./core.js");
const { removeServerSubdomains } = require("./subdomains.js");

const settings = loadConfig("./config.toml");

const HeliactylModule = {
  name: "Server -> Renewals",
  version: "1.1.0",
  api_level: 4,
  target_platform: "10.0.0",
  description: "Configurable server renewal and expiration management",
  author: {
    name: "aachul123",
    email: "ludo@overnode.fr",
    url: "https://achul123.pages.dev/"
  },
  dependencies: [],
  permissions: [],
  routes: [],
  config: {},
  hooks: [],
  tags: ["core"],
  license: "MIT"
};

const RENEWAL_KEY_PREFIX = "server-renewal:";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_SYNC_INTERVAL_MS = 12 * HOUR_MS;

let maintenanceDb = null;
let renewalTicker = null;
let maintenanceRunning = false;
let lastCheckAt = 0;
let lastSyncAt = 0;

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function getRenewalConfig() {
  const renewal = settings.renewal || {};

  return {
    enabled: renewal.enabled ?? true,
    renewalPeriodDays: toPositiveInt(renewal.renewal_period_days, 2),
    renewalWindowHours: toPositiveInt(renewal.renewal_window_hours, 24),
    checkIntervalMinutes: toPositiveInt(renewal.check_interval_minutes, 5),
    autoDeleteEnabled: renewal.auto_delete_enabled ?? true,
    autoDeleteAfterDays: toPositiveInt(renewal.auto_delete_after_days, 7),
    apiDelayMs: toNonNegativeInt(renewal.api_delay_ms, 1000)
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidDateString(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function stripLegacyBypassFields(record) {
  const nextRecord = { ...record };
  let changed = false;

  for (const key of Object.keys(nextRecord)) {
    if (key.toLowerCase().includes("bypass")) {
      delete nextRecord[key];
      changed = true;
    }
  }

  return { record: nextRecord, changed };
}

function formatDuration(ms) {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    totalMs: safeMs,
    totalSeconds,
    days,
    hours,
    minutes,
    seconds
  };
}

function parseRenewalRow(row) {
  try {
    return JSON.parse(row.value);
  } catch (error) {
    console.error(`[Renewal] Failed to parse record ${row.key}:`, error.message);
    return null;
  }
}

function formatRenewalRecord(row) {
  if (!row) return null;
  const expiresIso = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : (row.expiresAt ? new Date(row.expiresAt).toISOString() : null);
  const lastRenewedIso = row.lastRenewedAt instanceof Date ? row.lastRenewedAt.toISOString() : (row.lastRenewedAt ? new Date(row.lastRenewedAt).toISOString() : null);
  const expiredIso = row.expiredAt instanceof Date ? row.expiredAt.toISOString() : (row.expiredAt ? new Date(row.expiredAt).toISOString() : null);
  const lastAutoRenewedIso = row.lastAutoRenewedAt instanceof Date ? row.lastAutoRenewedAt.toISOString() : (row.lastAutoRenewedAt ? new Date(row.lastAutoRenewedAt).toISOString() : null);

  return {
    id: row.id,
    serverId: row.serverId,
    serverIdentifier: row.serverId,
    panelId: row.panelId ?? null,
    userId: row.userId ?? null,
    expiresAt: expiresIso,
    nextRenewalAt: expiresIso,
    lastRenewedAt: lastRenewedIso,
    expiredAt: expiredIso,
    lastAutoRenewedAt: lastAutoRenewedIso,
    isActive: row.isActive ?? true,
    renewalCount: row.renewalCount ?? 0,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ? new Date(row.createdAt).toISOString() : null),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ? new Date(row.updatedAt).toISOString() : null)
  };
}

async function writeRenewalRecord(db, identifier, data) {
  let validUserId = undefined;
  if (data.userId !== undefined) {
    if (data.userId) {
      const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true } }).catch(() => null);
      validUserId = user ? user.id : null;
    } else {
      validUserId = null;
    }
  }

  const expiresAtRaw = data.nextRenewalAt !== undefined ? data.nextRenewalAt : data.expiresAt;
  let parsedExpiresAt = undefined;
  if (expiresAtRaw !== undefined) {
    if (expiresAtRaw) {
      const d = new Date(expiresAtRaw);
      parsedExpiresAt = isNaN(d.getTime()) ? new Date() : d;
    } else {
      parsedExpiresAt = new Date();
    }
  }

  let parsedLastRenewedAt = undefined;
  if (data.lastRenewedAt !== undefined) {
    if (data.lastRenewedAt) {
      const d = new Date(data.lastRenewedAt);
      parsedLastRenewedAt = isNaN(d.getTime()) ? null : d;
    } else {
      parsedLastRenewedAt = null;
    }
  }

  let parsedExpiredAt = undefined;
  if (data.expiredAt !== undefined) {
    if (data.expiredAt) {
      const d = new Date(data.expiredAt);
      parsedExpiredAt = isNaN(d.getTime()) ? null : d;
    } else {
      parsedExpiredAt = null;
    }
  }

  let parsedLastAutoRenewedAt = undefined;
  if (data.lastAutoRenewedAt !== undefined) {
    if (data.lastAutoRenewedAt) {
      const d = new Date(data.lastAutoRenewedAt);
      parsedLastAutoRenewedAt = isNaN(d.getTime()) ? null : d;
    } else {
      parsedLastAutoRenewedAt = null;
    }
  }

  let parsedRenewalCount = undefined;
  if (data.renewalCount !== undefined) {
    parsedRenewalCount = toNonNegativeInt(data.renewalCount, 0);
  }

  let parsedIsActive = undefined;
  if (data.isActive !== undefined) {
    parsedIsActive = Boolean(data.isActive);
  }

  const row = await db.serverRenewal.upsert({
    where: { serverId: identifier },
    update: {
      panelId: data.panelId !== undefined ? (data.panelId !== null ? Number(data.panelId) : null) : undefined,
      userId: validUserId !== undefined ? validUserId : undefined,
      expiresAt: parsedExpiresAt !== undefined ? parsedExpiresAt : undefined,
      lastRenewedAt: parsedLastRenewedAt !== undefined ? parsedLastRenewedAt : undefined,
      renewalCount: parsedRenewalCount !== undefined ? parsedRenewalCount : undefined,
      isActive: parsedIsActive !== undefined ? parsedIsActive : undefined,
      expiredAt: parsedExpiredAt !== undefined ? parsedExpiredAt : undefined,
      lastAutoRenewedAt: parsedLastAutoRenewedAt !== undefined ? parsedLastAutoRenewedAt : undefined
    },
    create: {
      serverId: identifier,
      panelId: data.panelId !== undefined && data.panelId !== null ? Number(data.panelId) : null,
      userId: validUserId !== undefined ? validUserId : null,
      expiresAt: parsedExpiresAt !== undefined ? parsedExpiresAt : new Date(),
      lastRenewedAt: parsedLastRenewedAt !== undefined ? parsedLastRenewedAt : null,
      renewalCount: parsedRenewalCount !== undefined ? parsedRenewalCount : 0,
      isActive: parsedIsActive !== undefined ? parsedIsActive : true,
      expiredAt: parsedExpiredAt !== undefined ? parsedExpiredAt : null,
      lastAutoRenewedAt: parsedLastAutoRenewedAt !== undefined ? parsedLastAutoRenewedAt : null
    }
  });

  return formatRenewalRecord(row);
}

async function readRenewalRecord(db, identifier) {
  if (!identifier) {
    return null;
  }

  const row = await db.serverRenewal.findUnique({
    where: { serverId: identifier }
  });

  return formatRenewalRecord(row);
}

async function readAllRenewalRecords(db) {
  const rows = await db.serverRenewal.findMany({
    orderBy: { expiresAt: "asc" }
  });

  return rows.map(formatRenewalRecord);
}

async function removeRenewalRecordByIdentifier(db, identifier) {
  if (!identifier) {
    return false;
  }

  await db.serverRenewal.delete({ where: { serverId: identifier } }).catch(() => null);
  return true;
}

function buildRenewalDates(config, now) {
  return {
    lastRenewedAt: now.toISOString(),
    nextRenewalAt: new Date(now.getTime() + config.renewalPeriodDays * DAY_MS).toISOString()
  };
}

function createRenewalRecord(serverAttributes, userId, config) {
  const now = new Date();
  const renewalDates = buildRenewalDates(config, now);

  return {
    serverIdentifier: serverAttributes.identifier,
    panelId: serverAttributes.id ?? null,
    userId: userId ?? null,
    lastRenewedAt: renewalDates.lastRenewedAt,
    nextRenewalAt: renewalDates.nextRenewalAt,
    expiredAt: null,
    isActive: true,
    renewalCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

async function initializeServerRenewal(db, serverAttributes, userId = null, options = {}) {
  if (!serverAttributes?.identifier) {
    return null;
  }

  const config = getRenewalConfig();
  const existing = await readRenewalRecord(db, serverAttributes.identifier);

  if (!existing) {
    if (options.allowCreate === false) {
      return null;
    }

    const record = createRenewalRecord(serverAttributes, userId, config);
    return writeRenewalRecord(db, serverAttributes.identifier, record);
  }

  const sanitizedExisting = stripLegacyBypassFields(existing);
  const nextRecord = {
    ...sanitizedExisting.record,
    serverIdentifier: serverAttributes.identifier,
    panelId: serverAttributes.id ?? sanitizedExisting.record.panelId ?? null,
    userId: userId ?? sanitizedExisting.record.userId ?? null
  };

  let changed = sanitizedExisting.changed;

  if (!existing.serverIdentifier || existing.serverIdentifier !== serverAttributes.identifier) {
    changed = true;
  }

  if (serverAttributes.id !== undefined && (serverAttributes.id ?? null) !== (sanitizedExisting.record.panelId ?? null)) {
    changed = true;
  }

  if (userId !== null && userId !== undefined && userId !== (sanitizedExisting.record.userId ?? null)) {
    changed = true;
  }

  if (!isValidDateString(nextRecord.lastRenewedAt)) {
    nextRecord.lastRenewedAt = new Date().toISOString();
    changed = true;
  }

  if (!isValidDateString(nextRecord.nextRenewalAt)) {
    const renewalDates = buildRenewalDates(config, new Date());
    nextRecord.lastRenewedAt = renewalDates.lastRenewedAt;
    nextRecord.nextRenewalAt = renewalDates.nextRenewalAt;
    nextRecord.expiredAt = null;
    nextRecord.isActive = true;
    changed = true;
  }

  return changed ? writeRenewalRecord(db, serverAttributes.identifier, nextRecord) : existing;
}

async function removeServerRenewal(db, serverDetails = {}) {
  const identifier = serverDetails.identifier || serverDetails.serverId;
  if (identifier) {
    return removeRenewalRecordByIdentifier(db, identifier);
  }

  if (!serverDetails.panelId) {
    return false;
  }

  const panelIdNum = Number(serverDetails.panelId);
  if (!Number.isInteger(panelIdNum)) {
    return false;
  }

  await db.serverRenewal.deleteMany({
    where: { panelId: panelIdNum }
  }).catch(() => null);

  return true;
}

async function getRenewalRecord(db, identifier, fallbackUserId = null) {
  let record = await readRenewalRecord(db, identifier);

  if (!record) {
    return null;
  }

  return initializeServerRenewal(db, {
    identifier: record.serverIdentifier,
    id: record.panelId
  }, fallbackUserId ?? record.userId, { allowCreate: false });
}

function getDeletionDate(record, config) {
  if (!config.autoDeleteEnabled || !record.nextRenewalAt) {
    return null;
  }

  const baseDate = isValidDateString(record.expiredAt)
    ? new Date(record.expiredAt)
    : new Date(record.nextRenewalAt);

  return new Date(baseDate.getTime() + config.autoDeleteAfterDays * DAY_MS);
}

function buildStatusResponse(record) {
  const config = getRenewalConfig();
  const now = Date.now();
  const cleanRecord = stripLegacyBypassFields(record).record;
  const nextRenewalMs = record.nextRenewalAt ? new Date(record.nextRenewalAt).getTime() : null;
  const expiresInMs = nextRenewalMs === null ? null : nextRenewalMs - now;
  const deletionDate = getDeletionDate(record, config);
  const deletionMs = deletionDate ? deletionDate.getTime() - now : null;

  return {
    ...cleanRecord,
    isUnlimited: false,
    requiresRenewal: Boolean(config.enabled && expiresInMs !== null && expiresInMs <= config.renewalWindowHours * HOUR_MS),
    canRenew: Boolean(config.enabled && expiresInMs !== null && expiresInMs <= config.renewalWindowHours * HOUR_MS),
    isExpired: Boolean(expiresInMs !== null && expiresInMs <= 0),
    timeRemaining: expiresInMs === null ? null : formatDuration(Math.max(expiresInMs, 0)),
    overdue: expiresInMs === null ? null : formatDuration(Math.max(-expiresInMs, 0)),
    autoDeleteAt: deletionDate ? deletionDate.toISOString() : null,
    autoDeleteIn: deletionMs === null ? null : formatDuration(Math.max(deletionMs, 0)),
    config: {
      enabled: config.enabled,
      renewalPeriodDays: config.renewalPeriodDays,
      renewalWindowHours: config.renewalWindowHours,
      autoDeleteEnabled: config.autoDeleteEnabled,
      autoDeleteAfterDays: config.autoDeleteAfterDays,
      checkIntervalMinutes: config.checkIntervalMinutes
    }
  };
}

async function stopServer(serverIdentifier) {
  await axios.post(
    `${PANEL_URL}/api/client/servers/${serverIdentifier}/power`,
    { signal: "stop" },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    }
  );
}

async function startServer(serverIdentifier) {
  await axios.post(
    `${PANEL_URL}/api/client/servers/${serverIdentifier}/power`,
    { signal: "start" },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    }
  );
}

async function deleteServer(panelId) {
  await axios.delete(`${PANEL_URL}/api/application/servers/${panelId}/force`, {
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      Accept: "application/json"
    }
  });
}

async function fetchAllPanelServers() {
  const servers = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await axios.get(`${PANEL_URL}/api/application/servers`, {
      params: {
        page,
        per_page: 100
      },
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        Accept: "application/json"
      }
    });

    servers.push(...response.data.data);
    totalPages = response.data.meta?.pagination?.total_pages || 1;
    page += 1;
  } while (page <= totalPages);

  return servers;
}

async function syncRenewalRecords(db) {
  const panelServers = await fetchAllPanelServers();
  const panelServerMap = new Map();
  const pterodactylIds = [...new Set(
    panelServers
      .map((server) => server.attributes?.user)
      .filter((value) => Number.isInteger(value))
  )];

  const users = pterodactylIds.length > 0
    ? await db.user.findMany({
      where: {
        pterodactylId: {
          in: pterodactylIds
        }
      },
      select: {
        id: true,
        pterodactylId: true
      }
    })
    : [];

  const userMap = new Map(users.map((user) => [user.pterodactylId, user]));

  for (const server of panelServers) {
    const attributes = server.attributes;
    if (!attributes?.identifier) {
      continue;
    }

    panelServerMap.set(attributes.identifier, attributes);
  }

  const records = await readAllRenewalRecords(db);
  for (const record of records) {
    if (!record?.serverIdentifier) {
      continue;
    }

    const attributes = panelServerMap.get(record.serverIdentifier);
    if (!attributes) {
      await removeRenewalRecordByIdentifier(db, record.serverIdentifier);
      continue;
    }

    const owner = userMap.get(attributes.user);
    await initializeServerRenewal(db, attributes, owner?.id ?? null, { allowCreate: false });
  }
}

async function handleExpiredRecord(db, record, config) {
  if (!record.serverIdentifier || !record.nextRenewalAt) {
    return;
  }

  const now = new Date();
  const nextRenewalAt = new Date(record.nextRenewalAt);
  if (nextRenewalAt.getTime() > now.getTime()) {
    return;
  }

  const expiredAt = isValidDateString(record.expiredAt) ? new Date(record.expiredAt) : nextRenewalAt;
  const expiredForMs = now.getTime() - expiredAt.getTime();

  if (config.autoDeleteEnabled && expiredForMs >= config.autoDeleteAfterDays * DAY_MS) {
    if (record.panelId) {
      try {
        await deleteServer(record.panelId);
      } catch (error) {
        if (error.response?.status !== 404) {
          throw error;
        }
      }
    }

    try {
      await removeServerSubdomains(db, record.serverIdentifier);
    } catch (subdomainError) {
      console.error('Failed to remove server subdomains during renewal expiry:', subdomainError);
    }

    try {
      await db.subuserServer.deleteMany({
        where: { serverId: record.serverIdentifier }
      });
    } catch (subuserError) {
      console.error('Failed to remove server subusers during renewal expiry:', subuserError);
    }

    await removeServerRenewal(db, {
      identifier: record.serverIdentifier,
      panelId: record.panelId
    });

    if (record.userId) {
      await cache.del(`ptero:user:${record.userId}:servers`);
    }

    return;
  }

  if (record.isActive === false) {
    return;
  }

  // ── Auto-renew check ──────────────────────────────────
  // If the user has an active auto_renew subscription, extend the server
  // instead of stopping it.
  if (record.userId) {
    try {
      const hasAutoRenew = await db.userPack.findFirst({
        where: {
          userId: record.userId,
          type: { in: ['auto_renew', 'god_pack'] },
          status: 'active',
          expiresAt: { gt: new Date() }
        }
      });

      if (hasAutoRenew) {
        // Automatically extend renewal
        const renewalDates = buildRenewalDates(config, new Date());
        const updatedRecord = await writeRenewalRecord(db, record.serverIdentifier, {
          ...record,
          lastRenewedAt: renewalDates.lastRenewedAt,
          nextRenewalAt: renewalDates.nextRenewalAt,
          expiresAt: renewalDates.nextRenewalAt,
          expiredAt: null,
          isActive: true,
          renewalCount: (record.renewalCount || 0) + 1,
          lastAutoRenewedAt: new Date().toISOString()
        });

        // Restart server if it was off
        if (record.isActive === false) {
          try {
            await startServer(record.serverIdentifier);
          } catch (err) {
            console.error(`[Renewal] Failed to restart auto-renewed server ${record.serverIdentifier}:`, err.message);
          }
        }

        if (record.userId) {
          await cache.del(`ptero:user:${record.userId}:servers`);
        }

        console.log(`[Renewal] Auto-renewed server ${record.serverIdentifier} for user ${record.userId}`);
        return;
      }
    } catch (err) {
      console.error(`[Renewal] Error checking auto-renew for ${record.serverIdentifier}:`, err.message);
      // Fall through to normal expiration logic
    }
  }
  // ── End auto-renew check ──────────────────────────────

  try {
    await stopServer(record.serverIdentifier);
  } catch (error) {
    const status = error?.response?.status ?? null;

    if (status === 404) {
      await removeServerRenewal(db, {
        identifier: record.serverIdentifier,
        panelId: record.panelId
      });
      return;
    }

    if (status !== 409) {
      throw error;
    }

    console.warn(`[Renewal] Server ${record.serverIdentifier} was already stopped or busy during expiration handling.`);
  }

  await writeRenewalRecord(db, record.serverIdentifier, {
    ...record,
    expiredAt: expiredAt.toISOString(),
    isActive: false
  });
}

async function runRenewalMaintenance() {
  if (!maintenanceDb || maintenanceRunning) {
    return;
  }

  const config = getRenewalConfig();
  if (!config.enabled) {
    return;
  }

  const now = Date.now();
  if (now - lastCheckAt < config.checkIntervalMinutes * 60 * 1000) {
    return;
  }

  maintenanceRunning = true;
  lastCheckAt = now;

  try {
    if (now - lastSyncAt >= DEFAULT_SYNC_INTERVAL_MS) {
      await syncRenewalRecords(maintenanceDb);
      lastSyncAt = Date.now();
    }

    const records = await readAllRenewalRecords(maintenanceDb);
    for (const record of records) {
      const refreshedRecord = await initializeServerRenewal(maintenanceDb, {
        identifier: record.serverIdentifier,
        id: record.panelId
      }, record.userId, { allowCreate: false });

      if (!refreshedRecord) {
        continue;
      }

      await handleExpiredRecord(maintenanceDb, refreshedRecord, config);

      if (config.apiDelayMs > 0) {
        await delay(config.apiDelayMs);
      }
    }
  } catch (error) {
    console.error("[Renewal] Maintenance failed:", error);
  } finally {
    maintenanceRunning = false;
  }
}

async function migrateLegacyRenewalRecords(db) {
  try {
    const rows = await db.heliactyl.findMany({
      where: {
        key: {
          startsWith: RENEWAL_KEY_PREFIX
        }
      }
    });

    if (!rows || rows.length === 0) {
      return;
    }

    console.log(`[Renewal] Migrating ${rows.length} legacy renewal records to ServerRenewal model...`);

    for (const row of rows) {
      try {
        const parsed = parseRenewalRow(row);
        const identifier = parsed?.serverIdentifier || row.key.replace(RENEWAL_KEY_PREFIX, "");

        if (identifier) {
          await writeRenewalRecord(db, identifier, parsed || {});
        }

        await db.heliactyl.delete({ where: { key: row.key } }).catch(() => null);
      } catch (rowErr) {
        console.error(`[Renewal] Failed to migrate legacy record ${row.key}:`, rowErr.message);
      }
    }

    console.log("[Renewal] Legacy renewal migration completed.");
  } catch (err) {
    console.error("[Renewal] Failed to migrate legacy renewal records:", err.message);
  }
}

module.exports.HeliactylModule = HeliactylModule;
module.exports.initializeServerRenewal = initializeServerRenewal;
module.exports.removeServerRenewal = removeServerRenewal;
module.exports.writeRenewalRecord = writeRenewalRecord;
module.exports.readRenewalRecord = readRenewalRecord;

module.exports.load = async function (app, db) {
  maintenanceDb = db;

  await migrateLegacyRenewalRecords(db);

  const router = express.Router();

  router.get("/server/:id/renewal/status", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const record = await getRenewalRecord(db, req.params.id);

      if (!record) {
        return res.status(404).json({ error: "Renewal data not found" });
      }

      res.json(buildStatusResponse(record));
    } catch (error) {
      console.error("[Renewal] Failed to get status:", error);
      res.status(500).json({ error: "Failed to get renewal status" });
    }
  });

  router.post("/server/:id/renewal/renew", isAuthenticated, isServerOwner, async (req, res) => {
    try {
      const config = getRenewalConfig();
      if (!config.enabled) {
        return res.status(400).json({ error: "Renewal system is disabled" });
      }

      const currentRecord = await getRenewalRecord(db, req.params.id);
      if (!currentRecord) {
        return res.status(404).json({ error: "Renewal data not found" });
      }

      const now = new Date();
      const nextRenewalAt = new Date(currentRecord.nextRenewalAt);
      const renewWindowMs = config.renewalWindowHours * HOUR_MS;
      const remainingMs = nextRenewalAt.getTime() - now.getTime();

      if (remainingMs > renewWindowMs) {
        return res.status(400).json({
          error: "Renewal not available yet",
          availableIn: formatDuration(remainingMs - renewWindowMs),
          renewalData: buildStatusResponse(currentRecord)
        });
      }

      const renewalDates = buildRenewalDates(config, now);
      const updatedRecord = await writeRenewalRecord(db, currentRecord.serverIdentifier, {
        ...currentRecord,
        lastRenewedAt: renewalDates.lastRenewedAt,
        nextRenewalAt: renewalDates.nextRenewalAt,
        expiresAt: renewalDates.nextRenewalAt,
        expiredAt: null,
        isActive: true,
        renewalCount: (currentRecord.renewalCount || 0) + 1
      });

      let restarted = false;
      if (currentRecord.isActive === false) {
        try {
          await startServer(currentRecord.serverIdentifier);
          restarted = true;
        } catch (error) {
          console.error("[Renewal] Failed to restart renewed server:", error.message);
        }
      }

      if (currentRecord.userId) {
        await cache.del(`ptero:user:${currentRecord.userId}:servers`);
      }

      res.json({
        message: "Server renewed successfully",
        restarted,
        renewalData: buildStatusResponse(updatedRecord)
      });
    } catch (error) {
      console.error("[Renewal] Failed to renew server:", error);
      res.status(500).json({ error: "Failed to renew server" });
    }
  });

  app.use("/api", router);

  if (!renewalTicker) {
    setTimeout(() => {
      runRenewalMaintenance().catch((error) => {
        console.error("[Renewal] Initial maintenance failed:", error);
      });
    }, 10_000);

    renewalTicker = setInterval(() => {
      runRenewalMaintenance().catch((error) => {
        console.error("[Renewal] Scheduled maintenance failed:", error);
      });
    }, 60 * 1000);
  }
};
