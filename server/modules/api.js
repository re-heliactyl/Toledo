const loadConfig = require("../handlers/config");
const settings = loadConfig("./config.toml");

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
  app.get('/api/v5/state', async (req, res) => {
    try {
      // Check if user is authenticated
      if (!req.session || !req.session.userinfo) {
        return res.status(401).json({
          authenticated: false,
          message: 'Not authenticated'
        });
      }

      // Check if 2FA verification is pending
      const twoFactorPending = !!req.session.twoFactorPending;

      // Get user data
      const userId = req.session.userinfo.id;
      const userData = req.session.userinfo;

      // Get 2FA status
      const twoFactorData = await db.get(`2fa-${userId}`);
      const twoFactorEnabled = twoFactorData?.enabled || false;

      // Return authentication state
      return res.json({
        authenticated: !twoFactorPending,
        twoFactorPending: twoFactorPending,
        twoFactorEnabled: twoFactorEnabled,
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

  app.get("/api/coins", async (req, res) => {
    if (!req.session.userinfo) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    const userId = req.session.userinfo.id;
    const coins = await db.get(`coins-${userId}`) || 0;
    res.json({
      coins,
      index: 0
    });
  });

  // User
  app.get("/api/user", async (req, res) => {
    if (!req.session.userinfo) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    res.json(req.session.userinfo);
  });

  app.get("/api/remote/argon", async (req, res) => {
    if (!req.session.pterodactyl) {
      return res.status(401).json({
        error: "Not authenticated"
      });
    }
    res.json({
      ArgonUser: {
        Id: req.session.pterodactyl.id,
        Username: req.session.pterodactyl.username,
        Email: req.session.pterodactyl.email
      },
      Index: 0
    });
  });
}