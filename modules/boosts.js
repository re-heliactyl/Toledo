const axios = require('axios');
const fs = require("fs");
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');

const HeliactylModule = {
  "name": "Boosts",
  "version": "1.0.1",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "contributors": [
    {
      "name": "aachul123",
      "email": "ludo@overnode.fr",
      "url": "https://achul123.pages.dev/"
    }
  ],
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

module.exports.HeliactylModule = HeliactylModule;

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

class BoostError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BoostError';
    this.code = code;
  }
}

class BoostManager {
  constructor(db) {
    this.db = db;

    // Define boost types with their effects and pricing
    this.BOOST_TYPES = {
      performance: {
        id: 'performance',
        name: 'Performance Boost',
        description: 'Doubles your server\'s RAM, CPU and disk allocation for the duration',
        resourceMultiplier: {
          ram: 2.0,
          cpu: 2.0,
          disk: 2.0
        },
        prices: {
          '1h': 150,   // 1 hour: 150 coins
          '3h': 400,   // 3 hours: 400 coins
          '6h': 700,   // 6 hours: 700 coins
          '12h': 1200, // 12 hours: 1200 coins
          '24h': 2000  // 24 hours: 2000 coins
        },
        icon: 'zap'
      },
      cpu: {
        id: 'cpu',
        name: 'CPU Boost',
        description: 'Triples your server\'s CPU allocation for the duration',
        resourceMultiplier: {
          ram: 1.0,
          cpu: 3.0,
          disk: 1.0
        },
        prices: {
          '1h': 100,   // 1 hour: 100 coins
          '3h': 250,   // 3 hours: 250 coins
          '6h': 450,   // 6 hours: 450 coins
          '12h': 800,  // 12 hours: 800 coins
          '24h': 1500  // 24 hours: 1500 coins
        },
        icon: 'cpu'
      },
      memory: {
        id: 'memory',
        name: 'Memory Boost',
        description: 'Triples your server\'s RAM allocation for the duration',
        resourceMultiplier: {
          ram: 3.0,
          cpu: 1.0,
          disk: 1.0
        },
        prices: {
          '1h': 100,   // 1 hour: 100 coins
          '3h': 250,   // 3 hours: 250 coins
          '6h': 450,   // 6 hours: 450 coins
          '12h': 800,  // 12 hours: 800 coins
          '24h': 1500  // 24 hours: 1500 coins
        },
        icon: 'memory-stick'
      },
      storage: {
        id: 'storage',
        name: 'Storage Boost',
        description: 'Triples your server\'s disk allocation for the duration',
        resourceMultiplier: {
          ram: 1.0,
          cpu: 1.0,
          disk: 3.0
        },
        prices: {
          '1h': 80,    // 1 hour: 80 coins
          '3h': 200,   // 3 hours: 200 coins
          '6h': 350,   // 6 hours: 350 coins
          '12h': 600,  // 12 hours: 600 coins
          '24h': 1000  // 24 hours: 1000 coins
        },
        icon: 'hard-drive'
      },
      extreme: {
        id: 'extreme',
        name: 'Extreme Boost',
        description: 'Quadruples ALL resources for the duration - maximum power!',
        resourceMultiplier: {
          ram: 4.0,
          cpu: 4.0,
          disk: 4.0
        },
        prices: {
          '1h': 300,   // 1 hour: 300 coins
          '3h': 800,   // 3 hours: 800 coins
          '6h': 1500,  // 6 hours: 1500 coins
          '12h': 2500, // 12 hours: 2500 coins
          '24h': 4000  // 24 hours: 4000 coins
        },
        icon: 'rocket'
      }
    };

    // Initialize the boost checker
    this.initializeBoostChecker();
  }

  async initializeBoostChecker() {
    // Set up interval to check for expired boosts every minute
    setInterval(() => {
      this.checkExpiredBoosts()
        .catch(err => console.error('[BOOST] Error checking expired boosts:', err));
    }, 60 * 1000);

    // Also check on startup
    await this.checkExpiredBoosts();
  }

  async checkExpiredBoosts() {
    try {
      const expiredBoosts = await this.db.boost.findMany({
        where: {
          status: 'active',
          expiresAt: { lt: new Date() }
        }
      });

      for (const boost of expiredBoosts) {
        // Handle boost expiration (revert server to original resources)
        const initialResources = JSON.parse(boost.initialLimits);
        await this.revertServerResources(boost.serverId, initialResources);

        // Update boost status
        await this.db.boost.update({
          where: { id: boost.id },
          data: { status: 'expired' }
        });

        // Create expiry log
        await this.logBoostActivity(boost.userId, boost.serverId, 'expired', {
          boostType: boost.boostType,
          duration: boost.duration,
          resources: {
            memory: boost.memoryDelta,
            cpu: boost.cpuDelta,
            disk: boost.diskDelta
          }
        });
      }
    } catch (err) {
      console.error('[BOOST] Error in checkExpiredBoosts:', err);
    }
  }

  async getAvailableBoosts() {
    return this.BOOST_TYPES;
  }

  async getServerActiveBoosts(serverId) {
    const boosts = await this.db.boost.findMany({
      where: {
        serverId,
        status: 'active'
      }
    });

    const formattedBoosts = {};
    for (const boost of boosts) {
      formattedBoosts[boost.id] = {
        ...boost,
        appliedAt: boost.appliedAt?.getTime(),
        expiresAt: boost.expiresAt?.getTime(),
        appliedChange: {
          memory: boost.memoryDelta,
          cpu: boost.cpuDelta,
          disk: boost.diskDelta
        },
        initialResources: JSON.parse(boost.initialLimits)
      };
    }
    return formattedBoosts;
  }

  async getUserActiveBoosts(userId) {
    const boosts = await this.db.boost.findMany({
      where: {
        userId,
        status: 'active'
      }
    });

    const userBoosts = {};
    for (const boost of boosts) {
      if (!userBoosts[boost.serverId]) {
        userBoosts[boost.serverId] = {};
      }
      userBoosts[boost.serverId][boost.id] = {
        ...boost,
        appliedAt: boost.appliedAt?.getTime(),
        expiresAt: boost.expiresAt?.getTime(),
        appliedChange: {
          memory: boost.memoryDelta,
          cpu: boost.cpuDelta,
          disk: boost.diskDelta
        },
        initialResources: JSON.parse(boost.initialLimits)
      };
    }

    return userBoosts;
  }

  async applyBoost(userId, serverId, serverAttributes, boostType, duration) {
    try {
      // Validate boost type
      const boostConfig = this.BOOST_TYPES[boostType];
      if (!boostConfig) {
        throw new BoostError('Invalid boost type', 'INVALID_BOOST_TYPE');
      }

      // Validate duration
      if (!boostConfig.prices[duration]) {
        throw new BoostError('Invalid duration', 'INVALID_DURATION');
      }

      // Check user has enough coins
      const user = await this.db.user.findUnique({
        where: { id: userId },
        select: { coins: true }
      });
      const userCoins = user?.coins ?? 0;
      const boostPrice = boostConfig.prices[duration];

      if (userCoins < boostPrice) {
        throw new BoostError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Check if server already has this type of boost active
      const activeTypeBoost = await this.db.boost.findFirst({
        where: {
          serverId,
          boostType,
          status: 'active'
        }
      });

      if (activeTypeBoost) {
        throw new BoostError('Server already has this boost type active', 'BOOST_ALREADY_ACTIVE');
      }

      // Calculate the boost effect
      const initialLimits = serverAttributes.limits;
      const appliedChange = {
        memory: Math.floor(initialLimits.memory * boostConfig.resourceMultiplier.ram) - initialLimits.memory,
        cpu: Math.floor(initialLimits.cpu * boostConfig.resourceMultiplier.cpu) - initialLimits.cpu,
        disk: Math.floor(initialLimits.disk * boostConfig.resourceMultiplier.disk) - initialLimits.disk
      };

      // Calculate boost duration in milliseconds
      const durationInHours = parseInt(duration.replace('h', ''));
      const durationMs = durationInHours * 60 * 60 * 1000;

      // Apply boost to server via Pterodactyl API
      const newLimits = {
        memory: initialLimits.memory + appliedChange.memory,
        cpu: initialLimits.cpu + appliedChange.cpu,
        disk: initialLimits.disk + appliedChange.disk
      };

      const success = await this.updateServerResources(serverId, newLimits);

      if (!success) {
        throw new BoostError('Failed to update server resources', 'UPDATE_FAILED');
      }

      // Deduct coins from user and create boost record in a transaction
      const [updatedUser, boost] = await this.db.$transaction([
        this.db.user.update({
          where: { id: userId },
          data: { coins: { decrement: boostPrice } }
        }),
        this.db.boost.create({
          data: {
            userId,
            serverId,
            serverName: serverAttributes.name,
            boostType,
            duration,
            durationMs,
            price: boostPrice,
            status: 'active',
            appliedAt: new Date(),
            expiresAt: new Date(Date.now() + durationMs),
            memoryDelta: appliedChange.memory,
            cpuDelta: appliedChange.cpu,
            diskDelta: appliedChange.disk,
            initialLimits: JSON.stringify(initialLimits)
          }
        })
      ]);

      const formattedBoost = {
        ...boost,
        appliedAt: boost.appliedAt.getTime(),
        expiresAt: boost.expiresAt.getTime(),
        appliedChange,
        initialResources: initialLimits,
        boostedResources: newLimits
      };

      // Log the boost activity
      await this.logBoostActivity(userId, serverId, 'applied', {
        boostType,
        duration,
        expiresAt: formattedBoost.expiresAt,
        price: boostPrice,
        resources: appliedChange
      });

      return {
        boost: formattedBoost,
        newBalance: updatedUser.coins
      };
    } catch (err) {
      if (err.name === 'BoostError') {
        throw err;
      }
      console.error('[BOOST] Error applying boost:', err);
      throw new BoostError('Failed to apply boost', 'INTERNAL_ERROR');
    }
  }

  async cancelBoost(userId, serverId, boostId) {
    try {
      const boost = await this.db.boost.findUnique({
        where: { id: boostId }
      });

      if (!boost || boost.status !== 'active' || boost.serverId !== serverId) {
        throw new BoostError('Boost not found', 'BOOST_NOT_FOUND');
      }

      // Verify ownership
      if (boost.userId !== userId) {
        throw new BoostError('You do not own this boost', 'NOT_OWNER');
      }

      // Calculate refund amount (proportional to remaining time)
      const now = Date.now();
      const appliedAt = boost.appliedAt.getTime();
      const elapsed = now - appliedAt;
      const total = boost.durationMs;
      const remaining = Math.max(0, total - elapsed);

      // Refund 50% of the proportional remaining value
      const refundPercent = (remaining / total) * 0.5;
      const refundAmount = Math.floor(boost.price * refundPercent);

      // Revert server resources
      const initialResources = JSON.parse(boost.initialLimits);
      await this.revertServerResources(serverId, initialResources);

      // Update boost status and user balance in transaction
      const [updatedUser] = await this.db.$transaction([
        this.db.user.update({
          where: { id: userId },
          data: { coins: { increment: refundAmount } }
        }),
        this.db.boost.update({
          where: { id: boostId },
          data: { status: 'cancelled' }
        })
      ]);

      // Log cancellation
      await this.logBoostActivity(userId, serverId, 'cancelled', {
        boostType: boost.boostType,
        duration: boost.duration,
        refundAmount,
        resources: {
          memory: boost.memoryDelta,
          cpu: boost.cpuDelta,
          disk: boost.diskDelta
        }
      });

      return {
        refundAmount,
        newBalance: updatedUser.coins
      };
    } catch (err) {
      if (err.name === 'BoostError') {
        throw err;
      }
      console.error('[BOOST] Error cancelling boost:', err);
      throw new BoostError('Failed to cancel boost', 'INTERNAL_ERROR');
    }
  }

  async extendBoost(userId, serverId, boostId, additionalDuration) {
    try {
      const boost = await this.db.boost.findUnique({
        where: { id: boostId }
      });

      if (!boost || boost.status !== 'active' || boost.serverId !== serverId) {
        throw new BoostError('Boost not found', 'BOOST_NOT_FOUND');
      }

      // Verify ownership
      if (boost.userId !== userId) {
        throw new BoostError('You do not own this boost', 'NOT_OWNER');
      }

      // Validate additional duration
      const boostConfig = this.BOOST_TYPES[boost.boostType];
      if (!boostConfig.prices[additionalDuration]) {
        throw new BoostError('Invalid extension duration', 'INVALID_DURATION');
      }

      // Calculate extension price
      const extensionPrice = boostConfig.prices[additionalDuration];

      // Check user has enough coins
      const user = await this.db.user.findUnique({
        where: { id: userId },
        select: { coins: true }
      });
      const userCoins = user?.coins ?? 0;
      if (userCoins < extensionPrice) {
        throw new BoostError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Calculate new expiry time
      const durationInHours = parseInt(additionalDuration.replace('h', ''));
      const additionalMs = durationInHours * 60 * 60 * 1000;
      const newExpiresAt = new Date(boost.expiresAt.getTime() + additionalMs);

      // Update boost and user balance in transaction
      const [updatedUser, updatedBoost] = await this.db.$transaction([
        this.db.user.update({
          where: { id: userId },
          data: { coins: { decrement: extensionPrice } }
        }),
        this.db.boost.update({
          where: { id: boostId },
          data: {
            expiresAt: newExpiresAt,
            durationMs: boost.durationMs + additionalMs,
            price: boost.price + extensionPrice
          }
        })
      ]);

      const formattedBoost = {
        ...updatedBoost,
        appliedAt: updatedBoost.appliedAt.getTime(),
        expiresAt: updatedBoost.expiresAt.getTime(),
        appliedChange: {
          memory: updatedBoost.memoryDelta,
          cpu: updatedBoost.cpuDelta,
          disk: updatedBoost.diskDelta
        },
        initialResources: JSON.parse(updatedBoost.initialLimits)
      };

      // Log extension
      await this.logBoostActivity(userId, serverId, 'extended', {
        boostType: updatedBoost.boostType,
        additionalDuration,
        newExpiresAt: formattedBoost.expiresAt,
        price: extensionPrice
      });

      return {
        boost: formattedBoost,
        newBalance: updatedUser.coins
      };
    } catch (err) {
      if (err.name === 'BoostError') {
        throw err;
      }
      console.error('[BOOST] Error extending boost:', err);
      throw new BoostError('Failed to extend boost', 'INTERNAL_ERROR');
    }
  }

  async scheduleBoost(userId, serverId, serverAttributes, boostType, duration, scheduledTime) {
    try {
      // Validate boost type
      const boostConfig = this.BOOST_TYPES[boostType];
      if (!boostConfig) {
        throw new BoostError('Invalid boost type', 'INVALID_BOOST_TYPE');
      }

      // Validate duration
      if (!boostConfig.prices[duration]) {
        throw new BoostError('Invalid duration', 'INVALID_DURATION');
      }

      // Validate scheduled time (must be in the future)
      const now = Date.now();
      if (scheduledTime <= now) {
        throw new BoostError('Scheduled time must be in the future', 'INVALID_SCHEDULED_TIME');
      }

      // Check user has enough coins
      const user = await this.db.user.findUnique({
        where: { id: userId },
        select: { coins: true }
      });
      const userCoins = user?.coins ?? 0;
      const boostPrice = boostConfig.prices[duration];

      if (userCoins < boostPrice) {
        throw new BoostError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Deduct coins and create scheduled boost record in transaction
      const durationInHours = parseInt(duration.replace('h', ''));
      const durationMs = durationInHours * 60 * 60 * 1000;

      const [updatedUser, boost] = await this.db.$transaction([
        this.db.user.update({
          where: { id: userId },
          data: { coins: { decrement: boostPrice } }
        }),
        this.db.boost.create({
          data: {
            userId,
            serverId,
            serverName: serverAttributes.name,
            boostType,
            duration,
            durationMs,
            price: boostPrice,
            status: 'scheduled',
            scheduledFor: new Date(scheduledTime),
            initialLimits: JSON.stringify(serverAttributes.limits)
          }
        })
      ]);

      const formattedBoost = {
        ...boost,
        scheduledTime: boost.scheduledFor.getTime(),
        createdAt: boost.createdAt.getTime()
      };

      // Log the scheduled boost
      await this.logBoostActivity(userId, serverId, 'scheduled', {
        boostType,
        duration,
        scheduledTime,
        price: boostPrice
      });

      return {
        scheduledBoost: formattedBoost,
        newBalance: updatedUser.coins
      };
    } catch (err) {
      if (err.name === 'BoostError') {
        throw err;
      }
      console.error('[BOOST] Error scheduling boost:', err);
      throw new BoostError('Failed to schedule boost', 'INTERNAL_ERROR');
    }
  }

  async getScheduledBoosts(userId) {
    try {
      const boosts = await this.db.boost.findMany({
        where: {
          userId,
          status: 'scheduled'
        }
      });
      return boosts.map(boost => ({
        ...boost,
        scheduledTime: boost.scheduledFor.getTime(),
        createdAt: boost.createdAt.getTime()
      }));
    } catch (err) {
      console.error('[BOOST] Error getting scheduled boosts:', err);
      throw new BoostError('Failed to get scheduled boosts', 'INTERNAL_ERROR');
    }
  }

  async cancelScheduledBoost(userId, scheduledBoostId) {
    try {
      const boost = await this.db.boost.findUnique({
        where: { id: scheduledBoostId }
      });

      if (!boost || boost.status !== 'scheduled' || boost.userId !== userId) {
        throw new BoostError('Scheduled boost not found', 'BOOST_NOT_FOUND');
      }

      // Refund full amount and update status in transaction
      const [updatedUser] = await this.db.$transaction([
        this.db.user.update({
          where: { id: userId },
          data: { coins: { increment: boost.price } }
        }),
        this.db.boost.update({
          where: { id: scheduledBoostId },
          data: { status: 'cancelled' }
        })
      ]);

      // Log cancellation
      await this.logBoostActivity(userId, boost.serverId, 'scheduled_cancelled', {
        boostType: boost.boostType,
        duration: boost.duration,
        scheduledTime: boost.scheduledFor.getTime(),
        refundAmount: boost.price
      });

      return {
        refundAmount: boost.price,
        newBalance: updatedUser.coins
      };
    } catch (err) {
      if (err.name === 'BoostError') {
        throw err;
      }
      console.error('[BOOST] Error cancelling scheduled boost:', err);
      throw new BoostError('Failed to cancel scheduled boost', 'INTERNAL_ERROR');
    }
  }

  async getBoostHistory(userId, limit = 20) {
    try {
      // In Prisma, we can query transactions and boosts to get history
      // The old implementation used a separate history key. 
      // We'll query transactions of type related to boosts for the user.
      const transactions = await this.db.transaction.findMany({
        where: {
          userId,
          type: { in: ['boost_purchase', 'boost_extend', 'boost_refund'] }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      });

      return transactions.map(txn => ({
        id: txn.id,
        userId: txn.userId,
        type: txn.type,
        details: JSON.parse(txn.details),
        amount: txn.amount,
        timestamp: txn.createdAt.getTime()
      }));
    } catch (err) {
      console.error('[BOOST] Error getting boost history:', err);
      throw new BoostError('Failed to get boost history', 'INTERNAL_ERROR');
    }
  }

  async logBoostActivity(userId, serverId, type, details) {
    try {
      // Log to wallet transactions if it involves coins
      let walletType = null;
      let walletAmount = 0;
      let walletDesc = '';

      if (type === 'applied' || type === 'scheduled') {
        walletType = 'boost_purchase';
        walletAmount = -(details.price || 0);
        walletDesc = `Boost: ${details.boostType} (${details.duration})`;
      } else if (type === 'extended') {
        walletType = 'boost_extend';
        walletAmount = -(details.price || 0);
        walletDesc = `Boost Extend: ${details.boostType} (+${details.additionalDuration})`;
      } else if (type === 'cancelled' || type === 'scheduled_cancelled' || type === 'scheduled_failed') {
        walletType = 'boost_refund';
        walletAmount = details.refundAmount || 0;
        walletDesc = `Boost Refund: ${details.boostType}`;
      }

      if (walletType && walletAmount !== 0) {
        await this.db.transaction.create({
          data: {
            userId,
            type: walletType,
            amount: walletAmount,
            description: walletDesc,
            details: JSON.stringify(details)
          }
        });
      }

      // We don't need a separate boost-history-userId anymore as we can query transactions
      return { success: true };
    } catch (err) {
      console.error('[BOOST] Error logging boost activity:', err);
    }
  }

  // Helper function to update server resources via Pterodactyl API
  async updateServerResources(serverId, newLimits) {
    try {
      // Fetch current server details to get required fields that we shouldn't change or need to preserve
      const serverResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
      const server = serverResponse.data.attributes;

      await pteroApi.patch(`/api/application/servers/${serverId}/build`, {
        allocation: server.allocation,
        memory: newLimits.memory,
        swap: server.limits.swap || 0,
        disk: newLimits.disk,
        io: server.limits.io || 500,
        cpu: newLimits.cpu,
        threads: server.limits.threads || null,
        feature_limits: {
          databases: server.feature_limits.databases,
          allocations: server.feature_limits.allocations,
          backups: server.feature_limits.backups
        }
      });

      return true;
    } catch (err) {
      console.error('[BOOST] Error updating server resources:', JSON.stringify(err.response?.data || err.message));
      return false;
    }
  }

  // Helper function to revert server resources to original values
  async revertServerResources(serverId, initialLimits) {
    try {
      return await this.updateServerResources(serverId, {
        memory: initialLimits.memory,
        cpu: initialLimits.cpu,
        disk: initialLimits.disk
      });
    } catch (err) {
      console.error('[BOOST] Error reverting server resources:', err);
      return false;
    }
  }
}

module.exports.load = function (app, db) {
  const boostManager = new BoostManager(db);
  const authz = createAuthz(db);

  // Middleware to check if boosts are enabled
  function boostsEnabled(req, res, next) {
    if (settings.api?.client?.coins?.boosts?.enabled === false) {
      return res.status(403).json({ error: 'Server boosts are currently disabled' });
    }
    next();
  }

  // ==== API ENDPOINTS ====

  // Get available boost types
  app.get('/api/boosts/types', boostsEnabled, async (req, res) => {
    try {
      const boostTypes = await boostManager.getAvailableBoosts();
      res.json(boostTypes);
    } catch (error) {
      console.error('[BOOST] Error getting boost types:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get active boosts for a server
  app.get('/api/boosts/server/:serverId', boostsEnabled, async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const { serverId } = req.params;
      const activeBoosts = await boostManager.getServerActiveBoosts(serverId);
      const sessionUser = authz.getSessionUser(req);

      // Only return boosts owned by the requesting user
      const userBoosts = {};
      for (const [boostId, boost] of Object.entries(activeBoosts)) {
        if (boost.userId === sessionUser.id) {
          userBoosts[boostId] = boost;
        }
      }

      res.json(userBoosts);
    } catch (error) {
      console.error('[BOOST] Error getting server boosts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get all active boosts for the user
  app.get('/api/boosts/active', boostsEnabled, async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const activeBoosts = await boostManager.getUserActiveBoosts(userId);

      res.json(activeBoosts);
    } catch (error) {
      console.error('[BOOST] Error getting user boosts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get scheduled boosts
  app.get('/api/boosts/scheduled', boostsEnabled, async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const scheduledBoosts = await boostManager.getScheduledBoosts(userId);

      res.json(scheduledBoosts);
    } catch (error) {
      console.error('[BOOST] Error getting scheduled boosts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get boost history
  app.get('/api/boosts/history', boostsEnabled, async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const limit = req.query.limit ? parseInt(req.query.limit) : 20;

      const history = await boostManager.getBoostHistory(userId, limit);

      res.json(history);
    } catch (error) {
      console.error('[BOOST] Error getting boost history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Apply boost to a server
  app.post('/api/boosts/apply', boostsEnabled, validate(schemas.boostApply), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { serverId, boostType, duration } = req.body;

      // Fetch server info to get current resources
      try {
        const serverInfoResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
        const serverInfo = serverInfoResponse.data;

        // Verify server ownership
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { pterodactylId: true }
        });

        if (serverInfo.attributes.user !== user?.pterodactylId) {
          return res.status(403).json({ error: 'You do not own this server', code: 'NOT_OWNER' });
        }

        const result = await boostManager.applyBoost(
          userId,
          serverId,
          serverInfo.attributes,
          boostType,
          duration
        );

        res.json({
          success: true,
          boost: result.boost,
          newBalance: result.newBalance
        });
      } catch (error) {
        if (error.response?.status === 404) {
          return res.status(404).json({ error: 'Server not found', code: 'SERVER_NOT_FOUND' });
        }
        throw error;
      }
    } catch (error) {
      if (error.name === 'BoostError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[BOOST] Error applying boost:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Cancel an active boost
  app.post('/api/boosts/cancel', boostsEnabled, validate(schemas.boostCancel), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { serverId, boostId } = req.body;

      const result = await boostManager.cancelBoost(userId, serverId, boostId);

      res.json({
        success: true,
        refundAmount: result.refundAmount,
        newBalance: result.newBalance
      });
    } catch (error) {
      if (error.name === 'BoostError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[BOOST] Error cancelling boost:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Extend an active boost
  app.post('/api/boosts/extend', boostsEnabled, validate(schemas.boostExtend), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { serverId, boostId, additionalDuration } = req.body;

      const result = await boostManager.extendBoost(
        userId,
        serverId,
        boostId,
        additionalDuration
      );

      res.json({
        success: true,
        boost: result.boost,
        newBalance: result.newBalance
      });
    } catch (error) {
      if (error.name === 'BoostError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[BOOST] Error extending boost:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Schedule a boost for the future
  app.post('/api/boosts/schedule', boostsEnabled, validate(schemas.boostSchedule), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { serverId, boostType, duration, startTime } = req.body;

      // Fetch server info to get current resources
      try {
        const serverInfoResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
        const serverInfo = serverInfoResponse.data;

        // Verify server ownership
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { pterodactylId: true }
        });

        if (serverInfo.attributes.user !== user?.pterodactylId) {
          return res.status(403).json({ error: 'You do not own this server', code: 'NOT_OWNER' });
        }

        const result = await boostManager.scheduleBoost(
          userId,
          serverId,
          serverInfo.attributes,
          boostType,
          duration,
          startTime
        );

        res.json({
          success: true,
          scheduledBoost: result.scheduledBoost,
          newBalance: result.newBalance
        });
      } catch (error) {
        if (error.response?.status === 404) {
          return res.status(404).json({ error: 'Server not found', code: 'SERVER_NOT_FOUND' });
        }
        throw error;
      }
    } catch (error) {
      if (error.name === 'BoostError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[BOOST] Error scheduling boost:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Cancel a scheduled boost
  app.post('/api/boosts/cancel-scheduled', boostsEnabled, validate(schemas.boostCancelScheduled), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { scheduledBoostId } = req.body;

      const result = await boostManager.cancelScheduledBoost(userId, scheduledBoostId);

      res.json({
        success: true,
        refundAmount: result.refundAmount,
        newBalance: result.newBalance
      });
    } catch (error) {
      if (error.name === 'BoostError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[BOOST] Error cancelling scheduled boost:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Initialize the scheduled boost processor
  const processScheduledBoosts = async () => {
    try {
      const dueBoosts = await db.boost.findMany({
        where: {
          status: 'scheduled',
          scheduledFor: { lte: new Date() }
        }
      });

      if (dueBoosts.length > 0) {
        // Process each due boost
        for (const boost of dueBoosts) {
          try {
            // Fetch server info
            const serverInfoResponse = await pteroApi.get(`/api/application/servers/${boost.serverId}`);
            const serverInfo = serverInfoResponse.data;

            // Apply the boost
            await boostManager.applyBoost(
              boost.userId,
              boost.serverId,
              serverInfo.attributes,
              boost.boostType,
              boost.duration
            );

            //update original scheduled boost record to avoid double-processing (applyBoost creates a NEW active boost record)
            //applyBoost in the old version used to just set the status? 
            //Looking at applyBoost, it created a new ID
            //in original code, applyBoost was called and it created a NEW record in active-boosts
            //then it logged scheduled_applied
            //the scheduled boost was removed from scheduled-boosts array

            await db.boost.update({
              where: { id: boost.id },
              data: { status: 'applied' }
            });

            await boostManager.logBoostActivity(boost.userId, boost.serverId, 'scheduled_applied', {
              scheduledTime: boost.scheduledFor.getTime(),
              appliedTime: Date.now(),
              ...boost,
              initialLimits: JSON.parse(boost.initialLimits)
            });
          } catch (err) {
            console.error(`[BOOST] Error applying scheduled boost:`, err);

            // Refund the user
            await db.user.update({
              where: { id: boost.userId },
              data: { coins: { increment: boost.price } }
            });

            await db.boost.update({
              where: { id: boost.id },
              data: { status: 'failed' }
            });

            await boostManager.logBoostActivity(boost.userId, boost.serverId, 'scheduled_failed', {
              reason: err.message || 'Unknown error',
              refundAmount: boost.price,
              ...boost,
              initialLimits: JSON.parse(boost.initialLimits)
            });
          }
        }
      }
    } catch (err) {
      console.error('[BOOST] Error processing scheduled boosts:', err);
    }
  };

  // Set up scheduled boost processor to run every minute
  setInterval(processScheduledBoosts, 60 * 1000);

  // Also run on startup after a short delay (to ensure database is ready)
  setTimeout(processScheduledBoosts, 10000);
};
