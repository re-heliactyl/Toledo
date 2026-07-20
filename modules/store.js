const fs = require("fs");
const WebSocket = require('ws');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const log = require("../handlers/log.js");
const adminjs = require("./admin.js");
const { validate, schemas } = require("../handlers/validate.js");
const createAuthz = require('../handlers/authz');

const HeliactylModule = {
  "name": "Store",
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

module.exports.HeliactylModule = HeliactylModule;

const AFK_DB_KEYS = {
  config: 'afk:config'
};

const DEFAULT_AFK_CONFIG = {
  enabled: true,
  dailyCap: 45
};

class AFKRewardsManager {
  constructor(db) {
    this.db = db;
    this.BASE_COINS_PER_MINUTE = 1; // Adjusted to Int for Prisma schema
    this.INTERVAL_MS = 60000;
    this.timeouts = new Map();
    this.stateTimeouts = new Map();
    this.sessions = new Map();
  }

  async getConfig() {
    try {
      const row = await this.db.heliactyl.findUnique({ where: { key: AFK_DB_KEYS.config } });
      const config = row ? JSON.parse(row.value) : null;
      return config ? { ...DEFAULT_AFK_CONFIG, ...config } : DEFAULT_AFK_CONFIG;
    } catch {
      return DEFAULT_AFK_CONFIG;
    }
  }

  async setConfig(newConfig) {
    const current = await this.getConfig();
    const merged = { ...current, ...newConfig };

    await this.db.heliactyl.upsert({
      where: { key: AFK_DB_KEYS.config },
      update: { value: JSON.stringify(merged) },
      create: { key: AFK_DB_KEYS.config, value: JSON.stringify(merged) }
    });

    return merged;
  }

  async getCoinsPerMinute(userId) {
    try {
      // Check if user has upgraded_pack or god_pack
      const hasPack = await this.db.userPack.findFirst({
        where: {
          userId,
          type: { in: ['upgraded_pack', 'god_pack'] },
          status: 'active',
          expiresAt: { gt: new Date() }
        }
      });
      return hasPack ? this.BASE_COINS_PER_MINUTE * 1.5 : this.BASE_COINS_PER_MINUTE;
    } catch {
      return this.BASE_COINS_PER_MINUTE;
    }
  }

  getStartOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  async getTodayAfkTotal(userId) {
    const todayStart = this.getStartOfToday();
    const summary = await this.db.transaction.aggregate({
      where: {
        userId,
        type: 'afk',
        createdAt: { gte: todayStart }
      },
      _sum: {
        amount: true
      }
    });

    return summary._sum.amount || 0;
  }

  hasActiveSession(userId) {
    const session = this.sessions.get(userId);
    if (!session) return false;
    return Date.now() - session.lastUpdate < 60000;
  }

  createSession(userId, clusterId, ws) {
    this.sessions.set(userId, {
      clusterId,
      ws,
      lastReward: Date.now(),
      lastUpdate: Date.now(),
      startTime: Date.now(),
      coinsEarned: 0
    });
  }

  updateSession(userId) {
    const session = this.sessions.get(userId);
    if (session) {
      session.lastReward = Date.now();
      session.lastUpdate = Date.now();
    }
  }

  removeSession(userId) {
    this.sessions.delete(userId);
  }

  disconnectUser(userId, reason) {
    const session = this.sessions.get(userId);
    if (!session) return false;

    try {
      if (session.ws && session.ws.readyState === 1) {
        session.ws.close(4005, reason || 'banned');
      }
    } catch {}

    this.cleanup(userId);
    return true;
  }

  async processReward(userId, ws) {
    try {
      const config = await this.getConfig();
      if (!config.enabled) {
        ws.close(4003, 'AFK disabled');
        return;
      }

      const coinsPerMinute = await this.getCoinsPerMinute(userId);
      const todayTotal = await this.getTodayAfkTotal(userId);
      const remainingToday = Math.max(0, config.dailyCap - todayTotal);
      const rewardAmount = Math.min(coinsPerMinute, remainingToday);

      if (rewardAmount <= 0) {
        try { ws.send(JSON.stringify({ type: 'daily_cap_reached', dailyCap: config.dailyCap })); } catch {}
        this.cleanup(userId);
        ws.close(4004, 'Daily cap reached');
        return;
      }

      // Use atomic increment for coins
      await this.db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { 
            coins: { increment: rewardAmount },
            totalCoinsEarned: { increment: rewardAmount }
          }
        });

        const session = this.sessions.get(userId);
        const sessionMinutes = session ? Math.round((Date.now() - session.startTime) / 60000) : 0;

        await tx.transaction.create({
          data: {
            userId,
            type: 'afk',
            amount: rewardAmount,
            description: 'AFK Rewards',
            details: JSON.stringify({ sessionDuration: sessionMinutes })
          }
        });
      });

      const session = this.sessions.get(userId);
      if (session) session.coinsEarned += rewardAmount;
      this.updateSession(userId);
      this.sendState(userId, ws);
      this.scheduleNextReward(userId, ws);
    } catch (error) {
      console.error(`[ERROR] Failed to process reward for ${userId}:`, error);
      ws.close(4000, 'Failed to process reward');
    }
  }

  scheduleNextReward(userId, ws) {
    const timeout = setTimeout(() => {
      this.processReward(userId, ws);
    }, this.INTERVAL_MS);

    this.timeouts.set(userId, timeout);
  }

  getLastReward(userId) {
    return this.sessions.get(userId)?.lastReward || Date.now();
  }

  async sendState(userId, ws) {
    const lastRewardTime = this.getLastReward(userId);
    const nextRewardIn = Math.max(0, this.INTERVAL_MS - (Date.now() - lastRewardTime));
    const coinsPerMinute = await this.getCoinsPerMinute(userId);

    ws.send(JSON.stringify({
      type: 'afk_state',
      coinsPerMinute,
      nextRewardIn,
      timestamp: Date.now()
    }));
  }

  startStateUpdates(userId, ws) {
    const updateState = () => {
      this.sendState(userId, ws).catch(() => {});
      const timeout = setTimeout(updateState, 1000);
      this.stateTimeouts.set(userId, timeout);
    };
    updateState();
  }

  cleanup(userId) {
    const timeout = this.timeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(userId);
    }

    const stateTimeout = this.stateTimeouts.get(userId);
    if (stateTimeout) {
      clearTimeout(stateTimeout);
      this.stateTimeouts.delete(userId);
    }

    this.removeSession(userId);
  }
}

const RESOURCE_PRICES = {
  ram: settings?.api?.client?.coins?.store?.ram?.cost || 600,
  disk: settings?.api?.client?.coins?.store?.disk?.cost || 400,
  cpu: settings?.api?.client?.coins?.store?.cpu?.cost || 500,
  servers: settings?.api?.client?.coins?.store?.servers?.cost || 200
};

const RESOURCE_MULTIPLIERS = {
  ram: 1024,
  disk: 5120,
  cpu: 100,
  servers: 1
};

const MAX_RESOURCE_LIMITS = {
  ram: 96,
  disk: 200,
  cpu: 36,
  servers: 20
};

class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

class Store {
  constructor(db) {
    this.db = db;
  }

  validateResourceAmount(resourceType, amount) {
    if (!RESOURCE_PRICES[resourceType]) throw new StoreError('Invalid resource type', 'INVALID_RESOURCE');
    if (!Number.isInteger(amount) || amount < 1) throw new StoreError('Amount must be a positive integer', 'INVALID_AMOUNT');
    return true;
  }

  async updateResourceLimits(userId, resourceType, amount) {
    const fieldMap = {
      ram: 'extraRam',
      disk: 'extraDisk',
      cpu: 'extraCpu',
      servers: 'extraServers'
    };
    const field = fieldMap[resourceType];
    const actualAmount = amount * RESOURCE_MULTIPLIERS[resourceType];

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { [field]: true }
    });

    const currentAmount = user?.[field] ?? 0;
    const newAmount = currentAmount + actualAmount;

    const maxLimit = MAX_RESOURCE_LIMITS[resourceType] * RESOURCE_MULTIPLIERS[resourceType];
    if (newAmount > maxLimit) {
      throw new StoreError(`Resource limit exceeded`, 'RESOURCE_LIMIT_EXCEEDED');
    }

    const updatedUser = await this.db.user.update({
      where: { id: userId },
      data: { [field]: { increment: actualAmount } }
    });

    return {
      ram: updatedUser.extraRam,
      disk: updatedUser.extraDisk,
      cpu: updatedUser.extraCpu,
      servers: updatedUser.extraServers
    };
  }

  async logPurchase(userId, resourceType, amount, cost) {
    return await this.db.transaction.create({
      data: {
        userId,
        type: 'store_purchase',
        amount: -cost,
        description: `Bought ${amount} ${resourceType}`,
        details: JSON.stringify({
          resource: resourceType,
          amount: amount,
          cost: cost
        })
      }
    });
  }
}

module.exports.load = function (app, db) {
  const afkManager = new AFKRewardsManager(db);
  const clusterId = process.env.CLUSTER_ID || `cluster-${Math.random().toString(36).substring(7)}`;
  const store = new Store(db);
  const authz = createAuthz(db);

  app.afkManager = afkManager;

  app.ws('/ws', async function (ws, req) {
    if (!authz.hasUserSession(req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const sessionUser = authz.getSessionUser(req);
    const userId = sessionUser.id;

    try {
      const afkConfig = await afkManager.getConfig();
      if (!afkConfig.enabled) {
        ws.close(4003, 'AFK disabled');
        return;
      }

      const todayTotal = await afkManager.getTodayAfkTotal(userId);
      if (todayTotal >= afkConfig.dailyCap) {
        try { ws.send(JSON.stringify({ type: 'daily_cap_reached', dailyCap: afkConfig.dailyCap })); } catch {}
        ws.close(4004, 'Daily cap reached');
        return;
      }

      if (afkManager.hasActiveSession(userId)) {
        ws.close(4002, 'Already connected');
        return;
      }

      afkManager.createSession(userId, clusterId, ws);
      afkManager.scheduleNextReward(userId, ws);
      afkManager.startStateUpdates(userId, ws);

      const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress?.replace('::ffff:', '');
      const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, discordId: true } });
      log('afk_connect', `**${sessionUser.username}** started an AFK session\nEmail: \`${user?.email || 'unknown'}\`\nDiscord: \`${user?.discordId || 'none'}\`\nIP: \`${clientIp || 'unknown'}\``);

      ws.on('close', () => {
        const session = afkManager.sessions.get(userId);
        const duration = session ? Math.round((Date.now() - session.startTime) / 60000) : 0;
        const earned = session ? session.coinsEarned : 0;
        
        // Only log if user actually spent time in AFK
        if (duration > 0 && earned > 0) {
          log('afk_disconnect', `**${sessionUser.username}** ended AFK session\nDuration: **${duration} min**\nCoins earned: **${earned}**`);
        }
        
        afkManager.cleanup(userId);
      });

    } catch (error) {
      console.error(`[ERROR] Failed to setup AFK session for ${userId}:`, error);
      ws.close(4000, 'Failed to setup AFK session');
    }
  });

  app.get('/api/store/config', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const user = await db.user.findUnique({ where: { id: userId }, select: { coins: true } });
      const userCoins = user?.coins ?? 0;

      const configResponse = {
        prices: {
          resources: RESOURCE_PRICES
        },
        multipliers: RESOURCE_MULTIPLIERS,
        limits: MAX_RESOURCE_LIMITS,
        userBalance: userCoins,
        canAfford: {
          ram: userCoins >= RESOURCE_PRICES.ram,
          disk: userCoins >= RESOURCE_PRICES.disk,
          cpu: userCoins >= RESOURCE_PRICES.cpu,
          servers: userCoins >= RESOURCE_PRICES.servers
        }
      };

      res.json(configResponse);

    } catch (error) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  app.get('/api/afk/config', async (req, res) => {
    try {
      const config = await afkManager.getConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/admin/afk/config', async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const config = await afkManager.getConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/admin/afk/config', async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const currentConfig = await afkManager.getConfig();
      const nextConfig = {};

      if (req.body.enabled !== undefined) {
        if (typeof req.body.enabled !== 'boolean') {
          return res.status(400).json({ error: 'Enabled must be a boolean' });
        }

        nextConfig.enabled = req.body.enabled;
      }

      if (req.body.dailyCap !== undefined) {
        const parsedCap = Number.parseInt(req.body.dailyCap, 10);
        if (Number.isNaN(parsedCap) || parsedCap < 1) {
          return res.status(400).json({ error: 'Daily cap must be an integer greater than or equal to 1' });
        }

        nextConfig.dailyCap = parsedCap;
      }

      const updatedConfig = await afkManager.setConfig({
        enabled: nextConfig.enabled ?? currentConfig.enabled,
        dailyCap: nextConfig.dailyCap ?? currentConfig.dailyCap
      });

      res.json({ success: true, config: updatedConfig });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/store/buy', validate(schemas.storeBuy), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { resourceType, amount } = req.body;

      const cost = RESOURCE_PRICES[resourceType] * amount;

      const fieldMap = { ram: 'extraRam', disk: 'extraDisk', cpu: 'extraCpu', servers: 'extraServers' };
      const field = fieldMap[resourceType];
      const actualAmount = amount * RESOURCE_MULTIPLIERS[resourceType];

      // Pre-check balance and resource limits
      const user = await db.user.findUnique({ where: { id: userId }, select: { coins: true, [field]: true } });
      const userCoins = user?.coins ?? 0;

      if (userCoins < cost) {
        return res.status(402).json({
          error: 'Insufficient funds',
          required: cost,
          balance: userCoins
        });
      }

      const currentResource = user?.[field] ?? 0;
      const maxLimit = MAX_RESOURCE_LIMITS[resourceType] * RESOURCE_MULTIPLIERS[resourceType];
      if (currentResource + actualAmount > maxLimit) {
        return res.status(400).json({ error: 'Resource limit exceeded', code: 'RESOURCE_LIMIT_EXCEEDED' });
      }

      // Atomic transaction: deduct coins + increment resource
      const [updatedUser] = await db.$transaction([
        db.user.update({
          where: { id: userId },
          data: { coins: { decrement: cost } }
        }),
        db.user.update({
          where: { id: userId },
          data: { [field]: { increment: actualAmount } }
        })
      ]);

      const purchase = await store.logPurchase(userId, resourceType, amount, cost);

      res.json({
        success: true,
        purchase,
        resources: {
          ram: updatedUser.extraRam,
          disk: updatedUser.extraDisk,
          cpu: updatedUser.extraCpu,
          servers: updatedUser.extraServers
        },
        remainingCoins: updatedUser.coins
      });

    } catch (error) {
      if (error instanceof StoreError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/store/history', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const userId = authz.getSessionUser(req).id;
      const history = await db.transaction.findMany({
        where: { userId, type: 'store_purchase' },
        orderBy: { createdAt: 'desc' }
      });
      res.json(history.map(h => ({
        ...h,
        ...JSON.parse(h.details || '{}')
      })));
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/store/resources', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const userId = authz.getSessionUser(req).id;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { extraRam: true, extraDisk: true, extraCpu: true, extraServers: true }
      });
      res.json({
        ram: user?.extraRam ?? 0,
        disk: user?.extraDisk ?? 0,
        cpu: user?.extraCpu ?? 0,
        servers: user?.extraServers ?? 0
      });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

};
