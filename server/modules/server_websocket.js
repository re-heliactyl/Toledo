/* --------------------------------------------- */
/* server_websocket                              */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./server_core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> WebSocket",
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

  // GET /api/server/:id/websocket - Get WebSocket credentials
  router.get("/server/:id/websocket", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/websocket`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      // Return the WebSocket credentials to the client
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching WebSocket credentials:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/server/:id - Get server details (needed for console)
  router.get("/server/:id", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}`,
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
      console.error("Error fetching server details:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};