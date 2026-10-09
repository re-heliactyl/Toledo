const crypto = require('crypto');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const axios = require('axios');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const { getClientIp } = require('../handlers/antiVpnAllowlist');
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');

const HeliactylModule = {
  "name": "Two-factor authentication",
  "version": "1.1.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Two-factor authentication module for Heliactyl Next",
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

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

// Generate backup codes
function generateBackupCodes(count = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomCodePart = () => Array.from(crypto.randomBytes(4), (byte) => chars[byte % chars.length]).join('');
  const codes = [];
  for (let i = 0; i < count; i++) {
    // Format: xxxx-xxxx (where x is alphanumeric)
    const part1 = randomCodePart();
    const part2 = randomCodePart();
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

// Setup routes for 2FA
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);
  const isAuthenticated = authz.requireSession;

  // Get 2FA status
  app.get('/api/2fa/status', isAuthenticated, async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { twoFactorEnabled: true }
      });

      res.json({
        enabled: user?.twoFactorEnabled || false
      });
    } catch (error) {
      console.error('Error fetching 2FA status:', error);
      res.status(500).json({ error: 'Failed to fetch 2FA status' });
    }
  });

  // Initialize 2FA setup
  app.post('/api/2fa/setup', isAuthenticated, async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser.id;
      const username = sessionUser.username;

      // Generate a new secret
      const secret = speakeasy.generateSecret({
        length: 20,
        name: `Heliactyl:${username}`
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
  app.post('/api/2fa/verify', isAuthenticated, validate(schemas.twoFactorVerify), async (req, res) => {
    try {
      const { code, secret } = req.body;
      const userId = authz.getSessionUser(req).id;

      if (!secret) {
        return res.status(400).json({ error: 'Secret is required' });
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
      await db.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: true,
          twoFactorSecret: secret,
          backupCodes: JSON.stringify(backupCodes),
          twoFactorAt: new Date()
        }
      });

      // Clean up session
      delete req.session.twoFactorSetup;

      await db.notification.create({ data: { userId, action: "security:2fa", name: "Two-factor authentication enabled" } });

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
  app.post('/api/2fa/disable', isAuthenticated, validate(schemas.twoFactorDisable), async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const { currentPassword } = req.body;

      // Check if 2FA is enabled
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { twoFactorEnabled: true, password: true }
      });

      if (!user || !user.twoFactorEnabled) {
        return res.status(400).json({ error: 'Two-factor authentication is not enabled' });
      }

      const passwordMatch = await bcrypt.compare(currentPassword, user.password);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      // Disable 2FA
      await db.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          backupCodes: null,
          twoFactorAt: null
        }
      });

      await db.notification.create({ data: { userId, action: "security:2fa", name: "Two-factor authentication disabled" } });

      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling 2FA:', error);
      res.status(500).json({ error: 'Failed to disable two-factor authentication' });
    }
  });

  // Get new backup codes
  app.post('/api/2fa/backup-codes', isAuthenticated, async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;

      // Check if 2FA is enabled
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { twoFactorEnabled: true }
      });

      if (!user || !user.twoFactorEnabled) {
        return res.status(400).json({ error: 'Two-factor authentication is not enabled' });
      }

      // Generate new backup codes
      const backupCodes = generateBackupCodes(8);

      // Update 2FA data
      await db.user.update({
        where: { id: userId },
        data: {
          backupCodes: JSON.stringify(backupCodes)
        }
      });

      await db.notification.create({ data: { userId, action: "security:2fa", name: "New backup codes generated" } });

      res.json({ backupCodes });
    } catch (error) {
      console.error('Error generating backup codes:', error);
      res.status(500).json({ error: 'Failed to generate new backup codes' });
    }
  });

  // 2FA verification during login
  app.post('/auth/2fa/verify', validate(schemas.auth2FALoginVerify), async (req, res) => {
    try {
      const { code } = req.body;

      // Check if we're in a pending 2FA state
      if (!req.session.twoFactorPending || !req.session.twoFactorUserId) {
        return res.status(400).json({ error: '2FA verification not required' });
      }

      const userId = req.session.twoFactorUserId;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { 
          id: true,
          username: true,
          email: true,
          twoFactorEnabled: true, 
          twoFactorSecret: true, 
          backupCodes: true,
          pterodactylId: true
        }
      });

      if (!user || !user.twoFactorEnabled) {
        return res.status(400).json({ error: '2FA is not enabled' });
      }

      const backupCodes = JSON.parse(user.backupCodes || '[]');

      // Check if it's a backup code
      if (backupCodes.includes(code)) {
        // Remove used backup code
        const newBackupCodes = backupCodes.filter(c => c !== code);
        await db.user.update({
          where: { id: userId },
          data: {
            backupCodes: JSON.stringify(newBackupCodes)
          }
        });

        // Complete login
        delete req.session.twoFactorPending;
        delete req.session.twoFactorUserId;

        // Fetch user data and set session
        req.session.userinfo = {
          id: user.id,
          username: user.username,
          email: user.email,
          global_name: user.username
        };
        req.session.sessionIp = getClientIp(req);

        const banRecord = await authz.getFreshSessionUserRecord(req);
        if (authz.isUserBanned(banRecord)) {
          return authz.denyBannedRequest(req, res, banRecord, { forceJson: true });
        }

        await db.notification.create({ data: { userId, action: "security:2fa", name: "Logged in using backup code" } });

        return res.json({ success: true });
      }

      // Verify TOTP code
      const verified = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
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

      // Set session
      req.session.userinfo = {
        id: user.id,
        username: user.username,
        email: user.email,
        global_name: user.username
      };
      req.session.sessionIp = getClientIp(req);

      const banRecord = await authz.getFreshSessionUserRecord(req);
      if (authz.isUserBanned(banRecord)) {
        return authz.denyBannedRequest(req, res, banRecord, { forceJson: true });
      }

      // Fetch Pterodactyl data
      const pteroId = user.pterodactylId;
      const pteroResponse = await pteroApi.get(`/api/application/users/${pteroId}?include=servers`);
      req.session.pterodactyl = pteroResponse.data.attributes;

      await db.notification.create({ data: { userId, action: "security:2fa", name: "Successful 2FA verification during login" } });

      res.json({ success: true });
    } catch (error) {
      console.error('Error in 2FA login verification:', error);
      res.status(500).json({ error: 'Failed to verify 2FA during login' });
    }
  });
};
