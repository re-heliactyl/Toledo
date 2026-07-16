const fs = require("fs");
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');
const { triggerAchievement } = require('./achievements');

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
      // Get all active stakes
      const activeStakes = await this.db.stake.findMany({
        where: { status: 'active' }
      });

      for (const stake of activeStakes) {
        try {
          const now = new Date();
          const lastRewardAt = new Date(stake.lastRewardAt);
          const timeSinceLastReward = now.getTime() - lastRewardAt.getTime();

          // Only process if at least a day has passed since last reward
          if (timeSinceLastReward >= 24 * 60 * 60 * 1000) {
            // Calculate daily rewards (APY / 365)
            const plan = this.STAKING_PLANS[stake.planId];
            if (!plan) continue;
            
            const dailyRate = plan.apy / 365 / 100;
            const dailyReward = stake.amount * dailyRate;

            // Update stake with new rewards
            await this.db.stake.update({
              where: { id: stake.id },
              data: {
                accruedRewards: { increment: dailyReward },
                lastRewardAt: now
              }
            });
          }
        } catch (err) {
          console.error(` Error processing rewards for stake ${stake.id}:`, err);
        }
      }
    } catch (err) {
      console.error(' Error getting active stakes:', err);
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

    // Check user balance and create stake in transaction
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { coins: true }
    });

    if (!user || user.coins < amount) {
      throw new StakingError('Insufficient balance', 'INSUFFICIENT_BALANCE');
    }

    const [updatedUser, stake] = await this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: { coins: { decrement: amount } }
      }),
      this.db.stake.create({
        data: {
          userId,
          planId,
          amount,
          status: 'active',
          lastRewardAt: new Date(),
          endTime: plan.minDuration > 0 ? new Date(Date.now() + plan.minDuration) : null
        }
      })
    ]);

    // Log wallet transaction
    await this.logWalletTransaction(userId, 'stake_create', `Staked in ${plan.name}`, -amount, {
      stakeId: stake.id,
      planId,
      amount
    });
    
    return {
      stake: {
        ...stake,
        createdAt: stake.createdAt.getTime(),
        lastRewardTime: stake.lastRewardAt.getTime(),
        endTime: stake.endTime?.getTime()
      },
      balance: updatedUser.coins
    };
  }

  async claimStake(userId, stakeId) {
    const stake = await this.db.stake.findFirst({
      where: { id: stakeId, userId }
    });

    if (!stake) {
      throw new StakingError('Stake not found', 'STAKE_NOT_FOUND');
    }

    if (stake.status !== 'active') {
      throw new StakingError('Stake is not active', 'STAKE_NOT_ACTIVE');
    }

    // Calculate if early withdrawal
    const plan = this.STAKING_PLANS[stake.planId];
    const createdAtTime = stake.createdAt.getTime();
    const isEarlyWithdrawal = plan.minDuration > 0 &&
      Date.now() < createdAtTime + plan.minDuration;

    // Calculate total amount to return to user
    let totalReward = stake.amount + stake.accruedRewards;
    let penalty = 0;

    if (isEarlyWithdrawal) {
      penalty = stake.amount * (plan.penaltyPercent / 100);
      totalReward -= penalty;
    }

    // Update status and balance in transaction
    const [updatedUser, updatedStake] = await this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: { coins: { increment: Math.floor(totalReward) } }
      }),
      this.db.stake.update({
        where: { id: stakeId },
        data: {
          status: 'completed',
          claimedAt: new Date(),
          returnedAmount: Math.floor(totalReward),
          penalty
        }
      })
    ]);

    // Log wallet transaction
    await this.logWalletTransaction(userId, 'stake_claim', `Claimed Stake (Reward: ${stake.accruedRewards.toFixed(2)})`, Math.floor(totalReward), {
      stakeId,
      amount: stake.amount,
      rewards: stake.accruedRewards,
      penalty,
      totalReturned: totalReward
    });

    return {
      stake: {
        ...updatedStake,
        createdAt: updatedStake.createdAt.getTime(),
        lastRewardTime: updatedStake.lastRewardAt.getTime(),
        claimedAt: updatedStake.claimedAt?.getTime(),
        endTime: updatedStake.endTime?.getTime()
      },
      balance: updatedUser.coins
    };
  }

  async getUserStakes(userId) {
    const stakes = await this.db.stake.findMany({
      where: { userId }
    });

    return stakes.map(stake => {
      const plan = this.STAKING_PLANS[stake.planId];
      return {
        ...stake,
        createdAt: stake.createdAt.getTime(),
        lastRewardTime: stake.lastRewardAt.getTime(),
        endTime: stake.endTime?.getTime(),
        claimedAt: stake.claimedAt?.getTime(),
        planDetails: plan
      };
    });
  }

  async getAvailablePlans() {
    return this.STAKING_PLANS;
  }

  async getStakingSummary(userId) {
    const stakes = await this.db.stake.findMany({
      where: { userId }
    });

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { coins: true }
    });

    const activeStakes = stakes.filter(s => s.status === 'active');
    const totalStaked = activeStakes.reduce((sum, stake) => sum + stake.amount, 0);
    const totalRewards = activeStakes.reduce((sum, stake) => sum + stake.accruedRewards, 0);

    return {
      totalStaked,
      totalRewards,
      activeStakesCount: activeStakes.length,
      totalStakesCount: stakes.length,
      availableBalance: user?.coins ?? 0
    };
  }

  async logWalletTransaction(userId, type, description, amount, details) {
    try {
      await this.db.transaction.create({
        data: {
          userId,
          type,
          amount,
          description,
          details: JSON.stringify(details)
        }
      });
    } catch (err) {
      console.error('[STAKING] Error logging transaction:', err);
    }
  }
}

module.exports.load = function (app, db) {
  const stakingManager = new StakingManager(db);
  const authz = createAuthz(db);

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
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
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
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const summary = await stakingManager.getStakingSummary(userId);
      res.json(summary);
    } catch (error) {
      console.error('[API] [STAKING] Error getting summary:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Create a new stake
  app.post('/api/staking/stakes', validate(schemas.stakingCreate), async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const { planId, amount } = req.body;
      const numericAmount = parseFloat(amount);

      const result = await stakingManager.createStake(userId, planId, numericAmount);

      res.json({
        success: true,
        stake: result.stake,
        balance: result.balance
      });

      // Trigger achievement
      try {
        await triggerAchievement(db, userId, 'stake_coins');
      } catch (achError) {
        console.error('Failed to trigger stake_coins achievement:', achError);
      }
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
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
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
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const transactions = await db.transaction.findMany({
        where: {
          userId,
          type: { in: ['stake_create', 'stake_claim'] }
        },
        orderBy: { createdAt: 'desc' }
      });

      res.json(transactions.map(txn => ({
        id: txn.id,
        userId: txn.userId,
        type: txn.type,
        details: JSON.parse(txn.details),
        amount: txn.amount,
        timestamp: txn.createdAt.getTime()
      })));
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
      if (!authz.hasUserSession(req) || !authz.hasPterodactylSession(req) || !await authz.getAdminStatus(req)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const activeStakes = await db.stake.findMany({
        where: { status: 'active' },
        distinct: ['userId'],
        select: { userId: true }
      });
      
      const activeUsers = activeStakes.map(s => s.userId);
      res.json({ activeUsers });
    } catch (error) {
      console.error(' Error getting active users:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
};
