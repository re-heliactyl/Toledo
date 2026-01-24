const indexjs = require("../app.js");
const fs = require("fs");
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");

const HeliactylModule = {
  "name": "Staking",
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

class StakingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StakingError';
    this.code = code;
  }
}

class StakingManager {
  constructor(db) {
    this.db = db;

    // Define staking plans with increasing rates
    this.STAKING_PLANS = {
      flexible: {
        id: 'flexible',
        name: 'Flexible',
        apy: 15, // 15% APY
        minDuration: 0, // No minimum duration
        penaltyPercent: 0, // No penalty
        minAmount: 100
      },
      bronze: {
        id: 'bronze',
        name: 'Bronze',
        apy: 25, // 25% APY
        minDuration: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
        penaltyPercent: 20, // 20% penalty for early withdrawal
        minAmount: 250
      },
      silver: {
        id: 'silver',
        name: 'Silver',
        apy: 40, // 40% APY
        minDuration: 14 * 24 * 60 * 60 * 1000, // 14 days in ms
        penaltyPercent: 30, // 30% penalty for early withdrawal
        minAmount: 500
      },
      gold: {
        id: 'gold',
        name: 'Gold',
        apy: 60, // 60% APY
        minDuration: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
        penaltyPercent: 40, // 40% penalty for early withdrawal
        minAmount: 1000
      },
      platinum: {
        id: 'platinum',
        name: 'Platinum',
        apy: 80, // 80% APY
        minDuration: 60 * 24 * 60 * 60 * 1000, // 60 days in ms
        penaltyPercent: 50, // 50% penalty for early withdrawal
        minAmount: 2500
      }
    };

    // Create scheduled rewards processor
    this.REWARDS_INTERVAL_MS = 24 * 60 * 60 * 1000; // Process rewards daily
    this.startDailyRewardsProcessor();

    // Keep track of active staking users with a single key
    this.initializeActiveUsers();
  }

  async initializeActiveUsers() {
    // Initialize the active users list if it doesn't exist
    const activeUsers = await this.db.get("staking-active-users");
    if (!activeUsers) {
      await this.db.set("staking-active-users", []);
    }
  }

  async addActiveUser(userId) {
    const activeUsers = await this.db.get("staking-active-users") || [];
    if (!activeUsers.includes(userId)) {
      activeUsers.push(userId);
      await this.db.set("staking-active-users", activeUsers);
    }
  }

  async removeActiveUser(userId) {
    const stakes = await this.db.get(`stakes-${userId}`) || [];
    const activeStakes = stakes.filter(stake => stake.status === 'active');

    // Only remove from active users if they have no more active stakes
    if (activeStakes.length === 0) {
      const activeUsers = await this.db.get("staking-active-users") || [];
      const updatedUsers = activeUsers.filter(id => id !== userId);
      await this.db.set("staking-active-users", updatedUsers);
    }
  }

  startDailyRewardsProcessor() {
    // Process rewards for all active stakes daily
    setInterval(() => {
      this.processAllStakingRewards()
        .catch(err => console.error(' Error processing daily rewards:', err));
    }, this.REWARDS_INTERVAL_MS);

    // Also process immediately on startup
    this.processAllStakingRewards()
      .catch(err => console.error(' Error processing startup rewards:', err));
  }

  async processAllStakingRewards() {
    try {
      // Get all users with active stakes
      const activeUsers = await this.db.get("staking-active-users") || [];

      for (const userId of activeUsers) {
        try {
          const stakes = await this.db.get(`stakes-${userId}`) || [];
          let updated = false;

          // Process each stake
          for (let i = 0; i < stakes.length; i++) {
            const stake = stakes[i];

            // Skip stakes that are already claimed
            if (stake.status === 'claimed') continue;

            // Calculate time since last reward
            const now = Date.now();
            const timeSinceLastReward = now - stake.lastRewardTime;

            // Only process if at least a day has passed since last reward
            if (timeSinceLastReward >= 24 * 60 * 60 * 1000) {
              // Calculate daily rewards (APY / 365)
              const plan = this.STAKING_PLANS[stake.planId];
              const dailyRate = plan.apy / 365 / 100;
              const dailyReward = stake.amount * dailyRate;

              // Update stake with new rewards
              stake.accruedRewards += dailyReward;
              stake.lastRewardTime = now;
              updated = true;
            }
          }

          // Save updated stakes if any changes were made
          if (updated) {
            await this.db.set(`stakes-${userId}`, stakes);
          }
        } catch (err) {
          console.error(` Error processing rewards for user ${userId}:`, err);
        }
      }
    } catch (err) {
      console.error(' Error getting active users:', err);
    }
  }

  async createStake(userId, planId, amount) {
    // Validate plan
    const plan = this.STAKING_PLANS[planId];
    if (!plan) {
      throw new StakingError('Invalid staking plan', 'INVALID_PLAN');
    }

    // Validate amount
    if (!Number.isFinite(amount) || amount < plan.minAmount) {
      throw new StakingError(`Minimum stake amount is ${plan.minAmount} coins`, 'INSUFFICIENT_AMOUNT');
    }

    // Check user balance
    const userCoins = await this.db.get(`coins-${userId}`) || 0;
    if (userCoins < amount) {
      throw new StakingError('Insufficient balance', 'INSUFFICIENT_BALANCE');
    }

    // Create stake record
    const stakeId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const stake = {
      id: stakeId,
      userId,
      planId,
      amount,
      createdAt: Date.now(),
      lastRewardTime: Date.now(),
      accruedRewards: 0,
      status: 'active',
      endTime: plan.minDuration > 0 ? Date.now() + plan.minDuration : null
    };

    // Update user's stakes
    const stakes = await this.db.get(`stakes-${userId}`) || [];
    stakes.push(stake);
    await this.db.set(`stakes-${userId}`, stakes);

    // Add user to active staking users
    await this.addActiveUser(userId);

    // Deduct coins from user's balance
    const newBalance = userCoins - amount;
    await this.db.set(`coins-${userId}`, newBalance);

    // Return new stake and updated balance
    return {
      stake,
      balance: newBalance
    };
  }

  async claimStake(userId, stakeId) {
    // Get user's stakes
    const stakes = await this.db.get(`stakes-${userId}`) || [];
    const stakeIndex = stakes.findIndex(s => s.id === stakeId);

    if (stakeIndex === -1) {
      throw new StakingError('Stake not found', 'STAKE_NOT_FOUND');
    }

    const stake = stakes[stakeIndex];

    if (stake.status !== 'active') {
      throw new StakingError('Stake is not active', 'STAKE_NOT_ACTIVE');
    }

    // Calculate if early withdrawal
    const plan = this.STAKING_PLANS[stake.planId];
    const isEarlyWithdrawal = plan.minDuration > 0 &&
      Date.now() < stake.createdAt + plan.minDuration;

    // Calculate total amount to return to user
    let totalReward = stake.amount + stake.accruedRewards;
    let penalty = 0;

    if (isEarlyWithdrawal) {
      penalty = stake.amount * (plan.penaltyPercent / 100);
      totalReward -= penalty;
    }

    // Update user balance
    const userCoins = await this.db.get(`coins-${userId}`) || 0;
    const newBalance = userCoins + totalReward;
    await this.db.set(`coins-${userId}`, newBalance);

    // Update stake status
    stake.status = 'claimed';
    stake.claimedAt = Date.now();
    stake.returnedAmount = totalReward;
    stake.penalty = penalty;

    await this.db.set(`stakes-${userId}`, stakes);

    // Check if user still has active stakes and update active users list
    await this.removeActiveUser(userId);

    // Log transaction
    await this.logTransaction(userId, 'claim', {
      stakeId,
      amount: stake.amount,
      rewards: stake.accruedRewards,
      penalty,
      totalReturned: totalReward
    });

    return {
      stake,
      balance: newBalance
    };
  }

  async getUserStakes(userId) {
    const stakes = await this.db.get(`stakes-${userId}`) || [];

    // Add plan details to each stake
    return stakes.map(stake => {
      const plan = this.STAKING_PLANS[stake.planId];
      return {
        ...stake,
        planDetails: plan
      };
    });
  }

  async getAvailablePlans() {
    return this.STAKING_PLANS;
  }

  async getStakingSummary(userId) {
    const stakes = await this.db.get(`stakes-${userId}`) || [];
    const userCoins = await this.db.get(`coins-${userId}`) || 0;

    // Calculate totals
    const activeStakes = stakes.filter(s => s.status === 'active');
    const totalStaked = activeStakes.reduce((sum, stake) => sum + stake.amount, 0);
    const totalRewards = activeStakes.reduce((sum, stake) => sum + stake.accruedRewards, 0);

    return {
      totalStaked,
      totalRewards,
      activeStakesCount: activeStakes.length,
      totalStakesCount: stakes.length,
      availableBalance: userCoins
    };
  }

  async logTransaction(userId, type, details) {
    const transaction = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      userId,
      type,
      details,
      timestamp: Date.now()
    };

    const history = await this.db.get(`staking-history-${userId}`) || [];
    history.push(transaction);
    await this.db.set(`staking-history-${userId}`, history);

    return transaction;
  }
}

module.exports.load = function (app, db) {
  const stakingManager = new StakingManager(db);

  // ==== API ENDPOINTS ====

  // Get available staking plans
  app.get('/api/staking/plans', async (req, res) => {
    try {
      const plans = await stakingManager.getAvailablePlans();
      res.json(plans);
    } catch (error) {
      console.error('[API] [STAKING] Error getting plans:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Get user's stakes
  app.get('/api/staking/stakes', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const stakes = await stakingManager.getUserStakes(userId);
      res.json(stakes);
    } catch (error) {
      console.error('[API] [STAKING] Error getting stakes:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Get user's staking summary
  app.get('/api/staking/summary', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const summary = await stakingManager.getStakingSummary(userId);
      res.json(summary);
    } catch (error) {
      console.error('[API] [STAKING] Error getting summary:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Create a new stake
  app.post('/api/staking/stakes', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { planId, amount } = req.body;

      if (!planId || !amount) {
        return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
      }

      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount)) {
        return res.status(400).json({ error: 'Invalid amount', code: 'INVALID_AMOUNT' });
      }

      const result = await stakingManager.createStake(userId, planId, numericAmount);

      res.json({
        success: true,
        stake: result.stake,
        balance: result.balance
      });
    } catch (error) {
      if (error instanceof StakingError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error(' Error creating stake:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Claim a stake
  app.post('/api/staking/stakes/:stakeId/claim', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const { stakeId } = req.params;

      const result = await stakingManager.claimStake(userId, stakeId);

      res.json({
        success: true,
        stake: result.stake,
        balance: result.balance
      });
    } catch (error) {
      if (error instanceof StakingError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error(' Error claiming stake:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get staking transaction history
  app.get('/api/staking/history', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const history = await db.get(`staking-history-${userId}`) || [];

      res.json(history);
    } catch (error) {
      console.error(' Error getting history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get projected earnings for a potential stake
  app.get('/api/staking/calculate', async (req, res) => {
    try {
      const { planId, amount, duration } = req.query;

      if (!planId || !amount) {
        return res.status(400).json({ error: 'Missing required parameters', code: 'MISSING_PARAMS' });
      }

      const plan = stakingManager.STAKING_PLANS[planId];
      if (!plan) {
        return res.status(400).json({ error: 'Invalid plan', code: 'INVALID_PLAN' });
      }

      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount < plan.minAmount) {
        return res.status(400).json({
          error: `Minimum amount is ${plan.minAmount}`,
          code: 'INVALID_AMOUNT'
        });
      }

      // Calculate projected earnings
      const durationDays = parseInt(duration) || 30; // Default to 30 days
      const dailyRate = plan.apy / 365 / 100;
      const projectedRewards = numericAmount * dailyRate * durationDays;
      const totalReturn = numericAmount + projectedRewards;

      res.json({
        plan,
        initialAmount: numericAmount,
        durationDays,
        projectedRewards,
        totalReturn,
        dailyReward: numericAmount * dailyRate,
        monthlyReward: numericAmount * dailyRate * 30,
        yearlyReward: numericAmount * (plan.apy / 100)
      });
    } catch (error) {
      console.error(' Error calculating earnings:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get active staking users (admin only)
  app.get('/api/admin/staking/active-users', async (req, res) => {
    try {
      if (!req.session.userinfo || !req.session.pterodactyl || req.session.pterodactyl.root_admin !== true) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const activeUsers = await db.get("staking-active-users") || [];
      res.json({ activeUsers });
    } catch (error) {
      console.error(' Error getting active users:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
};