const loadConfig = require("../handlers/config");
const settings = loadConfig("./config.toml");
const getPteroUser = require("../handlers/getPteroUser");
const cache = require("../handlers/cache");
const axios = require("axios");
const LRU = require("lru-cache");
const createAuthz = require('../handlers/authz');
const log = require("../handlers/log.js");
const { suspend: suspendIfNeeded } = require("./admin.js");

const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

const settingsCache = new LRU({
  max: 1,
  ttl: 1000 * 30 // 30s
});

function getPublicSettings() {
  const cached = settingsCache.get('public');
  if (cached) return cached;

  const payload = {
    name: settings.website.name || "Heliactyl",
    logo: settings.website.logo || "https://i.imgur.com/gUUze6A.png",
    domain: settings.website.domain,
    pterodactyl: settings.pterodactyl.domain,
    features: {
      coinTransfer: settings.api?.client?.coins?.transfer?.enabled ?? true,
      boosts: settings.api?.client?.coins?.boosts?.enabled ?? true,
    }
  };
  settingsCache.set('public', payload);
  return payload;
}

const HeliactylModule = {
  "name": "API v5",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

/* Module */
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);

  app.get('/api/v5/state', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) {
        return res.status(401).json({
          authenticated: false,
          message: 'Not authenticated'
        });
      }

      // Check if 2FA verification is pending
      const twoFactorPending = !!req.session.twoFactorPending;

      // Get user data
      const userData = authz.getSessionUser(req);
      const userId = userData.id;

      // Get 2FA status
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          twoFactorEnabled: true,
          isBanned: true,
          banReason: true,
          bannedAt: true,
          bannedByUserId: true,
          bannedByUsername: true,
        }
      });
      const twoFactorEnabled = user?.twoFactorEnabled || false;
      const banned = user?.isBanned === true;
      const userPerms = await authz.getUserPermissions(req);

      // Return authentication state
      return res.json({
        authenticated: !twoFactorPending,
        twoFactorPending: twoFactorPending,
        twoFactorEnabled: twoFactorEnabled,
        banned,
        ban: banned ? authz.buildBanPayload(user) : null,
        admin: await authz.getAdminStatus(req),
        permissions: userPerms.permissions,
        roles: userPerms.roles,
        site_name: settings.website.name || "Heliactyl",
        user: {
          id: userData.id,
          username: userData.username,
          email: userData.email
        }
      });
    } catch (error) {
      console.error('Error in auth state check:', error);
      return res.status(500).json({
        authenticated: false,
        message: 'Internal server error'
      });
    }
  });

  app.get("/api/v5/settings", async (req, res) => {
    res.json(getPublicSettings());
  });

  app.get("/api/v5/resources", async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) {
        return res.status(401).json({
          error: "Not authenticated"
        });
      }

      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser.id;
      const user = await db.user.findUnique({
        where: { id: sessionUser.id },
        select: {
          packageName: true,
          extraRam: true,
          extraDisk: true,
          extraCpu: true,
          extraServers: true
        }
      });

      const packageKey = user?.packageName || settings.api?.client?.packages?.default || 'default';
      const packageConfig = settings.api?.client?.packages?.list?.[packageKey] || settings.api?.client?.packages?.list?.default || {
        ram: 0,
        disk: 0,
        cpu: 0,
        servers: 0
      };

      const allowed = {
        ram: (packageConfig.ram ?? 0) + (user?.extraRam ?? 0),
        disk: (packageConfig.disk ?? 0) + (user?.extraDisk ?? 0),
        cpu: (packageConfig.cpu ?? 0) + (user?.extraCpu ?? 0),
        servers: (packageConfig.servers ?? 0) + (user?.extraServers ?? 0)
      };

      let current = {
        ram: 0,
        disk: 0,
        cpu: 0,
        servers: 0
      };

      try {
        const pteroUser = await cache.getOrSet(
          `ptero:user:${userId}:servers`,
          () => getPteroUser(userId, db),
          15
        );
        const ownedServers = pteroUser?.attributes?.relationships?.servers?.data ?? [];

        current = ownedServers.reduce((totals, server) => {
          const limits = server?.attributes?.limits ?? {};

          return {
            ram: totals.ram + (limits.memory ?? 0),
            disk: totals.disk + (limits.disk ?? 0),
            cpu: totals.cpu + (limits.cpu ?? 0),
            servers: totals.servers + 1
          };
        }, current);
      } catch (error) {
        console.error('Error fetching current resource usage for /api/v5/resources:', error.message);
      }

      const remaining = {
        ram: Math.max(allowed.ram - current.ram, 0),
        disk: Math.max(allowed.disk - current.disk, 0),
        cpu: Math.max(allowed.cpu - current.cpu, 0),
        servers: Math.max(allowed.servers - current.servers, 0)
      };

      const limits = {
        ram: allowed.ram,
        disk: allowed.disk,
        cpu: allowed.cpu,
        servers: allowed.servers
      };

      return res.json({
        package: packageKey,
        allowed,
        remaining,
        current,
        limits
      });
    } catch (error) {
      console.error('Error in /api/v5/resources:', error);
      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  });

  app.get("/api/coins", async (req, res) => {
    if (!authz.hasUserSession(req)) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    const userId = authz.getSessionUser(req).id;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { coins: true }
    });
    const coins = user?.coins || 0;
    res.json({
      coins,
      index: 0
    });
  });

  // User
  app.get("/api/user", async (req, res) => {
    if (!authz.hasUserSession(req)) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    res.json(authz.getSessionUser(req));
  });

  app.get("/api/remote/user", async (req, res) => {
    if (!authz.hasPterodactylSession(req)) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    const pteroUser = authz.getPterodactylUser(req);
    res.json({
      user: {
        Id: pteroUser.id,
        Username: pteroUser.username,
        Email: pteroUser.email
      },
      Index: 0
    });
  });

  // Consolidated init endpoint - replaces 5+ separate calls on page load
  app.get("/api/v5/init", async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) {
        return res.status(401).json({
          authenticated: false,
          message: 'Not authenticated'
        });
      }

      const userData = authz.getSessionUser(req);
      const pteroUser = authz.getPterodactylUser(req);
      const userId = userData.id;
      const twoFactorPending = !!req.session.twoFactorPending;

      // Batch all DB reads in a single query
      const [userRecord, subuserServersFromPtero, subuserServersFromUserId] = await Promise.all([
        db.user.findUnique({
          where: { id: userId },
          select: { twoFactorEnabled: true, coins: true, pterodactylId: true, discordId: true }
        }),
        pteroUser ? db.subuserServer.findMany({
          where: { user: { pteroUsername: pteroUser.username }, source: 'subuser' }
        }) : Promise.resolve([]),
        pteroUser ? db.subuserServer.findMany({
          where: { userId, source: 'subuser' }
        }) : Promise.resolve([])
      ]);

      // 2FA
      const twoFactorEnabled = userRecord?.twoFactorEnabled || false;

      // Coins
      const coins = userRecord?.coins || 0;

      const isAdmin = await authz.getAdminStatus(req);

      // Servers (uses existing cache layer)
      let servers = [];
      let subuserServers = [];
      try {
        const user = await cache.getOrSet(
          `ptero:user:${userId}:servers`,
          () => getPteroUser(userId, db),
          15
        );
        if (user) {
          servers = user.attributes.relationships.servers.data;
        }
      } catch (e) { /* servers failed, non-blocking */ }

      // Subuser servers
      if (pteroUser) {
        const pteroSubs = subuserServersFromPtero || [];
        const discordSubs = subuserServersFromUserId || [];
        const serverIds = new Set(pteroSubs.map(s => s.serverId));
        subuserServers = [...pteroSubs];
        discordSubs.forEach(s => {
          if (!serverIds.has(s.serverId)) {
            subuserServers.push(s);
            serverIds.add(s.serverId);
          }
        });
      }

      const userPerms = await authz.getUserPermissions(req);

      res.json({
        state: {
          authenticated: !twoFactorPending,
          twoFactorPending,
          twoFactorEnabled,
          site_name: settings.website.name || "Heliactyl"
        },
        user: {
          id: userData.id,
          username: userData.username,
          email: userData.email,
          global_name: userData.global_name || userData.username,
          pterodactylEmail: pteroUser?.email || userData.email
        },
        coins,
        admin: isAdmin,
        permissions: userPerms.permissions,
        roles: userPerms.roles,
        settings: getPublicSettings(),
        servers,
        subuserServers
      });
    } catch (error) {
      console.error('Error in /api/v5/init:', error);
      return res.status(500).json({
        authenticated: false,
        message: 'Internal server error'
      });
    }
  });

  const apiKey = settings.api?.client?.api?.code || "YOUR_API_KEY";

  const pteroClientApi = axios.create({
    baseURL: settings.pterodactyl.domain,
    timeout: 5000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${settings.pterodactyl.client_key}`
    }
  });

  // Authentication middleware for API keys
  const authenticateApiKey = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing API Key' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== apiKey || apiKey === "YOUR_API_KEY") {
      return res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    }
    next();
  };

  // Helper to resolve user
  async function resolveUser(target) {
    if (!target) return null;
    const targetStr = String(target);
    const mentionMatch = targetStr.match(/^<@!?(\d+)>$/);
    const idToSearch = mentionMatch ? mentionMatch[1] : targetStr;

    let user = await db.user.findFirst({
      where: {
        OR: [
          { discordId: idToSearch },
          { username: idToSearch },
          { email: idToSearch },
          { id: idToSearch }
        ]
      }
    });

    if (!user && /^\d+$/.test(idToSearch)) {
      const pteroId = parseInt(idToSearch, 10);
      if (pteroId >= 1 && pteroId <= 2147483647) {
        user = await db.user.findUnique({
          where: { pterodactylId: pteroId }
        });
      }
    }

    return user;
  }

  // 1. Get User Info
  app.post('/api/v5/user/info', authenticateApiKey, async (req, res) => {
    try {
      const { target } = req.body;
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: 'User not found' });

      // Sanitize sensitive fields before sending
      delete user.password;
      delete user.twoFactorSecret;
      delete user.backupCodes;
      delete user.discordAccessToken;
      delete user.discordRefreshToken;
      delete user.sftpPassword;

      res.json(user);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 2. Modify User Coins
  app.post('/api/v5/user/coins', authenticateApiKey, async (req, res) => {
    try {
      const { target, action, amount, moderator } = req.body;
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const parsedAmount = parseInt(amount, 10);
      if (isNaN(parsedAmount) || parsedAmount < 0) {
        return res.status(400).json({ error: 'Amount must be a non-negative integer' });
      }

      let oldCoins = user.coins;
      let newCoins = oldCoins;

      if (action === 'add') {
        newCoins = oldCoins + parsedAmount;
      } else if (action === 'remove') {
        newCoins = Math.max(0, oldCoins - parsedAmount);
      } else if (action === 'set') {
        newCoins = parsedAmount;
      }

      const updatedUser = await db.user.update({
        where: { id: user.id },
        data: { coins: newCoins }
      });

      await db.transaction.create({
        data: {
          userId: user.id,
          type: action === 'add' ? 'earn' : 'spend',
          amount: action === 'set' ? Math.abs(newCoins - oldCoins) : parsedAmount,
          description: `Modified via API client by ${moderator}`
        }
      });

      log('coins updated', `${moderator} updated coins from ${oldCoins} to ${newCoins} for user ${user.username} (ID: ${user.id})`);

      res.json({ success: true, oldCoins, newCoins: updatedUser.coins, username: user.username });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 3. Modify User Resources
  app.post('/api/v5/user/resources', authenticateApiKey, async (req, res) => {
    try {
      const { target, action, cpu, ram, disk, servers, moderator } = req.body;
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: 'User not found' });

      let newCpu = user.extraCpu;
      let newRam = user.extraRam;
      let newDisk = user.extraDisk;
      let newServers = user.extraServers;

      const cpuVal = (cpu !== undefined && cpu !== null) ? parseInt(cpu, 10) : null;
      const ramVal = (ram !== undefined && ram !== null) ? parseInt(ram, 10) : null;
      const diskVal = (disk !== undefined && disk !== null) ? parseInt(disk, 10) : null;
      const serversVal = (servers !== undefined && servers !== null) ? parseInt(servers, 10) : null;

      if ((cpuVal !== null && isNaN(cpuVal)) || 
          (ramVal !== null && isNaN(ramVal)) || 
          (diskVal !== null && isNaN(diskVal)) || 
          (serversVal !== null && isNaN(serversVal))) {
        return res.status(400).json({ error: 'Resource values must be integers' });
      }

      if (action === 'add') {
        newCpu += cpuVal || 0;
        newRam += ramVal || 0;
        newDisk += diskVal || 0;
        newServers += serversVal || 0;
      } else if (action === 'remove') {
        newCpu = Math.max(0, newCpu - (cpuVal || 0));
        newRam = Math.max(0, newRam - (ramVal || 0));
        newDisk = Math.max(0, newDisk - (diskVal || 0));
        newServers = Math.max(0, newServers - (serversVal || 0));
      } else if (action === 'set') {
        if (cpuVal !== null) newCpu = Math.max(0, cpuVal);
        if (ramVal !== null) newRam = Math.max(0, ramVal);
        if (diskVal !== null) newDisk = Math.max(0, diskVal);
        if (serversVal !== null) newServers = Math.max(0, serversVal);
      }

      const updatedUser = await db.user.update({
        where: { id: user.id },
        data: {
          extraCpu: newCpu,
          extraRam: newRam,
          extraDisk: newDisk,
          extraServers: newServers
        }
      });

      await suspendIfNeeded(user.id, settings, db);

      log('resources updated', `${moderator} updated resources for ${user.username}: CPU ${newCpu}%, RAM ${newRam}MB, Disk ${newDisk}MB, Servers ${newServers}`);

      res.json({
        success: true,
        username: user.username,
        oldResources: { cpu: user.extraCpu, ram: user.extraRam, disk: user.extraDisk, servers: user.extraServers },
        newResources: { cpu: updatedUser.extraCpu, ram: updatedUser.extraRam, disk: updatedUser.extraDisk, servers: updatedUser.extraServers }
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 4. Ban User
  app.post('/api/v5/user/ban', authenticateApiKey, async (req, res) => {
    try {
      const { target, reason, moderator, moderatorId } = req.body;
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: 'User not found' });

      await db.user.update({
        where: { id: user.id },
        data: {
          isBanned: true,
          banReason: reason,
          bannedAt: new Date(),
          bannedByUserId: moderatorId,
          bannedByUsername: moderator
        }
      });

      if (app.afkManager) {
        app.afkManager.disconnectUser(user.id, 'banned');
      }

      await db.notification.create({
        data: {
          userId: user.id,
          action: 'user:ban',
          name: `Account banned by ${moderator}: ${reason}`
        }
      });

      log('user banned', `${moderator} banned ${user.username}: ${reason}`);

      res.json({ success: true, username: user.username, reason });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 5. Unban User
  app.post('/api/v5/user/unban', authenticateApiKey, async (req, res) => {
    try {
      const { target, moderator } = req.body;
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: 'User not found' });

      await db.user.update({
        where: { id: user.id },
        data: {
          isBanned: false,
          banReason: null,
          bannedAt: null,
          bannedByUserId: null,
          bannedByUsername: null
        }
      });

      // Clear the unbanned user's IP history to prevent immediate re-ban conflicts
      await db.ipHistory.deleteMany({
        where: { userId: user.id }
      });

      await db.notification.create({
        data: {
          userId: user.id,
          action: 'user:unban',
          name: `Account unbanned by ${moderator}`
        }
      });

      log('user unbanned', `${moderator} unbanned ${user.username}`);

      res.json({ success: true, username: user.username });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 6. List User Servers
  app.post('/api/v5/server/list', authenticateApiKey, async (req, res) => {
    try {
      const { target } = req.body;
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!user.pterodactylId) return res.status(400).json({ error: 'User has no Pterodactyl account linked' });

      const response = await pteroApi.get(`/api/application/users/${user.pterodactylId}?include=servers`);
      const servers = response.data.attributes.relationships.servers.data;
      
      res.json({ username: user.username, servers });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 7. Get Server Info
  app.post('/api/v5/server/info', authenticateApiKey, async (req, res) => {
    try {
      const { serverId } = req.body;
      if (!serverId) return res.status(400).json({ error: 'Missing serverId' });
      let matchedServer = null;

      try {
        const response = await pteroApi.get(`/api/application/servers/external/${serverId}?include=allocations`);
        matchedServer = response.data.attributes;
      } catch (e) {
        try {
          const response = await pteroApi.get(`/api/application/servers/${serverId}?include=allocations`);
          matchedServer = response.data.attributes;
        } catch (err) {
          const list = await pteroApi.get(`/api/application/servers?include=allocations`);
          const matched = list.data.data.find(s => s.attributes.uuid.startsWith(serverId) || s.attributes.identifier === serverId);
          if (matched) matchedServer = matched.attributes;
        }
      }

      if (!matchedServer) return res.status(404).json({ error: 'Server not found' });

      let liveStats = null;
      let statusText = 'unknown';

      try {
        const statsResponse = await pteroClientApi.get(`/api/client/servers/${matchedServer.identifier}/resources`);
        liveStats = statsResponse.data.attributes;
        statusText = liveStats.current_state;
      } catch (err) {
        statusText = 'Wings unreachable ⚠️';
      }

      res.json({ server: matchedServer, liveStats, statusText });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 8. Control Server Power
  app.post('/api/v5/server/control', authenticateApiKey, async (req, res) => {
    try {
      const { serverId, action, moderator } = req.body;
      if (!serverId) return res.status(400).json({ error: 'Missing serverId' });
      let matchedServer = null;

      try {
        const sInfo = await pteroApi.get(`/api/application/servers/external/${serverId}`);
        matchedServer = sInfo.data.attributes;
      } catch (e) {
        try {
          const sInfo = await pteroApi.get(`/api/application/servers/${serverId}`);
          matchedServer = sInfo.data.attributes;
        } catch (err) {
          const serversList = await pteroApi.get(`/api/application/servers`);
          const matched = serversList.data.data.find(s => s.attributes.uuid.startsWith(serverId) || s.attributes.identifier === serverId);
          if (matched) matchedServer = matched.attributes;
        }
      }

      if (!matchedServer) return res.status(404).json({ error: 'Server not found' });
      const resolvedIdentifier = matchedServer.identifier;

      await pteroClientApi.post(`/api/client/servers/${resolvedIdentifier}/power`, { signal: action });

      log('server_modified', `${moderator} sent power signal **${action}** to server \`${resolvedIdentifier}\``);

      res.json({ success: true, identifier: resolvedIdentifier });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/v5/server/allocation/add', authenticateApiKey, async (req, res) => {
    try {
      const { serverId, moderator } = req.body;
      if (!serverId) return res.status(400).json({ error: 'Missing serverId' });
      let matchedServer = null;

      try {
        const sInfo = await pteroApi.get(`/api/application/servers/external/${serverId}`);
        matchedServer = sInfo.data.attributes;
      } catch (e) {
        try {
          const sInfo = await pteroApi.get(`/api/application/servers/${serverId}`);
          matchedServer = sInfo.data.attributes;
        } catch (err) {
          const serversList = await pteroApi.get(`/api/application/servers`);
          const matched = serversList.data.data.find(s => s.attributes.uuid.startsWith(serverId) || s.attributes.identifier === serverId);
          if (matched) matchedServer = matched.attributes;
        }
      }

      if (!matchedServer) return res.status(404).json({ error: 'Server not found' });
      const resolvedIdentifier = matchedServer.identifier;

      const response = await pteroClientApi.post(`/api/client/servers/${resolvedIdentifier}/network/allocations`, {});
      const attributes = response.data.attributes;

      const mod = moderator || 'API Client';
      log('server_modified', `${mod} added port ${attributes.port} to server \`${resolvedIdentifier}\``);

      res.json({
        success: true,
        identifier: resolvedIdentifier,
        allocation: {
          id: attributes.id,
          ip: attributes.ip,
          port: attributes.port,
          is_primary: attributes.is_default,
          alias: attributes.ip_alias || null
        }
      });
    } catch (error) {
      console.error('Error adding allocation:', error);
      res.status(500).json({
        error: 'Failed to add allocation',
        details: error.response?.data || error.message
      });
    }
  });

  // 9. List Nodes
  app.post('/api/v5/node/list', authenticateApiKey, async (req, res) => {
    try {
      const response = await pteroApi.get('/api/application/nodes?include=servers');
      res.json(response.data.data);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 10. Platform Stats
  app.post('/api/v5/stats', authenticateApiKey, async (req, res) => {
    try {
      const totalUsers = await db.user.count();
      const bannedUsers = await db.user.count({ where: { isBanned: true } });
      const totalCoinsRes = await db.user.aggregate({ _sum: { coins: true } });
      const totalCoins = totalCoinsRes._sum.coins || 0;

      res.json({ totalUsers, bannedUsers, totalCoins });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
};
