/* --------------------------------------------- */
/* users                                  */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, invalidateServerAccessCache, PANEL_URL, API_KEY, ADMIN_KEY } = require("./core.js");
const loadConfig = require("../../handlers/config.js");
const settings = loadConfig("./config.toml");
let db;
const { validate, schemas } = require('../../handlers/validate');
const createAuthz = require('../../handlers/authz');
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Users",
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
  "dependencies": [{ "name": "server/core", "optional": false }],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

module.exports.HeliactylModule = HeliactylModule;

async function getServerName(serverId) {
  try {
    const response = await axios.get(
      `${PANEL_URL}/api/client/servers/${serverId}`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Accept': 'application/json',
        },
      }
    );
    return response.data.attributes.name;
  } catch (error) {
    return 'Unknown Server';
  }
}

// Modified update subuser info
async function updateSubuserInfo(serverId, serverOwnerId) {
  try {
    const response = await axios.get(
      `${PANEL_URL}/api/client/servers/${serverId}/users`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Accept': 'application/json',
        },
      }
    );

    const subusers = response.data.data.map(user => ({
      id: user.attributes.username,
      username: user.attributes.username,
      email: user.attributes.email,
    }));

    const serverName = await getServerName(serverId);

    for (const subuser of subusers) {
      let user = null;
      if (subuser.email && subuser.email.startsWith('discord_')) {
        const potentialCuid = subuser.email.split('@')[0].substring(8).split('+')[0];
        if (potentialCuid) {
          user = await db.user.findUnique({
            where: { id: potentialCuid }
          });
        }
      }

      if (!user) {
        user = await db.user.findFirst({
          where: { OR: [{ email: subuser.email }, { pteroUsername: subuser.username }, { username: subuser.username }] }
        });
      }

      if (user) {
        await db.subuserServer.upsert({
          where: { userId_serverId_source: { userId: user.id, serverId, source: 'subuser' } },
          create: { userId: user.id, serverId, serverName, ownerId: serverOwnerId, source: 'subuser' },
          update: { serverName, ownerId: serverOwnerId }
        });
      }
    }

    invalidateServerAccessCache(serverId);
  } catch (error) {
    console.error(`Error updating subuser info:`, error);
  }
}

module.exports.updateSubuserInfo = updateSubuserInfo;
module.exports.load = async function (app, _db) {
  db = _db;
  const router = express.Router();
  const authz = createAuthz(_db);

  // GET /api/server/:id/users - List users
  router.get('/server/:id/users', isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/users`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      await updateSubuserInfo(serverId, authz.getSessionUser(req).id);

      res.json(response.data);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/server/:id/users - Create user
  router.post('/server/:id/users', isAuthenticated, ownsServer, validate(schemas.subuserCreate), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { email } = req.body;

      const panelUserResponse = await axios.get(
        `${PANEL_URL}/api/application/users?filter[email]=${encodeURIComponent(email)}`,
        {
          headers: {
            'Authorization': `Bearer ${ADMIN_KEY}`,
            'Accept': 'application/json',
          },
        }
      );

      if (!Array.isArray(panelUserResponse.data?.data) || panelUserResponse.data.data.length === 0) {
        return res.status(400).json({
          error: 'No panel account exists with this email. The user must register first.'
        });
      }

      const response = await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/users`,
        {
          email,
          permissions: [
            "control.console", "control.start", "control.stop", "control.restart",
            "user.create", "user.read", "user.update", "user.delete",
            "file.create", "file.read", "file.update", "file.delete",
            "file.archive", "file.sftp", "backup.create", "backup.read",
            "backup.delete", "backup.update", "backup.download",
            "allocation.update", "startup.update", "startup.read",
            "database.create", "database.read", "database.update",
            "database.delete", "database.view_password", "schedule.create",
            "schedule.read", "schedule.update", "settings.rename",
            "schedule.delete", "settings.reinstall", "websocket.connect"
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      await updateSubuserInfo(serverId, authz.getSessionUser(req).id);
      await recordServerActivity(db, req, serverId, 'user.create', {
        email,
        username: response.data.attributes.username,
      });

      res.status(201).json(response.data);
    } catch (error) {
      console.error('Error creating user:', error);
      const status = error.response?.status || 500;
      const detail = error.response?.data?.errors?.[0]?.detail;
      const message = error.response?.data?.error || detail || error.message || 'Internal server error';
      res.status(status).json({ error: message });
    }
  });

  // DELETE /api/server/:id/users/:userId - Delete user
  router.delete('/server/:id/users/:userId', isAuthenticated, ownsServer, async (req, res) => {
    try {
      const { id: serverId, userId } = req.params;
      await axios.delete(
        `${PANEL_URL}/api/client/servers/${serverId}/users/${userId}`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
          },
        }
      );

      // Remove the subuserServer record then re-sync from panel
      await db.subuserServer.deleteMany({
        where: { serverId, source: 'subuser' }
      });
      await updateSubuserInfo(serverId, authz.getSessionUser(req).id);

      invalidateServerAccessCache(serverId);
      await recordServerActivity(db, req, serverId, 'user.delete', {
        userId,
      });
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.use("/api", router);
};
