const indexjs = require("../app.js");
const fs = require("fs");
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");

const HeliactylModule = {
  "name": "Daily Rewards",
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

class DailyRewardsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DailyRewardsError';
    this.code = code;
  }
}

class DailyRewardsManager {
  constructor(db) {
    this.db = db;

    // Configure reward tiers for daily login streaks
    this.DAILY_REWARDS = {
      baseAmount: 25, // Base daily reward amount
      streakMultipliers: {
        // Days 1-6
        1: 1.0,
        2: 1.0,
        3: 1.1,
        4: 1.1,
        5: 1.2,
        6: 1.2,
        // Week milestone
        7: 1.5, // 50% bonus for 7-day streak
        // Days 8-13
        8: 1.2,
        9: 1.2,
        10: 1.3,
        11: 1.3,
        12: 1.4,
        13: 1.4,
        // Two-week milestone
        14: 1.75, // 75% bonus for 14-day streak
        // Days 15-20
        15: 1.4,
        16: 1.4,
        17: 1.5,
        18: 1.5,
        19: 1.6,
        20: 1.6,
        // Three-week milestone
        21: 2.0, // 100% bonus for 21-day streak
        // Days 22-27
        22: 1.6,
        23: 1.6,
        24: 1.7,
        25: 1.7,
        26: 1.8,
        27: 1.8,
        // Four-week milestone
        28: 2.5, // 150% bonus for 28-day streak
        // Days 29+
        29: 1.8,
        30: 2.0, // 30-day milestone
      },
      // Special rewards at milestones
      milestoneRewards: {
        7: {
          bonus: 50,
          message: 'Weekly streak bonus! +50 coins'
        },
        14: {
          bonus: 100,
          message: 'Two-week streak bonus! +100 coins'
        },
        21: {
          bonus: 150,
          message: 'Three-week streak bonus! +150 coins'
        },
        28: {
          bonus: 200,
          message: 'Four-week streak bonus! +200 coins'
        },
        30: {
          bonus: 300,
          message: 'Monthly streak bonus! +300 coins',
          streakProtection: true
        },
        60: {
          bonus: 600,
          message: 'Two-month streak bonus! +600 coins',
          streakProtection: true
        },
        90: {
          bonus: 1000,
          message: 'Three-month streak bonus! +1000 coins',
          streakProtection: true
        }
      },
      // Maximum number of days before streak resets
      maxStreakGap: 1, // 1 day gap allowed before streak resets
      // Streak protection durations (days)
      streakProtection: {
        bronze: 1,  // Bronze protection: 1 day grace period
        silver: 3,  // Silver protection: 3 day grace period
        gold: 7     // Gold protection: 7 day grace period
      }
    };
  }

  /**
   * Claim daily reward for a user
   * @param {string} userId - User ID
   * @returns {Object} - Reward details
   */
  async claimDailyReward(userId) {
    try {
      // Get user's streak info
      const streakInfo = await this.getUserStreakInfo(userId);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      // Check if user has already claimed today
      if (streakInfo.lastClaimTimestamp === today) {
        throw new DailyRewardsError('You already claimed your daily reward today', 'ALREADY_CLAIMED');
      }

      // Calculate days since last claim
      const daysSinceLastClaim = this.calculateDaysSinceLastClaim(streakInfo.lastClaimTimestamp);

      // Check if streak is maintained or should reset
      let newStreak = 0;
      let streakMaintained = false;
      let streakProtectionUsed = false;

      // If this is first claim or within allowed gap
      if (streakInfo.lastClaimTimestamp === 0 || daysSinceLastClaim <= this.DAILY_REWARDS.maxStreakGap) {
        newStreak = streakInfo.currentStreak + 1;
        streakMaintained = true;
      }
      // Check if streak protection can be applied
      else if (streakInfo.streakProtection && streakInfo.streakProtection > 0) {
        if (daysSinceLastClaim <= streakInfo.streakProtection) {
          newStreak = streakInfo.currentStreak + 1;
          streakMaintained = true;
          streakProtectionUsed = true;

          // Use up one streak protection day
          streakInfo.streakProtection--;
        } else {
          // Protection not applicable, reset streak
          newStreak = 1;
          streakMaintained = false;
        }
      }
      // No protection, reset streak
      else {
        newStreak = 1;
        streakMaintained = false;
      }

      // Calculate reward amount
      const rewardDetails = this.calculateRewardAmount(newStreak);
      const totalReward = rewardDetails.amount;

      // Add reward to user's coins
      const currentCoins = await this.db.get(`coins-${userId}`) || 0;
      const newBalance = currentCoins + totalReward;
      await this.db.set(`coins-${userId}`, newBalance);

      // Check for milestone rewards that add streak protection
      if (rewardDetails.milestone && rewardDetails.milestone.streakProtection) {
        // Add bronze protection for milestone rewards that include it
        if (!streakInfo.streakProtection || streakInfo.streakProtection < this.DAILY_REWARDS.streakProtection.bronze) {
          streakInfo.streakProtection = this.DAILY_REWARDS.streakProtection.bronze;
        }
      }

      // Update user's streak info
      const updatedStreakInfo = {
        currentStreak: newStreak,
        longestStreak: Math.max(newStreak, streakInfo.longestStreak || 0),
        lastClaimTimestamp: today,
        totalClaimed: (streakInfo.totalClaimed || 0) + 1,
        totalCoinsEarned: (streakInfo.totalCoinsEarned || 0) + totalReward,
        streakProtection: streakInfo.streakProtection || 0
      };

      await this.db.set(`daily-streak-${userId}`, updatedStreakInfo);

      // Log the claim
      await this.logDailyRewardClaim(userId, {
        timestamp: now.getTime(),
        streak: newStreak,
        reward: totalReward,
        streakMaintained,
        streakProtectionUsed,
        baseAmount: rewardDetails.baseAmount,
        multiplier: rewardDetails.multiplier,
        milestoneBonus: rewardDetails.milestoneBonus,
        milestoneMessage: rewardDetails.milestoneMessage
      });

      // Return claim details
      return {
        userId,
        timestamp: now.getTime(),
        streak: newStreak,
        reward: totalReward,
        newBalance,
        streakMaintained,
        streakProtectionUsed,
        streakProtectionRemaining: updatedStreakInfo.streakProtection,
        baseAmount: rewardDetails.baseAmount,
        multiplier: rewardDetails.multiplier,
        milestoneBonus: rewardDetails.milestoneBonus,
        milestoneMessage: rewardDetails.milestoneMessage,
        nextReward: this.calculateRewardAmount(newStreak + 1)
      };
    } catch (err) {
      if (err.name === 'DailyRewardsError') {
        throw err;
      }
      console.error('[DAILY-REWARDS] Error claiming daily reward:', err);
      throw new DailyRewardsError('Failed to claim daily reward', 'INTERNAL_ERROR');
    }
  }

  /**
   * Calculate days since last claim
   * @param {number} lastClaimTimestamp - Timestamp of last claim
   * @returns {number} - Days since last claim
   */
  calculateDaysSinceLastClaim(lastClaimTimestamp) {
    if (!lastClaimTimestamp) return Infinity;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const lastClaimDate = new Date(lastClaimTimestamp);
    const lastClaimDay = new Date(lastClaimDate.getFullYear(), lastClaimDate.getMonth(), lastClaimDate.getDate()).getTime();

    const diffTime = Math.abs(today - lastClaimDay);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
  }

  /**
   * Calculate reward amount based on streak
   * @param {number} streak - Current streak
   * @returns {Object} - Reward details
   */
  calculateRewardAmount(streak) {
    const baseAmount = this.DAILY_REWARDS.baseAmount;
    let multiplier = 1.0;
    let milestoneBonus = 0;
    let milestoneMessage = null;

    // Get streak multiplier, default to the highest defined multiplier for streaks longer than defined
    if (streak <= 30) {
      multiplier = this.DAILY_REWARDS.streakMultipliers[streak] || 2.0;
    } else if (streak > 30 && streak < 60) {
      multiplier = 2.0; // After 30 days, keep at 2.0 until next major milestone
    } else if (streak >= 60 && streak < 90) {
      multiplier = 2.2; // After 60 days
    } else {
      multiplier = 2.5; // After 90 days
    }

    // Check for milestone bonuses
    const milestone = this.DAILY_REWARDS.milestoneRewards[streak];
    if (milestone) {
      milestoneBonus = milestone.bonus;
      milestoneMessage = milestone.message;
    }

    // Calculate total reward
    const amount = Math.floor((baseAmount * multiplier) + milestoneBonus);

    return {
      amount,
      baseAmount,
      multiplier,
      milestoneBonus,
      milestoneMessage,
      milestone
    };
  }

  /**
   * Get user's streak information
   * @param {string} userId - User ID
   * @returns {Object} - Streak info
   */
  async getUserStreakInfo(userId) {
    const streakInfo = await this.db.get(`daily-streak-${userId}`);
    if (!streakInfo) {
      return {
        currentStreak: 0,
        longestStreak: 0,
        lastClaimTimestamp: 0,
        totalClaimed: 0,
        totalCoinsEarned: 0,
        streakProtection: 0
      };
    }
    return streakInfo;
  }

  /**
   * Get user's daily reward claim status
   * @param {string} userId - User ID
   * @returns {Object} - Claim status
   */
  async getClaimStatus(userId) {
    const streakInfo = await this.getUserStreakInfo(userId);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const canClaim = streakInfo.lastClaimTimestamp !== today;
    const daysSinceLastClaim = this.calculateDaysSinceLastClaim(streakInfo.lastClaimTimestamp);

    // Calculate what will happen to streak if claimed now
    let projectedStreak = 0;
    let streakWillMaintain = false;
    let willUseProtection = false;

    if (streakInfo.lastClaimTimestamp === 0 || daysSinceLastClaim <= this.DAILY_REWARDS.maxStreakGap) {
      projectedStreak = streakInfo.currentStreak + 1;
      streakWillMaintain = true;
    } else if (streakInfo.streakProtection && streakInfo.streakProtection > 0 &&
      daysSinceLastClaim <= streakInfo.streakProtection) {
      projectedStreak = streakInfo.currentStreak + 1;
      streakWillMaintain = true;
      willUseProtection = true;
    } else {
      projectedStreak = 1;
      streakWillMaintain = false;
    }

    // Calculate next reward
    const nextReward = this.calculateRewardAmount(projectedStreak);

    return {
      userId,
      canClaim,
      daysSinceLastClaim,
      currentStreak: streakInfo.currentStreak,
      longestStreak: streakInfo.longestStreak,
      lastClaimTimestamp: streakInfo.lastClaimTimestamp,
      totalClaimed: streakInfo.totalClaimed,
      totalCoinsEarned: streakInfo.totalCoinsEarned,
      streakProtection: streakInfo.streakProtection,
      projectedStreak,
      streakWillMaintain,
      willUseProtection,
      nextReward
    };
  }

  /**
   * Purchase streak protection for a user
   * @param {string} userId - User ID
   * @param {string} level - Protection level (bronze, silver, gold)
   * @returns {Object} - Purchase details
   */
  async purchaseStreakProtection(userId, level) {
    try {
      // Validate protection level
      if (!this.DAILY_REWARDS.streakProtection[level]) {
        throw new DailyRewardsError('Invalid protection level', 'INVALID_LEVEL');
      }

      // Get user's streak info
      const streakInfo = await this.getUserStreakInfo(userId);

      // Define prices for protection levels
      const protectionPrices = {
        bronze: 100,  // 1 day protection: 100 coins
        silver: 250,  // 3 day protection: 250 coins
        gold: 500     // 7 day protection: 500 coins
      };

      const price = protectionPrices[level];

      // Check if user already has better protection
      const protectionDays = this.DAILY_REWARDS.streakProtection[level];
      if (streakInfo.streakProtection >= protectionDays) {
        throw new DailyRewardsError('You already have equal or better streak protection', 'ALREADY_PROTECTED');
      }

      // Check if user has enough coins
      const userCoins = await this.db.get(`coins-${userId}`) || 0;
      if (userCoins < price) {
        throw new DailyRewardsError('Insufficient coins', 'INSUFFICIENT_COINS');
      }

      // Deduct coins and update protection
      const newBalance = userCoins - price;
      await this.db.set(`coins-${userId}`, newBalance);

      // Update streak protection
      streakInfo.streakProtection = protectionDays;
      await this.db.set(`daily-streak-${userId}`, streakInfo);

      // Log protection purchase
      await this.logProtectionPurchase(userId, {
        timestamp: Date.now(),
        level,
        protectionDays,
        price,
        newBalance
      });

      return {
        userId,
        level,
        protectionDays,
        price,
        newBalance,
        streakInfo
      };
    } catch (err) {
      if (err.name === 'DailyRewardsError') {
        throw err;
      }
      console.error('[DAILY-REWARDS] Error purchasing streak protection:', err);
      throw new DailyRewardsError('Failed to purchase streak protection', 'INTERNAL_ERROR');
    }
  }

  /**
   * Get streak leaderboard
   * @param {number} limit - Number of entries to return
   * @returns {Array} - Leaderboard entries
   */
  async getStreakLeaderboard(limit = 10) {
    try {
      // Get all streak keys - Note: In a production environment, you'd want to use a more
      // efficient approach than listing all keys, but for this demo it's acceptable
      // You might consider using a separate leaderboard data structure that's updated on claims
      const leaderboard = [];

      // Since db.list() doesn't exist, we'll simulate this with a special "leaderboard" key
      // that will be updated whenever a user's streak changes
      const cachedLeaderboard = await this.db.get('streak-leaderboard') || [];

      // Sort by current streak in descending order
      const sortedLeaderboard = cachedLeaderboard.sort((a, b) => {
        if (b.currentStreak !== a.currentStreak) {
          return b.currentStreak - a.currentStreak;
        }
        // If streaks are equal, sort by longest streak
        if (b.longestStreak !== a.longestStreak) {
          return b.longestStreak - a.longestStreak;
        }
        // If longest streaks are equal, sort by total claimed
        return b.totalClaimed - a.totalClaimed;
      });

      // Return top entries
      return sortedLeaderboard.slice(0, limit);
    } catch (err) {
      console.error('[DAILY-REWARDS] Error getting streak leaderboard:', err);
      throw new DailyRewardsError('Failed to get streak leaderboard', 'INTERNAL_ERROR');
    }
  }

  /**
   * Update leaderboard with user's streak info
   * @param {string} userId - User ID
   * @param {string} username - Username
   * @returns {Promise<void>}
   */
  async updateLeaderboard(userId, username) {
    try {
      const streakInfo = await this.getUserStreakInfo(userId);

      // Get existing leaderboard
      let leaderboard = await this.db.get('streak-leaderboard') || [];

      // Find user's entry
      const existingIndex = leaderboard.findIndex(entry => entry.userId === userId);

      if (existingIndex !== -1) {
        // Update existing entry
        leaderboard[existingIndex] = {
          userId,
          username,
          currentStreak: streakInfo.currentStreak,
          longestStreak: streakInfo.longestStreak,
          totalClaimed: streakInfo.totalClaimed,
          lastUpdated: Date.now()
        };
      } else {
        // Add new entry
        leaderboard.push({
          userId,
          username,
          currentStreak: streakInfo.currentStreak,
          longestStreak: streakInfo.longestStreak,
          totalClaimed: streakInfo.totalClaimed,
          lastUpdated: Date.now()
        });
      }

      // Save updated leaderboard
      await this.db.set('streak-leaderboard', leaderboard);
    } catch (err) {
      console.error('[DAILY-REWARDS] Error updating leaderboard:', err);
    }
  }

  /**
   * Log daily reward claim
   * @param {string} userId - User ID
   * @param {Object} details - Claim details
   * @returns {Promise<void>}
   */
  async logDailyRewardClaim(userId, details) {
    try {
      const logs = await this.db.get(`daily-claims-${userId}`) || [];
      logs.unshift(details); // Add to beginning

      // Keep only most recent 30 claims to prevent excessive storage
      if (logs.length > 30) {
        logs.splice(30);
      }

      await this.db.set(`daily-claims-${userId}`, logs);
    } catch (err) {
      console.error('[DAILY-REWARDS] Error logging claim:', err);
    }
  }

  /**
   * Log protection purchase
   * @param {string} userId - User ID
   * @param {Object} details - Purchase details
   * @returns {Promise<void>}
   */
  async logProtectionPurchase(userId, details) {
    try {
      const logs = await this.db.get(`protection-purchases-${userId}`) || [];
      logs.unshift(details); // Add to beginning

      // Keep only most recent 10 purchases
      if (logs.length > 10) {
        logs.splice(10);
      }

      await this.db.set(`protection-purchases-${userId}`, logs);
    } catch (err) {
      console.error('[DAILY-REWARDS] Error logging protection purchase:', err);
    }
  }

  /**
   * Get user's claim history
   * @param {string} userId - User ID
   * @param {number} limit - Number of entries to return
   * @returns {Array} - Claim history
   */
  async getClaimHistory(userId, limit = 10) {
    try {
      const logs = await this.db.get(`daily-claims-${userId}`) || [];
      return logs.slice(0, limit);
    } catch (err) {
      console.error('[DAILY-REWARDS] Error getting claim history:', err);
      throw new DailyRewardsError('Failed to get claim history', 'INTERNAL_ERROR');
    }
  }
}

module.exports.load = function (app, db) {
  const dailyRewardsManager = new DailyRewardsManager(db);

  // ==== API ENDPOINTS ====

  // Get claim status
  app.get('/api/daily-rewards/status', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const status = await dailyRewardsManager.getClaimStatus(userId);

      res.json(status);
    } catch (error) {
      console.error('[DAILY-REWARDS] Error getting claim status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Claim daily reward
  app.post('/api/daily-rewards/claim', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const result = await dailyRewardsManager.claimDailyReward(userId);

      // Update leaderboard with user's info
      await dailyRewardsManager.updateLeaderboard(userId, req.session.userinfo.username);

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      if (error.name === 'DailyRewardsError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[DAILY-REWARDS] Error claiming daily reward:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Purchase streak protection
  app.post('/api/daily-rewards/protection', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const { level } = req.body;

      if (!level) {
        return res.status(400).json({ error: 'Missing protection level', code: 'MISSING_LEVEL' });
      }

      const userId = req.session.userinfo.id;
      const result = await dailyRewardsManager.purchaseStreakProtection(userId, level);

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      if (error.name === 'DailyRewardsError') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error('[DAILY-REWARDS] Error purchasing streak protection:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get streak leaderboard
  app.get('/api/daily-rewards/leaderboard', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : 10;
      const leaderboard = await dailyRewardsManager.getStreakLeaderboard(limit);

      res.json(leaderboard);
    } catch (error) {
      console.error('[DAILY-REWARDS] Error getting leaderboard:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get claim history
  app.get('/api/daily-rewards/history', async (req, res) => {
    try {
      if (!req.session.userinfo) return res.status(401).json({ error: 'Unauthorized' });

      const userId = req.session.userinfo.id;
      const limit = req.query.limit ? parseInt(req.query.limit) : 10;

      const history = await dailyRewardsManager.getClaimHistory(userId, limit);

      res.json(history);
    } catch (error) {
      console.error('[DAILY-REWARDS] Error getting claim history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
};