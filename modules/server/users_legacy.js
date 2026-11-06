const { validate, schemas } = require('../../handlers/validate');
/* --------------------------------------------- */
/* users_legacy                           */
/* --------------------------------------------- */

const express = require("express");
const { isAuthenticated } = require("./core.js");
const { updateSubuserInfo } = require("./users.js");
const createAuthz = require('../../handlers/authz');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Users Legacy",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "dependencies": [{ "name": "server/core", "optional": false }],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const router = express.Router();
  const authz = createAuthz(db);

  // GET /api/subuser-servers - List servers where user is a subuser
  router.get('/subuser-servers', isAuthenticated, validate(schemas.emptyPayload, 'query'), async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const results = await db.subuserServer.findMany({
        where: { userId: sessionUser.id }
      });

      const allServers = results.map(s => ({
        id: s.serverId,
        name: s.serverName,
        ownerId: s.ownerId
      }));

      res.json(allServers);
    } catch (error) {
      console.error('Error fetching subuser servers:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sync-user-servers - Sync user's servers and subuser permissions
  router.post('/subuser-servers-sync', isAuthenticated, validate(schemas.emptyPayload), async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const pteroUser = authz.getPterodactylUser(req);
      const pteroUsername = pteroUser.username;
      const pteroId = pteroUser.id;
      const userId = sessionUser.id;

      // Update user mappings in User table
      await db.user.update({
        where: { id: userId },
        data: { pteroUsername, pterodactylId: pteroId }
      });

      // Sync owned servers
      const ownedServers = pteroUser.relationships.servers.data;
      for (const server of ownedServers) {
        await updateSubuserInfo(server.attributes.identifier, userId);
      }

      // Fetch and sync subuser servers for the user from the database
      const results = await db.subuserServer.findMany({
        where: { userId: userId }
      });

      const allServers = results.map(s => ({
        id: s.serverId,
        ownerId: s.ownerId
      }));

      // Update all servers' subuser info from Pterodactyl
      for (const server of allServers) {
        await updateSubuserInfo(server.id, server.ownerId);
      }

      res.json({
        success: true,
        message: 'User servers synced successfully',
        servers: allServers.length
      });
    } catch (error) {
      console.error('Error syncing user servers:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  app.use("/api", router);
};
