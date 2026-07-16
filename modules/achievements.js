const createAuthz = require('../handlers/authz');
const log = require('../handlers/log');

const HeliactylModule = {
  "name": "Achievements",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Achievements and Quests system rewarding users with coins.",
  "author": {
    "name": "Antigravity",
    "email": "antigravity@gemini.dev",
    "url": "https://google.com"
  },
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

// Default achievements to seed on startup (in English)
const DEFAULT_ACHIEVEMENTS = [
  {
    key: "create_server",
    name: "World Builder",
    description: "Create your first game server.",
    rewardCoins: 50
  },
  {
    key: "daily_claim",
    name: "Loyal User",
    description: "Claim your daily reward for the first time.",
    rewardCoins: 10
  },
  {
    key: "stake_coins",
    name: "Capitalist",
    description: "Stake your coins for the first time.",
    rewardCoins: 25
  },
  {
    key: "generate_referral",
    name: "Influencer",
    description: "Generate your first referral code.",
    rewardCoins: 15
  },
  {
    key: "claim_referral",
    name: "Welcome",
    description: "Redeem another user's referral code.",
    rewardCoins: 30
  }
];

// Helper to seed achievements in database
async function seedAchievements(db) {
  try {
    const count = await db.achievement.count();
    if (count === 0) {
      console.log('[ACHIEVEMENTS] Seeding default achievements...');
      for (const ach of DEFAULT_ACHIEVEMENTS) {
        await db.achievement.create({
          data: ach
        });
      }
      console.log('[ACHIEVEMENTS] Seeding completed.');
    }
  } catch (error) {
    console.error('[ACHIEVEMENTS] Seeding error:', error);
  }
}

// Atomic achievement trigger function
async function triggerAchievement(db, userId, key) {
  if (!userId || !key) return { success: false, reason: "Missing params" };

  try {
    const ach = await db.achievement.findUnique({
      where: { key }
    });

    if (!ach) {
      console.warn(`[ACHIEVEMENTS] Achievement key "${key}" not found in DB`);
      return { success: false, reason: "Achievement not found" };
    }

    // Check if already unlocked
    const alreadyUnlocked = await db.userAchievement.findUnique({
      where: {
        userId_achievementId: {
          userId,
          achievementId: ach.id
        }
      }
    });

    if (alreadyUnlocked) {
      return { success: false, reason: "Already unlocked" };
    }

    // Unlock achievement and award coins
    const result = await db.$transaction(async (tx) => {
      const unlock = await tx.userAchievement.create({
        data: {
          userId,
          achievementId: ach.id
        }
      });

      // Award coins
      const userUpdate = await tx.user.update({
        where: { id: userId },
        data: {
          coins: { increment: ach.rewardCoins }
        }
      });

      // Log transaction (in English)
      await tx.transaction.create({
        data: {
          userId,
          type: "earn",
          amount: ach.rewardCoins,
          description: `Achievement unlocked: ${ach.name}`
        }
      });

      return { unlock, newBalance: userUpdate.coins };
    });

    log('achievement_unlocked', `User ${userId} unlocked achievement "${ach.name}" (+${ach.rewardCoins} coins)`);
    return { success: true, achievement: ach, newBalance: result.newBalance };
  } catch (error) {
    console.error(`[ACHIEVEMENTS] Error unlocking achievement "${key}" for user "${userId}":`, error);
    return { success: false, reason: "Database transaction error" };
  }
}

module.exports.HeliactylModule = HeliactylModule;
module.exports.triggerAchievement = triggerAchievement;

module.exports.load = async function (app, db) {
  const authz = createAuthz(db);

  // Seed default achievements
  await seedAchievements(db);

  // GET achievements list with unlock details for the current user
  app.get("/api/v5/achievements", async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const achievements = await db.achievement.findMany();
      const unlocked = await db.userAchievement.findMany({
        where: { userId: sessionUser.id }
      });

      const unlockedIds = new Set(unlocked.map(u => u.achievementId));
      const unlockDates = new Map(unlocked.map(u => [u.achievementId, u.unlockedAt]));

      const responseData = achievements.map(ach => ({
        id: ach.id,
        key: ach.key,
        name: ach.name,
        description: ach.description,
        rewardCoins: ach.rewardCoins,
        unlocked: unlockedIds.has(ach.id),
        unlockedAt: unlockDates.get(ach.id) || null
      }));

      res.json(responseData);
    } catch (error) {
      console.error("[ACHIEVEMENTS] GET error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
