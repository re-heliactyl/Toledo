const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");

const HeliactylModule = {
  "name": "Two-factor authentication",
  "version": "1.0.1",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Two-factor authentication module for Heliactyl Next",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "dependencies": [],
  "permissions": [],
  "routes": [
    {
      "path": "/api/auth/login",
      "method": "POST",
      "description": "User login endpoint"
    },
    {
      "path": "/api/auth/register",
      "method": "POST",
      "description": "User registration endpoint"
    },
    {
      "path": "/api/auth/verify",
      "method": "GET",
      "description": "Email verification endpoint"
    }
  ],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

// Generate backup codes
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // Format: xxxx-xxxx (where x is alphanumeric)
    const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

// Function to add a notification for the user
async function addUserNotification(db, userId, notification) {
  const notifications = await db.get(`notifications-${userId}`) || [];
  notifications.push({
    id: uuidv4(),
    ...notification,
    timestamp: new Date().toISOString()
  });
  await db.set(`notifications-${userId}`, notifications);
}

// Setup routes for 2FA
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  // Middleware to check if user is authenticated
  const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.userinfo) {
      return next();
    }
    res.status(401).json({ error: 'Authentication required' });
  };

  // Get 2FA status
  app.get('/api/2fa/status', isAuthenticated, async (req, res) => {
    try {
      const userId = req.session.userinfo.id;
      const twoFactorData = await db.get(`2fa-${userId}`);

      res.json({
        enabled: twoFactorData?.enabled || false
      });
    } catch (error) {
      console.error('Error fetching 2FA status:', error);
      res.status(500).json({ error: 'Failed to fetch 2FA status' });
    }
  });

  // Initialize 2FA setup
  app.post('/api/2fa/setup', isAuthenticated, async (req, res) => {
    try {
      const userId = req.session.userinfo.id;
      const username = req.session.userinfo.username;

      // Generate a new secret
      const secret = speakeasy.generateSecret({
        length: 20,
        name: `Altare:${username}`
      });

      // Generate QR code
      const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

      // Store temporary setup data in session
      req.session.twoFactorSetup = {
        secret: secret.base32,
        tempSecret: secret.base32
      };

      res.json({
        secret: secret.base32,
        qrCodeUrl
      });
    } catch (error) {
      console.error('Error setting up 2FA:', error);
      res.status(500).json({ error: 'Failed to set up two-factor authentication' });
    }
  });

  // Verify and enable 2FA
  app.post('/api/2fa/verify', isAuthenticated, async (req, res) => {
    try {
      const { code, secret } = req.body;
      const userId = req.session.userinfo.id;

      if (!code) {
        return res.status(400).json({ error: 'Verification code is required' });
      }

      // Verify that the user is in setup mode
      if (!req.session.twoFactorSetup || req.session.twoFactorSetup.tempSecret !== secret) {
        return res.status(400).json({ error: 'Invalid setup session' });
      }

      // Verify the token against the secret
      const verified = speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: code,
        window: 1  // Allow 1 step before/after for clock drift
      });

      if (!verified) {
        return res.status(400).json({ error: 'Invalid verification code' });
      }

      // Generate backup codes
      const backupCodes = generateBackupCodes(8);

      // Store 2FA data in database
      await db.set(`2fa-${userId}`, {
        enabled: true,
        secret: secret,
        backupCodes: backupCodes,
        enabledAt: new Date().toISOString()
      });

      // Clean up session
      delete req.session.twoFactorSetup;

      // Add notification
      await addUserNotification(db, userId, {
        action: "security:2fa",
        name: "Two-factor authentication enabled"
      });

      res.json({
        enabled: true,
        backupCodes
      });
    } catch (error) {
      console.error('Error verifying 2FA:', error);
      res.status(500).json({ error: 'Failed to verify and enable two-factor authentication' });
    }
  });

  // Disable 2FA
  app.post('/api/2fa/disable', isAuthenticated, async (req, res) => {
    try {
      const userId = req.session.userinfo.id;

      // Check if 2FA is enabled
      const twoFactorData = await db.get(`2fa-${userId}`);
      if (!twoFactorData || !twoFactorData.enabled) {
        return res.status(400).json({ error: 'Two-factor authentication is not enabled' });
      }

      // Disable 2FA
      await db.set(`2fa-${userId}`, {
        enabled: false,
        disabledAt: new Date().toISOString()
      });

      // Add notification
      await addUserNotification(db, userId, {
        action: "security:2fa",
        name: "Two-factor authentication disabled"
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling 2FA:', error);
      res.status(500).json({ error: 'Failed to disable two-factor authentication' });
    }
  });

  // Get new backup codes
  app.post('/api/2fa/backup-codes', isAuthenticated, async (req, res) => {
    try {
      const userId = req.session.userinfo.id;

      // Check if 2FA is enabled
      const twoFactorData = await db.get(`2fa-${userId}`);
      if (!twoFactorData || !twoFactorData.enabled) {
        return res.status(400).json({ error: 'Two-factor authentication is not enabled' });
      }

      // Generate new backup codes
      const backupCodes = generateBackupCodes(8);

      // Update 2FA data
      twoFactorData.backupCodes = backupCodes;
      await db.set(`2fa-${userId}`, twoFactorData);

      // Add notification
      await addUserNotification(db, userId, {
        action: "security:2fa",
        name: "New backup codes generated"
      });

      res.json({ backupCodes });
    } catch (error) {
      console.error('Error generating backup codes:', error);
      res.status(500).json({ error: 'Failed to generate new backup codes' });
    }
  });

  // 2FA verification during login
  app.post('/auth/2fa/verify', async (req, res) => {
    try {
      const { code } = req.body;

      // Check if we're in a pending 2FA state
      if (!req.session.twoFactorPending || !req.session.twoFactorUserId) {
        return res.status(400).json({ error: '2FA verification not required' });
      }

      const userId = req.session.twoFactorUserId;
      const twoFactorData = await db.get(`2fa-${userId}`);

      if (!twoFactorData || !twoFactorData.enabled) {
        return res.status(400).json({ error: '2FA is not enabled' });
      }

      // Check if it's a backup code
      if (twoFactorData.backupCodes && twoFactorData.backupCodes.includes(code)) {
        // Remove used backup code
        twoFactorData.backupCodes = twoFactorData.backupCodes.filter(c => c !== code);
        await db.set(`2fa-${userId}`, twoFactorData);

        // Complete login
        delete req.session.twoFactorPending;
        delete req.session.twoFactorUserId;

        // Fetch user data and set session
        const userData = await db.get(`users-${userId}`);
        req.session.userinfo = userData;

        // Add notification
        await addUserNotification(db, userId, {
          action: "security:2fa",
          name: "Logged in using backup code"
        });

        return res.json({ success: true });
      }

      // Verify TOTP code
      const verified = speakeasy.totp.verify({
        secret: twoFactorData.secret,
        encoding: 'base32',
        token: code,
        window: 1
      });

      if (!verified) {
        return res.status(400).json({ error: 'Invalid verification code' });
      }

      // Complete login
      delete req.session.twoFactorPending;
      delete req.session.twoFactorUserId;

      // Fetch user data and set session
      const userData = await db.get(`discord-${userId}`);
      req.session.userinfo = {
        id: userData.id,
        username: userData.username,
        email: userData.email,
        global_name: userData.global_name || userData.username
      };

      // Fetch Pterodactyl data
      const pteroId = userData.pterodactyl_id;
      const pteroData = await fetch(
        `${settings.pterodactyl.domain}/api/application/users/${pteroId}?include=servers`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.pterodactyl.key}`,
          },
        }
      ).then(res => res.json());

      req.session.pterodactyl = pteroData.attributes;

      // Add notification
      await addUserNotification(db, userId, {
        action: "security:2fa",
        name: "Successful 2FA verification during login"
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error in 2FA login verification:', error);
      res.status(500).json({ error: 'Failed to verify 2FA during login' });
    }
  });
};