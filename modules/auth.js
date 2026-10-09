const crypto = require('crypto');
const bcrypt = require('bcrypt');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const axios = require("axios");
const getPteroUser = require('../handlers/getPteroUser');
const cache = require('../handlers/cache');
const log = require('../handlers/log');
const createAuthz = require('../handlers/authz');
const createIpCheck = require('../handlers/ipCheck');
const { getClientIp } = require('../handlers/antiVpnAllowlist');
const { removeServerRenewal } = require('./server/renewals');
const { validate, schemas } = require('../handlers/validate');
const {
  loginRateLimit,
  registerRateLimit,
  resetRequestRateLimit,
  resetConsumeRateLimit,
  magicLinkRateLimit,
  magicLoginRateLimit
} = require('../handlers/rateLimit');

const RESEND_API_KEY = settings.api.client.resend.api_key;

const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

const HeliactylModule = {
  "name": "Authentication",
  "version": "1.1.0",
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

if (HeliactylModule.target_platform !== settings.version) {
  process.exit()
}

async function createPterodactylAccount(username, email) {
  const axios = require('axios');
  const genpassword = makeid(settings.api.client.passwordgenerator.length);

  // Sanitize username: remove spaces and special characters, convert to lowercase
  const sanitizedUsername = username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 32); // Ensure username isn't too long

  try {
    const response = await axios({
      method: 'post',
      url: `${settings.pterodactyl.domain}/api/application/users`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.pterodactyl.key}`
      },
      data: {
        username: sanitizedUsername,
        email: email,
        first_name: username.split(' ')[0], // Use first name from original username
        last_name: 'on Heliactyl Next | #0',
        password: genpassword,
      }
    });

    return response.data.attributes.id;
  } catch (error) {
    if (error.response?.status === 422) {
      // If username/email still exists, append random string
      const suffix = makeid(4);
      const newUsername = sanitizedUsername + suffix;
      const [emailName, emailDomain] = email.split('@');
      const newEmail = emailName + suffix + '@' + emailDomain;
      return createPterodactylAccount(newUsername, newEmail);
    }
    console.error('Full error:', error.response || error);
    throw error;
  }
}

async function deleteOwnedServers(userId, username, db, servers) {
  const results = await Promise.all(
    servers.map(async (server) => {
      const serverId = server.attributes.id;
      const serverName = server.attributes.name || server.attributes.identifier || `#${serverId}`;

      try {
        await pteroApi.delete(`/api/application/servers/${serverId}/force`);
        await removeServerRenewal(db, {
          identifier: server.attributes.identifier,
          panelId: serverId
        });

        log('server_deleted', `User ${username} deleted server "${serverName}" during account deletion`);

        return {
          success: true,
          name: serverName
        };
      } catch (error) {
        console.error(`Failed to delete server ${serverId} during account deletion:`, error.response?.data || error.message || error);

        return {
          success: false,
          name: serverName
        };
      }
    })
  );

  return {
    deletedServers: results.filter((result) => result.success).map((result) => result.name),
    failedServers: results.filter((result) => !result.success).map((result) => result.name)
  };
}

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);
  const ipCheck = createIpCheck(db);

  const setSessionUser = (req, user) => {
    req.session.userinfo = {
      id: user.id,
      username: user.username,
      email: user.email,
      global_name: user.username,
    };
  };

  const getBanAwareUser = async (userId) => {
    return db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        discordId: true,
        pterodactylId: true,
        isBanned: true,
        banReason: true,
        bannedAt: true,
        bannedByUserId: true,
        bannedByUsername: true,
      },
    });
  };

  const getBanAwareUserByEmail = async (email) => {
    return db.user.findUnique({
      where: { email },
      select: {
        id: true,
        username: true,
        email: true,
        password: true,
        discordId: true,
        pterodactylId: true,
        isBanned: true,
        banReason: true,
        bannedAt: true,
        bannedByUserId: true,
        bannedByUsername: true,
      },
    });
  };

  const sendEmail = async (to, subject, html) => {
    const response = await axios.post('https://api.resend.com/emails', {
      from: settings.api.client.resend.from,
      to,
      subject,
      html
    }, {
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status !== 200 && response.status !== 201) {
      throw new Error('Failed to send email');
    }
  };

  // Modify login process to check for 2FA
  // This middleware should be added to your auth routes
  app.use((req, res, next) => {
    // Store the original login completion function
    const originalLogin = req.login;

    // Override the login function
    req.login = async function (user, options, done) {
      try {
        // Check if user has 2FA enabled
        const userData = await db.user.findUnique({
          where: { id: user.id },
          select: { twoFactorEnabled: true }
        });

        if (userData?.twoFactorEnabled) {
          // Set a flag in session that 2FA is required
          req.session.twoFactorPending = true;
          req.session.twoFactorUserId = user.id;

          // Don't complete login yet
          if (done) done(null);
          return;
        }

        // No 2FA required, proceed with normal login
        return originalLogin.call(this, user, options, done);
      } catch (error) {
        console.error('Error in 2FA check:', error);
        if (done) done(error);
      }
    };

    next();
  });

  // Registration route
  app.post("/auth/register", registerRateLimit, validate(schemas.authRegister), async (req, res) => {
    const { username, email, password } = req.body;

    // Check if email is already in use
    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: "Email already in use" });
    }

    // Check if username is already taken
    const existingUsername = await db.user.findUnique({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: "Username already taken" });
    }

    // Hash the password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Store user information
    const createdUser = await db.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
      }
    });

    // Create Pterodactyl account
    let genpassword = makeid(settings.api.client.passwordgenerator.length);
    let accountjson;
    try {
      accountjson = await axios.post(
        settings.pterodactyl.domain + "/api/application/users",
        {
          username: username,
          email: email,
          first_name: username,
          last_name: " on Heliactyl",
          password: genpassword,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.pterodactyl.key}`,
          },
        }
      );
    } catch (err) {
      accountjson = { status: err.response?.status || 500 };
    }

    if (accountjson.status === 201) {
      let accountinfo = accountjson.data;
      await db.user.update({
        where: { id: createdUser.id },
        data: { pterodactylId: accountinfo.attributes.id }
      });
    } else {
      return res.status(201).json({ error: "Your account has been created. Please login" });
    }

    log('auth_register', `**${username}** (${email}) registered a new account`);

    res.status(201).json({ message: "User registered successfully" });
  });

  app.post("/auth/login", loginRateLimit, validate(schemas.authLogin), async (req, res) => {
    const { email, password, remember } = req.body;
    const clientIp = getClientIp(req);

    const user = await getBanAwareUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (clientIp && user.discordId) {
      const ipCheckResult = await ipCheck.checkAndRecordIp(clientIp, user.discordId, user.id);
      if (!ipCheckResult.allowed) {
        const bannedUser = await getBanAwareUser(user.id);
        return authz.denyBannedRequest(req, res, bannedUser, { forceJson: true });
      }
    }

    // Create session
    setSessionUser(req, user);
    req.session.sessionIp = clientIp;
    req.session.userAgent = req.headers['user-agent'] || '';
    req.session.createdAt = Date.now();

    if (authz.isUserBanned(user)) {
      return authz.denyBannedRequest(req, res, user, { forceJson: true });
    }

    try {
      // Try to fetch existing Pterodactyl user info
      let pterodactylId = user.pterodactylId;
      let cacheaccount;
      try {
        if (pterodactylId) {
          cacheaccount = await axios.get(
            settings.pterodactyl.domain + "/api/application/users/" + pterodactylId + "?include=servers",
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${settings.pterodactyl.key}`,
              },
            }
          );
        } else {
          cacheaccount = { status: 404 };
        }
      } catch (err) {
        cacheaccount = { status: err.response?.status || 500 };
      }

      // If user doesn't exist in Pterodactyl, create new account
      if (cacheaccount.status === 404 || !pterodactylId) {
        pterodactylId = await createPterodactylAccount(user.username, user.email);

        // Update database with new Pterodactyl ID
        await db.user.update({
          where: { id: user.id },
          data: { pterodactylId: pterodactylId }
        });

        // Fetch updated user info
        cacheaccount = await axios.get(
          settings.pterodactyl.domain + "/api/application/users/" + pterodactylId + "?include=servers",
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${settings.pterodactyl.key}`,
            },
          }
        );
      }

      if (cacheaccount.status !== 200) {
        throw new Error(`Failed to fetch Pterodactyl account: ${cacheaccount.status}`);
      }

      const cacheaccountinfo = cacheaccount.data;
      req.session.pterodactyl = cacheaccountinfo.attributes;

      // Auth notification
      await db.notification.create({
        data: {
          userId: user.id,
          action: "user:auth",
          name: "Sign in from new location"
        }
      });

      log('auth_login', `**${user.username}** (${user.email}) logged in with email/password\nIP: \`${clientIp || 'unknown'}\``);

      res.json({ message: "Login successful" });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: "Failed to complete login process" });
    }
  });

  // Password reset request route
  app.post("/auth/reset-password-request", resetRequestRateLimit, validate(schemas.authResetRequest), async (req, res) => {
    const { email } = req.body;

    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      return res.json({ message: "If the email exists, a reset link will be sent" });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now

    await db.authToken.create({
      data: {
        userId: user.id,
        token: resetToken,
        type: 'reset',
        expiresAt: new Date(resetTokenExpiry)
      }
    });

    const resetLink = `${settings.website.domain}/auth/reset-password?token=${resetToken}`;

    try {
      await sendEmail(
        email,
        'Reset Your ' + settings.api.client.resend.app_name + ' Password',
        `<h1>Reset Your Password</h1><p>Click the link below to reset your password:</p><a href="${resetLink}">${resetLink}</a><p>This link will expire in 1 hour.</p>`
      );
    } catch (error) {
      console.error('Failed to send password reset email:', error);
      return res.status(500).json({ error: "Failed to send reset email" });
    }

    res.json({ message: "If the email exists, a reset link will be sent" });
  });

  // Password reset route
  app.post("/auth/reset-password", resetConsumeRateLimit, validate(schemas.authResetPassword), async (req, res) => {
    const { token, password } = req.body;
    const newPassword = password;

    const resetInfo = await db.authToken.findUnique({ where: { token } });
    if (!resetInfo || resetInfo.type !== 'reset' || resetInfo.usedAt || resetInfo.expiresAt < new Date()) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const user = await db.user.findUnique({ where: { id: resetInfo.userId } });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Hash the new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    const consumeResult = await db.authToken.updateMany({
      where: {
        token,
        usedAt: null,
        type: 'reset',
        expiresAt: { gt: new Date() }
      },
      data: { usedAt: new Date() }
    });

    if (consumeResult.count !== 1) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    // Update user's password
    await db.user.update({
      where: { id: resetInfo.userId },
      data: { password: hashedPassword }
    });

    res.json({ message: "Password reset successful" });
  });

  // Magic link login request
  app.post("/auth/magic-link", magicLinkRateLimit, validate(schemas.authMagicLink), async (req, res) => {
    const { email } = req.body;

    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      return res.json({ message: "If the email exists, a magic link will be sent" });
    }

    const magicToken = crypto.randomBytes(32).toString('hex');
    const magicTokenExpiry = Date.now() + 600000; // 10 minutes from now

    await db.authToken.create({
      data: {
        userId: user.id,
        token: magicToken,
        type: 'magic',
        expiresAt: new Date(magicTokenExpiry)
      }
    });

    const magicLink = `${settings.website.domain}/auth/magic-login?token=${magicToken}`;

    try {
      await sendEmail(
        email,
        'Login to ' + settings.api.client.resend.app_name,
        `<h1>Login to ${settings.api.client.resend.app_name}</h1><p>Click the link below to log in:</p><a href="${magicLink}">${magicLink}</a><p>This link will expire in 10 minutes.</p>`
      );
    } catch (error) {
      console.error('Failed to send magic link email:', error);
      return res.status(500).json({ error: "Failed to send magic link email" });
    }

    res.json({ message: "If the email exists, a magic link will be sent" });
  });

  // Magic link login verification
  app.get("/auth/magic-login", magicLoginRateLimit, async (req, res) => {
    const { token } = req.query;
    const clientIp = getClientIp(req);

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    const magicInfo = await db.authToken.findUnique({ where: { token } });
    if (!magicInfo || magicInfo.type !== 'magic' || magicInfo.usedAt || magicInfo.expiresAt < new Date()) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const consumeResult = await db.authToken.updateMany({
      where: {
        token,
        usedAt: null,
        type: 'magic',
        expiresAt: { gt: new Date() }
      },
      data: { usedAt: new Date() }
    });

    if (consumeResult.count !== 1) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const user = await getBanAwareUser(magicInfo.userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (clientIp && user.discordId) {
      const ipCheckResult = await ipCheck.checkAndRecordIp(clientIp, user.discordId, user.id);
      if (!ipCheckResult.allowed) {
        req.session.userinfo = {
          id: user.id,
          username: user.username,
          email: user.email,
          global_name: user.username,
        };

        const bannedUser = await getBanAwareUser(user.id);
        return authz.denyBannedRequest(req, res, bannedUser);
      }
    }

    // Create session
    setSessionUser(req, user);
    req.session.sessionIp = clientIp;
    req.session.userAgent = req.headers['user-agent'] || '';
    req.session.createdAt = Date.now();

    if (authz.isUserBanned(user)) {
      return authz.denyBannedRequest(req, res, user);
    }

    // Fetch Pterodactyl user info
    let cacheaccount;
    try {
      cacheaccount = await axios.get(
        settings.pterodactyl.domain + "/api/application/users/" + user.pterodactylId + "?include=servers",
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.pterodactyl.key}`,
          },
        }
      );
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch user information" });
    }

    if (cacheaccount.status === 404) {
      return res.status(500).json({ error: "Failed to fetch user information" });
    }

    let cacheaccountinfo = cacheaccount.data;
    req.session.pterodactyl = cacheaccountinfo.attributes;

    // Auth notification
    await db.notification.create({
      data: {
        userId: user.id,
        action: "user:auth",
        name: "Sign in using magic link"
      }
    });

    res.redirect('/dashboard'); // Redirect to dashboard after successful login
  });

  app.post("/api/user/logout", async (req, res) => {
    if (!authz.hasUserSession(req)) {
      return res.status(401).json({ error: "Not logged in" });
    }

    const userId = authz.getSessionUser(req).id;

    try {
      if (userId) {
        const existingUser = await db.user.findUnique({
          where: { id: userId },
          select: { id: true }
        });

        if (existingUser) {
          await db.notification.create({
            data: {
              userId,
              action: "user:logout",
              name: "Signed out"
            }
          });
        }
      }
    } catch (error) {
      console.error('Logout notification error:', error);
    }

    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
        return res.status(500).json({ error: "Failed to logout" });
      }

      authz.clearAdminCache(req);

      res.json({ message: "Logged out successfully" });
    });
  });

  app.delete("/api/user/account", async (req, res) => {
    if (!authz.hasUserSession(req)) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const sessionUser = authz.getSessionUser(req);

    try {
      const user = await db.user.findUnique({
        where: { id: sessionUser.id },
        select: {
          id: true,
          username: true,
          email: true,
          pterodactylId: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      let servers = [];

      if (user.pterodactylId) {
        try {
          const pteroUser = await getPteroUser(user.id, db);
          servers = pteroUser?.attributes?.relationships?.servers?.data || [];
        } catch (error) {
          if (error.message !== "Pterodactyl account not found!") {
            console.error('Failed to fetch Pterodactyl account during account deletion:', error);
            return res.status(502).json({ error: "Failed to fetch Pterodactyl account information" });
          }
        }
      }

      const suspendedServers = servers.filter((server) => server.attributes?.suspended === true);
      if (suspendedServers.length > 0) {
        return res.status(403).json({
          error: "Cannot delete account with suspended servers. Please contact support.",
          servers: suspendedServers.map((server) => server.attributes.name || server.attributes.identifier)
        });
      }

      const { deletedServers, failedServers } = await deleteOwnedServers(user.id, user.username, db, servers);
      if (failedServers.length > 0) {
        return res.status(502).json({
          error: "Failed to delete one or more servers. Please try again or contact support.",
          servers: failedServers
        });
      }

      if (user.pterodactylId) {
        try {
          await pteroApi.delete(`/api/application/users/${user.pterodactylId}`);
        } catch (error) {
          if (error.response?.status !== 404) {
            console.error('Failed to delete Pterodactyl user during account deletion:', error.response?.data || error);
            return res.status(502).json({ error: "Failed to delete the linked Pterodactyl account" });
          }
        }
      }

      log(
        'user:account_deleted',
        `User ${user.username} (${user.email}) deleted their account. Deleted ${deletedServers.length} server(s).`
      );

      await db.user.delete({ where: { id: user.id } });
      await cache.del(`ptero:user:${user.id}:servers`);
      await cache.delPattern(`ptero:user:${user.id}:*`);

      req.session.destroy((sessionError) => {
        if (sessionError) {
          console.error('Session destruction error after account deletion:', sessionError);
        }

        res.clearCookie('connect.sid');
        res.json({ message: "Account deleted successfully" });
      });
    } catch (error) {
      console.error('Account deletion error:', error);
      res.status(500).json({ error: "Failed to delete account" });
    }
  });

  const authTokenCleanup = setInterval(async () => {
    try {
      await db.authToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            { usedAt: { not: null } }
          ]
        }
      });
    } catch (error) {
      console.error('Auth token cleanup error:', error);
    }
  }, 15 * 60 * 1000);

  authTokenCleanup.unref?.();
};

function makeid(length) {
  let result = "";
  let characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(crypto.randomInt(0, characters.length));
  }
  return result;
}
