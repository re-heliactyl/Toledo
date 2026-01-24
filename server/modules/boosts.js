const axios = require('axios');
const indexjs = require("../app.js");
const fs = require("fs");
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");

const HeliactylModule = {
  "name": "Boosts",
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
      const now = Date.now();
      // Get all active boosts for all servers
      const activeBoosts = await this.db.get("active-boosts") || {};

      let updated = false;

      // Check each server's boosts
      for (const [serverId, boosts] of Object.entries(activeBoosts)) {
        const expiredBoostIds = [];

        // Check each boost for expiration
        for (const [boostId, boost] of Object.entries(boosts)) {
          if (boost.expiresAt < now) {
            expiredBoostIds.push(boostId);

            // Handle boost expiration (revert server to original resources)
            await this.revertServerResources(serverId, boost);

            // Create expiry log
            await this.logBoostActivity(boost.userId, serverId, 'expired', {
              boostType: boost.boostType,
              duration: boost.duration,
              resources: boost.appliedChange
            });

            updated = true;
          }
        }

        // Remove expired boosts
        for (const boostId of expiredBoostIds) {
          delete boosts[boostId];
        }

        // If all boosts for server expired, remove server entry
        if (Object.keys(boosts).length === 0) {
          delete activeBoosts[serverId];
        }
      }

      // Save updated active boosts
      if (updated) {
        await this.db.set("active-boosts", activeBoosts);
      }
    } catch (err) {
      console.error('[BOOST] Error in checkExpiredBoosts:', err);
    }
  }

  async getAvailableBoosts() {
    return this.BOOST_TYPES;
  }

  async getServerActiveBoosts(serverId) {
    const activeBoosts = await this.db.get("active-boosts") || {};
    return activeBoosts[serverId] || {};
  }

  async getUserActiveBoosts(userId) {
    const activeBoosts = await this.db.get("active-boosts") || {};
    const userBoosts = {};

    // Find all boosts belonging to the user
    for (const [serverId, boosts] of Object.entries(activeBoosts)) {
      for (const [boostId, boost] of Object.entries(boosts)) {
        if (boost.userId === userId) {
          if (!userBoosts[serverId]) {
            userBoosts[serverId] = {};
          }
          userBoosts[serverId][boostId] = boost;
        }
      }
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
      const userCoins = await this.db.get(`coins-${userId}`) || 0;
      const boostPrice = boostConfig.prices[duration];

      if (userCoins < boostPrice) {
        throw new BoostError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Check if server already has this type of boost active
      const activeBoosts = await this.getServerActiveBoosts(serverId);

      for (const boost of Object.values(activeBoosts)) {
        if (boost.boostType === boostType) {
          throw new BoostError('Server already has this boost type active', 'BOOST_ALREADY_ACTIVE');
        }
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

      // Deduct coins from user
      const newBalance = userCoins - boostPrice;
      await this.db.set(`coins-${userId}`, newBalance);

      // Create boost record
      const boostId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const boost = {
        id: boostId,
        userId,
        serverId,
        serverName: serverAttributes.name,
        boostType,
        duration,
        durationMs,
        appliedAt: Date.now(),
        expiresAt: Date.now() + durationMs,
        price: boostPrice,
        appliedChange,
        initialResources: {
          memory: initialLimits.memory,
          cpu: initialLimits.cpu,
          disk: initialLimits.disk
        },
        boostedResources: newLimits
      };

      // Save the boost
      const allActiveBoosts = await this.db.get("active-boosts") || {};
      if (!allActiveBoosts[serverId]) {
        allActiveBoosts[serverId] = {};
      }
      allActiveBoosts[serverId][boostId] = boost;
      await this.db.set("active-boosts", allActiveBoosts);

      // Log the boost activity
      await this.logBoostActivity(userId, serverId, 'applied', {
        boostType,
        duration,
        expiresAt: boost.expiresAt,
        price: boostPrice,
        resources: appliedChange
      });

      return {
        boost,
        newBalance
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
      // Get the active boosts
      const activeBoosts = await this.db.get("active-boosts") || {};
      const serverBoosts = activeBoosts[serverId] || {};
      const boost = serverBoosts[boostId];

      if (!boost) {
        throw new BoostError('Boost not found', 'BOOST_NOT_FOUND');
      }

      // Verify ownership
      if (boost.userId !== userId) {
        throw new BoostError('You do not own this boost', 'NOT_OWNER');
      }

      // Calculate refund amount (proportional to remaining time)
      const now = Date.now();
      const elapsed = now - boost.appliedAt;
      const total = boost.durationMs;
      const remaining = Math.max(0, total - elapsed);

      // Refund 50% of the proportional remaining value
      const refundPercent = (remaining / total) * 0.5;
      const refundAmount = Math.floor(boost.price * refundPercent);

      // Revert server resources
      await this.revertServerResources(serverId, boost);

      // Remove boost
      delete serverBoosts[boostId];
      if (Object.keys(serverBoosts).length === 0) {
        delete activeBoosts[serverId];
      }
      await this.db.set("active-boosts", activeBoosts);

      // Add refund to user balance
      const userCoins = await this.db.get(`coins-${userId}`) || 0;
      const newBalance = userCoins + refundAmount;
      await this.db.set(`coins-${userId}`, newBalance);

      // Log cancellation
      await this.logBoostActivity(userId, serverId, 'cancelled', {
        boostType: boost.boostType,
        duration: boost.duration,
        refundAmount,
        resources: boost.appliedChange
      });

      return {
        refundAmount,
        newBalance
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
      // Get the active boosts
      const activeBoosts = await this.db.get("active-boosts") || {};
      const serverBoosts = activeBoosts[serverId] || {};
      const boost = serverBoosts[boostId];

      if (!boost) {
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
      const userCoins = await this.db.get(`coins-${userId}`) || 0;
      if (userCoins < extensionPrice) {
        throw new BoostError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Calculate new expiry time
      const durationInHours = parseInt(additionalDuration.replace('h', ''));
      const additionalMs = durationInHours * 60 * 60 * 1000;
      const newExpiresAt = boost.expiresAt + additionalMs;

      // Update boost expiry time
      boost.expiresAt = newExpiresAt;
      await this.db.set("active-boosts", activeBoosts);

      // Deduct coins
      const newBalance = userCoins - extensionPrice;
      await this.db.set(`coins-${userId}`, newBalance);

      // Log extension
      await this.logBoostActivity(userId, serverId, 'extended', {
        boostType: boost.boostType,
        additionalDuration,
        newExpiresAt,
        price: extensionPrice
      });

      return {
        boost,
        newBalance
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
      const userCoins = await this.db.get(`coins-${userId}`) || 0;
      const boostPrice = boostConfig.prices[duration];

      if (userCoins < boostPrice) {
        throw new BoostError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Create scheduled boost record
      const scheduledBoostId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const scheduledBoost = {
        id: scheduledBoostId,
        userId,
        serverId,
        serverName: serverAttributes.name,
        boostType,
        duration,
        price: boostPrice,
        scheduledTime,
        createdAt: now
      };

      // Save the scheduled boost
      const scheduledBoosts = await this.db.get("scheduled-boosts") || [];
      scheduledBoosts.push(scheduledBoost);
      await this.db.set("scheduled-boosts", scheduledBoosts);

      // Deduct coins
      const newBalance = userCoins - boostPrice;
      await this.db.set(`coins-${userId}`, newBalance);

      // Log the scheduled boost
      await this.logBoostActivity(userId, serverId, 'scheduled', {
        boostType,
        duration,
        scheduledTime,
        price: boostPrice
      });

      return {
        scheduledBoost,
        newBalance
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
      const allScheduledBoosts = await this.db.get("scheduled-boosts") || [];
      return allScheduledBoosts.filter(boost => boost.userId === userId);
    } catch (err) {
      console.error('[BOOST] Error getting scheduled boosts:', err);
      throw new BoostError('Failed to get scheduled boosts', 'INTERNAL_ERROR');
    }
  }

  async cancelScheduledBoost(userId, scheduledBoostId) {
    try {
      const scheduledBoosts = await this.db.get("scheduled-boosts") || [];
      const boostIndex = scheduledBoosts.findIndex(boost =>
        boost.id === scheduledBoostId && boost.userId === userId
      );

      if (boostIndex === -1) {
        throw new BoostError('Scheduled boost not found', 'BOOST_NOT_FOUND');
      }

      const boost = scheduledBoosts[boostIndex];

      // Remove from scheduled boosts
      scheduledBoosts.splice(boostIndex, 1);
      await this.db.set("scheduled-boosts", scheduledBoosts);

      // Refund full amount
      const userCoins = await this.db.get(`coins-${userId}`) || 0;
      const newBalance = userCoins + boost.price;
      await this.db.set(`coins-${userId}`, newBalance);

      // Log cancellation
      await this.logBoostActivity(userId, boost.serverId, 'scheduled_cancelled', {
        boostType: boost.boostType,
        duration: boost.duration,
        scheduledTime: boost.scheduledTime,
        refundAmount: boost.price
      });

      return {
        refundAmount: boost.price,
        newBalance
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
      const history = await this.db.get(`boost-history-${userId}`) || [];
      return history.slice(0, limit);
    } catch (err) {
      console.error('[BOOST] Error getting boost history:', err);
      throw new BoostError('Failed to get boost history', 'INTERNAL_ERROR');
    }
  }

  async logBoostActivity(userId, serverId, type, details) {
    try {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        userId,
        serverId,
        type,
        details,
        timestamp: Date.now()
      };

      const history = await this.db.get(`boost-history-${userId}`) || [];
      history.unshift(entry); // Add to beginning (newest first)

      // Keep history size reasonable (100 entries max)
      if (history.length > 100) {
        history.splice(100);
      }

      await this.db.set(`boost-history-${userId}`, history);
      return entry;
    } catch (err) {
      console.error('[BOOST] Error logging boost activity:', err);
    }
  }

  // Helper function to update server resources via Pterodactyl API
  async updateServerResources(serverId, newLimits) {
    try {
      await pteroApi.patch(`/api/application/servers/${serverId}/build`, {
        memory: newLimits.memory,
        swap: 0,
        disk: newLimits.disk,
        io: 500,
        cpu: newLimits.cpu
      });

      return true;
    } catch (err) {
      console.error('[BOOST] Error updating server resources:', err.response?.data || err.message);
      return false;
    }
  }

  // Helper function to revert server resources to original values
  async revertServerResources(serverId, boost) {
    try {
      return await this.updateServerResources(serverId, {
        memory: boost.initialResources.memory,
        cpu: boost.initialResources.cpu,
        disk: boost.initialResources.disk
      });
    } catch (err) {
      console.error('[BOOST] Error reverting server resources:', err);
      return false;
    }
  }
}

module.exports.load = function (app, db) {
  const boostManager = new BoostManager(db);

  // ==== API ENDPOINTS ====

  // Get available boost types
  app.get('/api/boosts/types', async (req, res) => {
    try {
      const boostTypes = await boostManager.getAvailableBoosts();
      res.json(boostTypes);
    } catch (error) {
      console.error('[BOOST] Error getting boost types:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get active boosts for a server
  app.get('/api/boosts/server/:serverId', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const { serverId } = req.params;
      const activeBoosts = await boostManager.getServerActiveBoosts(serverId);

      // Only return boosts owned by the requesting user
      const userBoosts = {};
      for (const [boostId, boost] of Object.entries(activeBoosts)) {
        if (boost.userId === req.session.userinfo.id) {
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
  app.get('/api/boosts/active', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const activeBoosts = await boostManager.getUserActiveBoosts(userId);

      res.json(activeBoosts);
    } catch (error) {
      console.error('[BOOST] Error getting user boosts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get scheduled boosts
  app.get('/api/boosts/scheduled', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const scheduledBoosts = await boostManager.getScheduledBoosts(userId);

      res.json(scheduledBoosts);
    } catch (error) {
      console.error('[BOOST] Error getting scheduled boosts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get boost history
  app.get('/api/boosts/history', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const limit = req.query.limit ? parseInt(req.query.limit) : 20;

      const history = await boostManager.getBoostHistory(userId, limit);

      res.json(history);
    } catch (error) {
      console.error('[BOOST] Error getting boost history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Apply boost to a server
  app.post('/api/boosts/apply', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { serverId, boostType, duration } = req.body;

      if (!serverId || !boostType || !duration) {
        return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
      }

      // Fetch server info to get current resources
      try {
        const serverInfoResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
        const serverInfo = serverInfoResponse.data;

        // Verify server ownership
        if (serverInfo.attributes.user !== parseInt(await db.get(`users-${userId}`))) {
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
  app.post('/api/boosts/cancel', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { serverId, boostId } = req.body;

      if (!serverId || !boostId) {
        return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
      }

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
  app.post('/api/boosts/extend', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { serverId, boostId, additionalDuration } = req.body;

      if (!serverId || !boostId || !additionalDuration) {
        return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
      }

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
  app.post('/api/boosts/schedule', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { serverId, boostType, duration, scheduledTime } = req.body;

      if (!serverId || !boostType || !duration || !scheduledTime) {
        return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
      }

      // Fetch server info to get current resources
      try {
        const serverInfoResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
        const serverInfo = serverInfoResponse.data;

        // Verify server ownership
        if (serverInfo.attributes.user !== parseInt(await db.get(`users-${userId}`))) {
          return res.status(403).json({ error: 'You do not own this server', code: 'NOT_OWNER' });
        }

        const result = await boostManager.scheduleBoost(
          userId,
          serverId,
          serverInfo.attributes,
          boostType,
          duration,
          parseInt(scheduledTime)
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
  app.post('/api/boosts/cancel-scheduled', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { scheduledBoostId } = req.body;

      if (!scheduledBoostId) {
        return res.status(400).json({ error: 'Missing scheduled boost ID', code: 'MISSING_FIELDS' });
      }

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
      const now = Date.now();
      const scheduledBoosts = await db.get("scheduled-boosts") || [];
      const dueBoosts = scheduledBoosts.filter(boost => boost.scheduledTime <= now);

      if (dueBoosts.length > 0) {
        // Remove due boosts from the scheduled list
        const updatedScheduledBoosts = scheduledBoosts.filter(boost => boost.scheduledTime > now);
        await db.set("scheduled-boosts", updatedScheduledBoosts);

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

            await boostManager.logBoostActivity(boost.userId, boost.serverId, 'scheduled_applied', {
              scheduledTime: boost.scheduledTime,
              appliedTime: now,
              ...boost
            });
          } catch (err) {
            console.error(`[BOOST] Error applying scheduled boost:`, err);

            // Refund the user
            const userCoins = await db.get(`coins-${boost.userId}`) || 0;
            await db.set(`coins-${boost.userId}`, userCoins + boost.price);

            await boostManager.logBoostActivity(boost.userId, boost.serverId, 'scheduled_failed', {
              reason: err.message || 'Unknown error',
              refundAmount: boost.price,
              ...boost
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
