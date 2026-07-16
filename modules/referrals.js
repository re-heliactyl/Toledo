const createAuthz = require('../handlers/authz');
const { triggerAchievement } = require('./achievements');

const HeliactylModule = {
  "name": "Referrals",
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

  app.post('/generate', async (req, res) => {
    if (!authz.hasUserSession(req)) return res.redirect("/login");
    if (!authz.hasPterodactylSession(req)) return res.redirect("/login");
    const sessionUser = authz.getSessionUser(req);

    const freshUser = await db.user.findUnique({ where: { id: sessionUser.id }, select: { isBanned: true } });
    if (freshUser?.isBanned) return res.json({ error: "Your account is banned" });

    const code = req.body?.code || req.query?.code;
    if (!code) {
      return res.json({ error: "No code provided" });
    }

    let referralCode = code;
    // check if the referral code is less than 16 characters and has no spaces
    if (referralCode.length > 15 || referralCode.includes(" ")) {
      return res.json({ error: "Invalid code" });
    }

    // check if the referral code already exists
    const existing = await db.referral.findUnique({
      where: { code: referralCode }
    });

    if (existing) {
      return res.json({ error: "Code already exists" });
    }

    // Check if user already has a referral code
    const userReferral = await db.referral.findUnique({
      where: { userId: sessionUser.id }
    });

    if (userReferral) {
      return res.json({ error: `You already have a referral code [${userReferral.code}]` });
    }

    // Save the referral code
    await db.referral.create({
        data: {
          code: referralCode,
          userId: sessionUser.id,
          createdAt: new Date()
        }
    });

    res.json({ success: "Referral code created" });

    // Trigger achievement
    try {
      await triggerAchievement(db, sessionUser.id, 'generate_referral');
    } catch (achError) {
      console.error('Failed to trigger generate_referral achievement:', achError);
    }
  });

  app.post('/claim', async (req, res) => {
    if (!authz.hasUserSession(req)) return res.redirect("/login");
    if (!authz.hasPterodactylSession(req)) return res.redirect("/login");
    const sessionUser = authz.getSessionUser(req);

    const freshUser = await db.user.findUnique({ where: { id: sessionUser.id }, select: { isBanned: true } });
    if (freshUser?.isBanned) return res.json({ error: "Your account is banned" });

    const code = req.body?.code || req.query?.code;
    if (!code) {
      return res.json({ error: "No code provided" });
    }

    const referralCode = code;

    try {
      const claimResult = await db.$transaction(async (tx) => {
        const referral = await tx.referral.findUnique({
          where: { code: referralCode },
          select: {
            id: true,
            userId: true,
            claimedById: true
          }
        });

        if (!referral) {
          return { error: "Invalid referral code" };
        }

        if (referral.userId === sessionUser.id) {
          return { error: "You cannot claim your own referral code" };
        }

        if (referral.claimedById) {
          return { error: "This referral code has already been used by someone else" };
        }

        const alreadyClaimed = await tx.referral.findFirst({
          where: { claimedById: sessionUser.id },
          select: { id: true }
        });

        if (alreadyClaimed) {
          return { error: "You have already claimed a referral code. Each account can only use one referral code." };
        }

        // Verify referral owner still exists and is not banned
        const owner = await tx.user.findUnique({
          where: { id: referral.userId },
          select: { id: true, isBanned: true }
        });

        if (!owner) {
          return { error: "The referral code owner's account no longer exists" };
        }

        if (owner.isBanned) {
          return { error: "This referral code is no longer valid" };
        }

        // Award the referral bonus atomically
        // Award the owner
        await tx.user.update({
          where: { id: referral.userId },
          data: { coins: { increment: 80 } }
        });

        await tx.transaction.create({
          data: {
            userId: referral.userId,
            type: 'earn',
            amount: 80,
            description: `Referral bonus from claimer ${sessionUser.id}`
          }
        });

        // Award the claimer
        await tx.user.update({
          where: { id: sessionUser.id },
          data: { coins: { increment: 250 } }
        });

        await tx.transaction.create({
          data: {
            userId: sessionUser.id,
            type: 'earn',
            amount: 250,
            description: `Claimed referral code: ${referralCode}`
          }
        });

        // Mark code as claimed
        await tx.referral.update({
          where: { id: referral.id },
          data: {
            claimedById: sessionUser.id,
            claimedAt: new Date()
          }
        });

        return { success: true };
      });

      if (claimResult.error) {
        console.warn(`Referral claim rejected: user=${sessionUser.id} code=${referralCode} reason="${claimResult.error}"`);
        return res.json({ error: claimResult.error });
      }

      console.log(`Referral claimed: user=${sessionUser.id} code=${referralCode}`);
      res.json({ success: "Referral code claimed" });

      // Trigger achievement
      try {
        await triggerAchievement(db, sessionUser.id, 'claim_referral');
      } catch (achError) {
        console.error('Failed to trigger claim_referral achievement:', achError);
      }
    } catch (error) {
      if (error?.code === 'P2002') {
        console.warn(`Referral claim P2002 conflict: user=${sessionUser.id} code=${referralCode}`);
        return res.json({ error: "You have already claimed a referral code. Each account can only use one referral code." });
      }

      console.error(`Referral claim error: user=${sessionUser.id} code=${referralCode}`, error);
      res.json({ error: "Failed to claim referral code. Please try again." });
    }
  });
};
