/* --------------------------------------------- */
/* server_power                                   */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const loadConfig = require("../handlers/config");
const settings = loadConfig("./config.toml");
const { isAuthenticated, ownsServer, logActivity, PANEL_URL, API_KEY } = require("./server_core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Power",
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
  if (HeliactylModule.target_platform !== settings.version) {
    console.log(
      "Module " +
      HeliactylModule.name +
      " does not support this platform release of Heliactyl Next. The module was built for platform " +
      HeliactylModule.target_platform +
      " but is attempting to run on version " +
      settings.version +
      "."
    );
    process.exit();
  }

  const router = express.Router();

  /**
   * Set server power state
   * POST /api/server/:id/power
   */
  router.post("/server/:id/power", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const { signal } = req.body;

      // Validate power signal
      const validSignals = ['start', 'stop', 'restart', 'kill'];
      if (!validSignals.includes(signal)) {
        return res.status(400).json({ error: 'Invalid power signal' });
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
        await logActivity(db, serverId, 'Power Action', { signal });
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
  router.post("/server/:id/command", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const { command } = req.body;

      if (!command) {
        return res.status(400).json({ error: 'Command is required' });
      }

      await sendCommandAndGetResponse(serverId, command);
      await logActivity(db, serverId, 'Send Command', { command });

      res.json({ success: true, message: "Command sent successfully" });
    } catch (error) {
      console.error("Error sending command:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Use the router with the '/api' prefix
  app.use("/api", router);
};