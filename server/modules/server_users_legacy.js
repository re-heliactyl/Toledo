/* --------------------------------------------- */
/* server_users_legacy                           */
/* --------------------------------------------- */

const express = require("express");
const { isAuthenticated } = require("./server_core.js");
const { updateSubuserInfo } = require("./server_users.js");

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
  "dependencies": [],
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

  // GET /api/subuser-servers - List servers where user is a subuser
  router.get('/subuser-servers', isAuthenticated, async (req, res) => {
    try {
      // Get identifiers for both systems
      const pteroUsername = req.session.pterodactyl.username;
      const discordId = req.session.userinfo.id;

      // Get servers from both storage methods
      const pteroServers = await db.get(`subuser-servers-${pteroUsername}`) || [];
      const discordServers = await db.get(`subuser-servers-discord-${discordId}`) || [];

      // Merge the two lists, avoiding duplicates
      const allServers = [...pteroServers];
      const serverIds = new Set(pteroServers.map(s => s.id));

      discordServers.forEach(server => {
        if (!serverIds.has(server.id)) {
          allServers.push(server);
          serverIds.add(server.id);
        }
      });

      res.json(allServers);
    } catch (error) {
      console.error('Error fetching subuser servers:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sync-user-servers - Sync user's servers and subuser permissions
  router.post('/subuser-servers-sync', isAuthenticated, async (req, res) => {
    try {
      const pteroUsername = req.session.pterodactyl.username;
      const pteroId = req.session.pterodactyl.id;
      const discordId = req.session.userinfo.id;

      // Add the current user to the all_users list
      await addUserToAllUsersList(pteroId, db);

      // Map Discord ID to Pterodactyl username and vice versa
      await updateUserMappings(pteroUsername, discordId, pteroId, db);

      // Sync owned servers
      const ownedServers = req.session.pterodactyl.relationships.servers.data;
      for (const server of ownedServers) {
        await updateSubuserInfo(server.attributes.identifier, discordId, db);
      }

      // Fetch and sync subuser servers from both systems
      const pteroServers = await db.get(`subuser-servers-${pteroUsername}`) || [];
      const discordServers = await db.get(`subuser-servers-discord-${discordId}`) || [];

      // Merge the two arrays
      const allServers = [...pteroServers];
      const serverIds = new Set(pteroServers.map(s => s.id));

      discordServers.forEach(server => {
        if (!serverIds.has(server.id)) {
          allServers.push(server);
          serverIds.add(server.id);
        }
      });

      // Update all servers
      for (const server of allServers) {
        await updateSubuserInfo(server.id, server.ownerId, db);
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

  async function addUserToAllUsersList(userId, db) {
    if (!userId) return;

    let allUsers = await db.get('all_users') || [];
    if (!allUsers.includes(userId)) {
      allUsers.push(userId);
      await db.set('all_users', allUsers);
    }
  }

  async function updateUserMappings(pteroUsername, discordId, pteroId, db) {
    if (!pteroUsername || !discordId) return;

    // Create ptero-to-discord mapping
    let pteroMap = await db.get('pterodactyl-discord-map') || {};
    pteroMap[pteroUsername] = discordId;
    await db.set('pterodactyl-discord-map', pteroMap);

    // Create discord-to-ptero mapping
    let discordMap = await db.get('discord-pterodactyl-map') || {};
    discordMap[discordId] = {
      username: pteroUsername,
      id: pteroId,
      updatedAt: new Date().toISOString()
    };
    await db.set('discord-pterodactyl-map', discordMap);
  }

  app.use("/api", router);
};