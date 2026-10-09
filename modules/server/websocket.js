/* --------------------------------------------- */
/* websocket                              */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");
const { fetchWebSocketCredentials } = require("./websocketCredentials.js");
const { applySftpIpMode, getSftpIpMode } = require("../../handlers/sftp");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> WebSocket",
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
module.exports.load = async function (app, db) {
  const router = express.Router();

  // GET /api/server/:id/websocket - Get WebSocket credentials
  router.get("/server/:id/websocket", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const responseData = await fetchWebSocketCredentials({
        serverId,
        panelUrl: PANEL_URL,
        apiKey: API_KEY,
      });

      // Return the WebSocket credentials to the client
      res.json(responseData);
    } catch (error) {
      console.error("Error fetching WebSocket credentials:", error);

      if (error.response?.status === 429) {
        const retryAfter = error.response.headers?.["retry-after"];

        if (retryAfter) {
          res.set("Retry-After", retryAfter);
        }

        return res.status(429).json(
          error.response.data ?? { error: "Rate limited while fetching WebSocket credentials" }
        );
      }

      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};
