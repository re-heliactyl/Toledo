const vpnCheck = require("../handlers/vpnCheck.js");
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const axios = require('axios');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const log = require("../handlers/log.js");
const createAuthz = require('../handlers/authz');
const createIpCheck = require('../handlers/ipCheck');
const { getClientIp, isUserAllowlisted } = require('../handlers/antiVpnAllowlist');

const HeliactylModule = {
  "name": "Discord OAuth2",
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

// Constants
const DISCORD_CLIENT_ID = settings.api.client.discord.client_id;
const DISCORD_CLIENT_SECRET = settings.api.client.discord.client_secret;
const DISCORD_BOT_TOKEN = settings.api.client.discord.bot_token;
const DISCORD_SERVER_ID = settings.api.client.discord.server_id;
const DISCORD_REDIRECT_URI = `${settings.website.domain}/auth/discord/callback`;
const DISCORD_SIGNUP_BONUS = 100;

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [
    Partials.User,
    Partials.GuildMember
  ]
});

// Utility functions
function generatePassword(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(x => chars[x % chars.length]).join('');
}

async function createPterodactylAccount(accountId, username, email, retryCount = 0) {
  if (retryCount > 3) {
    throw new Error('Maximum retry attempts reached for creating Pterodactyl account');
  }

  // Sanitize username to match Pterodactyl requirements:
  // - Must start and end with alphanumeric
  // - Can only contain letters, numbers, dashes, underscores, and periods
  const sanitizeUsername = (name) => {
    // Remove any characters that aren't allowed
    let cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '');

    // If starts with non-alphanumeric, prepend 'u'
    if (!cleaned.match(/^[a-zA-Z0-9]/)) {
      cleaned = 'u' + cleaned;
    }

    // If ends with non-alphanumeric, append random number
    if (!cleaned.match(/[a-zA-Z0-9]$/)) {
      cleaned = cleaned + crypto.randomInt(1, 10);
    }

    // Ensure we have at least one character
    if (cleaned.length === 0) {
      cleaned = 'user' + crypto.randomInt(100, 1000);
    }

    return cleaned;
  };

  const password = generatePassword(16);

  // Create a username with internal accountId as fallback to ensure uniqueness
  const baseUsername = sanitizeUsername(username);
  // Include internal accountId in the username for guaranteed uniqueness
  const finalUsername = retryCount ? `${baseUsername}_${accountId.slice(0, 6)}${retryCount}` : `${baseUsername}_${accountId.slice(0, 6)}`;

  try {
    const response = await pteroApi.post('/api/application/users', {
      email: retryCount ? `discord_${accountId}+${retryCount}@${email.split('@')[1]}` : `discord_${accountId}@${email.split('@')[1]}`,
      username: finalUsername,
      first_name: username,
      last_name: 'User',
      password: password,
      root_admin: false,
      language: 'en'
    });

    return {
      id: response.data.attributes.id,
      username: response.data.attributes.username,
      email: response.data.attributes.email,
      password: password
    };
  } catch (error) {
    if (error.response?.status === 422 && retryCount < 3) {
      return createPterodactylAccount(accountId, username, email, retryCount + 1);
    }

    console.error('Pterodactyl API error:', {
      message: error.message,
      username: finalUsername,
      originalUsername: username,
      accountId: accountId,
      email: email.replace(/@.*/, '@[redacted]'),
      retryCount,
      errors: error.response?.data?.errors
    });
    throw error;
  }
}

async function verifyPterodactylAccount(pteroId) {
  try {
    await pteroApi.get(`/api/application/users/${pteroId}`);
    return true;
  } catch {
    return false;
  }
}

async function fetchPterodactylData(pteroId) {
  const response = await pteroApi.get(`/api/application/users/${pteroId}?include=servers`);
  return response.data;
}

async function addDiscordServerMember(userId, accessToken, username) {
  try {
    const guild = await client.guilds.fetch(DISCORD_SERVER_ID);
    if (!guild) {
      throw new Error('Could not find Discord server');
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      await guild.members.add(userId, {
        accessToken: accessToken,
        nick: username
      });
    }
    return true;
  } catch (error) {
    return false;
  }
}
// Discord bot setup
client.once('ready', () => {
});

client.on('error', (error) => {
});

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Discord connection error details:", error);
  console.log("Discord OAuth is not setup! which is required for the application to function. Closing webserver...");
  process.exit(1);
});

/**
 * Send a Discord DM to a ticket owner when an admin replies to their ticket
 * @param {string} discordUserId - The Discord user ID to message
 * @param {string} ticketDisplayId - Short display ID (e.g., "ABC12345")
 * @param {string} ticketSubject - The ticket subject
 * @param {string} websiteDomain - The website domain for the ticket link
 */
async function sendTicketReplyDM(discordUserId, ticketDisplayId, ticketSubject, websiteDomain) {
  try {
    const user = await client.users.fetch(discordUserId);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📬 Ticket Reply Received')
      .setDescription('An administrator has responded to your support ticket.')
      .addFields(
        { name: 'Ticket', value: `#${ticketDisplayId}`, inline: true },
        { name: 'Subject', value: ticketSubject.length > 50 ? ticketSubject.slice(0, 50) + '...' : ticketSubject, inline: true },
        { name: 'Status', value: 'Open', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Overnode Support' });

    const button = new ButtonBuilder()
      .setLabel('View Ticket')
      .setStyle(ButtonStyle.Link)
      .setURL(`${websiteDomain}/support`);

    const row = new ActionRowBuilder().addComponents(button);

    await user.send({ embeds: [embed], components: [row] });
  } catch (error) {
    if (error.code === 50007) {
      return;
    }
    console.error('Failed to send ticket reply DM:', error.message);
  }
}

// Module export
module.exports.HeliactylModule = HeliactylModule;
module.exports.sendTicketReplyDM = sendTicketReplyDM;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);
  const ipCheck = createIpCheck(db);

  // OAuth login endpoint
  app.get('/auth/discord/login', (req, res) => {
    const state = crypto.randomUUID();
    req.session.oauthState = state;

    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email guilds.join',
      state: state
    });

    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  // OAuth callback handler
  app.get('/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query;

    const redirectAuthError = (reason = 'discord_auth_failed') => {
      const params = new URLSearchParams({ error: reason });
      return res.redirect(`/auth?${params.toString()}`);
    };

    if (!code) {
      return redirectAuthError('discord_missing_code');
    }

    if (state !== req.session.oauthState) {
      return redirectAuthError('discord_session_expired');
    }

    delete req.session.oauthState;

    const clientIp = getClientIp(req);

    try {
      // Exchange code for access token
      const tokenResponse = await axios.post('https://discord.com/api/oauth2/token',
        new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const tokenData = tokenResponse.data;

      // Fetch user data
      const userResponse = await axios.get('https://discord.com/api/v10/users/@me', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      });

      const userData = userResponse.data;

      if (!userData.email) {
        return redirectAuthError('discord_email_unavailable');
      }

      // Get or create user record
      let user = await db.user.findUnique({ where: { discordId: userData.id } });
      let pteroId = user?.pterodactylId;
      let isNewUser = !user;
      if (isNewUser) {
        const existingEmailUser = await db.user.findUnique({
          where: { email: userData.email },
          select: { id: true }
        });

        if (existingEmailUser) {
          return redirectAuthError('discord_email_in_use');
        }
      }

      if (clientIp) {
        const bypassIds = (settings.api?.client?.discord?.vpn_bypass_ids || []).map(String);
        const isBypassed = bypassIds.includes(userData.id) && user?.twoFactorEnabled === true;

        if (!isBypassed) {
          const allowlisted = user?.id ? await isUserAllowlisted(db, clientIp, user.id) : false;
          if (!allowlisted) {
            const vpnResult = await vpnCheck(null, db, clientIp);
            if (vpnResult.blocked) {
              return res.redirect('/auth?error=vpn');
            }
          }
        }
      }

      // Verify existing Pterodactyl account or create new one
      if (!isNewUser && (!pteroId || !(await verifyPterodactylAccount(pteroId)))) {
        const pteroAccount = await createPterodactylAccount(user.id, userData.username, userData.email);
        pteroId = pteroAccount.id;
      }

      if (isNewUser) {
        const localPasswordHash = await bcrypt.hash(generatePassword(32), 12);

        user = await db.user.create({
          data: {
            discordId: userData.id,
            username: userData.username,
            email: userData.email,
            password: localPasswordHash,
            discordAccessToken: tokenData.access_token,
            discordRefreshToken: tokenData.refresh_token,
            coins: DISCORD_SIGNUP_BONUS
          }
        });

        try {
          const pteroAccount = await createPterodactylAccount(user.id, userData.username, userData.email);
          pteroId = pteroAccount.id;

          user = await db.user.update({
            where: { id: user.id },
            data: { pterodactylId: pteroId }
          });
        } catch (error) {
          await db.user.delete({ where: { id: user.id } });
          throw error;
        }

        await db.notification.create({ data: { userId: user.id, action: "coins:bonus", name: `Discord Signup Bonus: +${DISCORD_SIGNUP_BONUS} coins` } });
      } else {
        user = await db.user.update({
          where: { id: user.id },
          data: {
            username: userData.username,
            email: userData.email,
            pterodactylId: pteroId,
            discordAccessToken: tokenData.access_token,
            discordRefreshToken: tokenData.refresh_token,
            updatedAt: new Date()
          }
        });
      }

      if (clientIp) {
        const bypassIds = (settings.api?.client?.discord?.vpn_bypass_ids || []).map(String);
        const isBypassed = bypassIds.includes(userData.id) && user?.twoFactorEnabled === true;

        if (!isBypassed) {
          const ipCheckResult = await ipCheck.checkAndRecordIp(clientIp, userData.id, user.id);
          if (!ipCheckResult.allowed) {
            const bannedUser = await db.user.findUnique({
              where: { id: user.id },
              select: {
                id: true,
                username: true,
                email: true,
                isBanned: true,
                banReason: true,
                bannedAt: true,
                bannedByUserId: true,
                bannedByUsername: true,
              },
            });

            req.session.userinfo = {
              id: user.id,
              username: user.username,
              email: user.email,
              global_name: userData.global_name || userData.username,
            };

            return authz.denyBannedRequest(req, res, bannedUser);
          }
        }
      }

      if (user.twoFactorEnabled) {
        // Set a flag in session that 2FA is required
        req.session.twoFactorPending = true;
        req.session.twoFactorUserId = user.id;
        req.session.tempUserInfo = {
          id: user.id,
          username: user.username,
          email: user.email
        };

        // Redirect to 2FA verification page instead of dashboard
        return res.redirect('/auth/2fa');
      }

      // Set up session - now using internal userId as the primary identifier
      req.session.userinfo = {
        id: user.id,
        username: user.username,
        email: user.email,
        global_name: userData.global_name || userData.username
      };
      req.session.sessionIp = clientIp;
      req.session.userAgent = req.headers['user-agent'] || '';
      req.session.createdAt = Date.now();

      const banRecord = await authz.getFreshSessionUserRecord(req);
      if (authz.isUserBanned(banRecord)) {
        return authz.denyBannedRequest(req, res, banRecord);
      }

      // Fetch and set Pterodactyl session data
      const pteroData = await fetchPterodactylData(pteroId);
      req.session.pterodactyl = pteroData.attributes;

      // Add user to Discord server using userId for identification
      await addDiscordServerMember(userData.id, tokenData.access_token, userData.username);

      // Add login notification
      await db.notification.create({ data: { userId: user.id, action: "user:auth", name: "Sign in with Discord" } });

      log('auth_discord', `**${user.username}** (${user.email}) logged in with Discord${isNewUser ? ' (new account)' : ''}\nDiscord: \`${userData.username}\` (\`${userData.id}\`)\nIP: \`${clientIp || 'unknown'}\``);

      res.redirect('/dashboard');
    } catch (error) {
      console.error('Discord authentication failed:', error);

      if (error?.code === 'P2002') {
        return redirectAuthError('discord_email_in_use');
      }

      if (error.response?.status === 400 || error.response?.status === 401) {
        return redirectAuthError('discord_oauth_error');
      }

      return redirectAuthError('discord_auth_failed');
    }
  });

  // Token refresh endpoint
  app.post('/auth/discord/refresh', async (req, res) => {
    if (!authz.hasUserSession(req)) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = authz.getSessionUser(req).id;
    const user = await db.user.findUnique({ where: { id: userId } });

    if (!user?.discordRefreshToken) {
      return res.status(400).json({ error: 'No refresh token available' });
    }

    try {
      const response = await axios.post('https://discord.com/api/v10/oauth2/token',
        new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: user.discordRefreshToken,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const tokenData = response.data;

      // Update stored tokens
      await db.user.update({
        where: { id: user.id },
        data: {
          discordAccessToken: tokenData.access_token,
          discordRefreshToken: tokenData.refresh_token,
          updatedAt: new Date()
        }
      });

      res.json({ message: 'Token refreshed successfully' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to refresh token' });
    }
  });
};
