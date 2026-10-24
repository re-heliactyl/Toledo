/* --------------------------------------------- */
/* power                                   */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const loadConfig = require("../../handlers/config");
const settings = loadConfig("./config.toml");
const { isAuthenticated, ownsServer, requireServerPermission, PANEL_URL, API_KEY, sendCommandAndGetResponse } = require("./core.js");
const { validate, schemas } = require('../../handlers/validate');
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Power",
  "version": "1.0.1",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "contributors": [{
    "name": "aachul123",
    "email": "ludo@overnode.fr",
    "url": "https://achul123.pages.dev/"
  }],
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
  if (HeliactylModule.target_platform !== settings.version) {
    process.exit();
  }

  const router = express.Router();

  /**
   * Set server power state
   * POST /api/server/:id/power
   */
  router.post("/server/:id/power", isAuthenticated, ownsServer, validate(schemas.serverPower), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { signal } = req.body;

      const signalPerms = {
        start: 'control.start',
        stop: 'control.stop',
        restart: 'control.restart',
        kill: 'control.stop'
      };
      const requiredPerm = signalPerms[signal];
      if (!req.isOwner && requiredPerm && !req.serverPermissions?.includes('*') && !req.serverPermissions?.includes('admin') && !req.serverPermissions?.includes(requiredPerm)) {
        return res.status(403).json({ error: 'You do not have permission to perform this power action', required: requiredPerm });
      }

      const response = await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/power`,
        {
          signal: signal,
        },
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
        }
      );

      if (response.status === 204) {
        await recordServerActivity(db, req, serverId, `server.${signal}`, {
          signal,
        });
        res.status(204).send();
      } else {
        throw new Error('Unexpected response from panel');
      }
    } catch (error) {
      console.error("Error changing power state:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * Send command to server
   * POST /api/server/:id/command
   */
  router.post("/server/:id/command", isAuthenticated, requireServerPermission("control.console"), validate(schemas.serverCommand), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { command } = req.body;

      await sendCommandAndGetResponse(serverId, command);
      await recordServerActivity(db, req, serverId, 'server.command', {
        command,
      });

      res.json({ success: true, message: "Command sent successfully" });
    } catch (error) {
      console.error("Error sending command:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Use the router with the '/api' prefix
  app.use("/api", router);
};
