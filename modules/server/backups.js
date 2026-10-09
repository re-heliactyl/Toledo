/* --------------------------------------------- */
/* backups                                */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Backups",
  "version": "1.0.1",
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
module.exports.load = async function (app, db) {
  const router = express.Router();

  const getUpstreamError = (error, fallback = 'Internal server error') => {
    const status = error.response?.status || 500;
    const detail = error.response?.data?.errors?.[0]?.detail;
    const message = error.response?.data?.error || detail || error.message || fallback;

    return { status, message };
  };

  // GET /api/server/:id/backups - List backups
  router.get("/server/:id/backups", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/backups`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching backups:", error);
      const { status, message } = getUpstreamError(error, 'Failed to fetch backups');
      res.status(status).json({ error: message });
    }
  });

  // POST /api/server/:id/backups - Create backup
  router.post("/server/:id/backups", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const response = await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/backups`,
        {},
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );
      await recordServerActivity(db, req, serverId, 'backup.create', {
        backup: response.data?.attributes?.uuid || null,
        name: response.data?.attributes?.name || null,
      });
      res.status(201).json(response.data);
    } catch (error) {
      console.error("Error creating backup:", error);
      const { status, message } = getUpstreamError(error, 'Failed to create backup');
      res.status(status).json({ error: message });
    }
  });

  // GET /api/server/:id/backups/:backupId/download - Get backup download URL
  router.get(
    "/server/:id/backups/:backupId/download",
    isAuthenticated,
    ownsServer,
    async (req, res) => {
      try {
        const serverId = req.params.id;
        const backupId = req.params.backupId;
        const response = await axios.get(
          `${PANEL_URL}/api/client/servers/${serverId}/backups/${backupId}/download`,
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          }
        );
        await recordServerActivity(db, req, serverId, 'backup.download', {
          backupId,
        });
        res.json(response.data);
      } catch (error) {
        console.error("Error generating backup download link:", error);
        const { status, message } = getUpstreamError(error, 'Failed to generate backup download link');
        res.status(status).json({ error: message });
      }
    }
  );

  // DELETE /api/server/:id/backups/:backupId - Delete backup
  router.delete(
    "/server/:id/backups/:backupId",
    isAuthenticated,
    ownsServer,
    async (req, res) => {
      try {
        const serverId = req.params.id;
        const backupId = req.params.backupId;
        await axios.delete(
          `${PANEL_URL}/api/client/servers/${serverId}/backups/${backupId}`,
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          }
        );
        await recordServerActivity(db, req, serverId, 'backup.delete', {
          backupId,
        });
        res.status(204).send();
      } catch (error) {
        console.error("Error deleting backup:", error);
        const { status, message } = getUpstreamError(error, 'Failed to delete backup');
        res.status(status).json({ error: message });
      }
    }
  );

  app.use("/api", router);
};
