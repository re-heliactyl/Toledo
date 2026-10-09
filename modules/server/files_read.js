/* --------------------------------------------- */
/* files_read                             */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files Read",
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

  // GET /api/server/:id/files/contents
  router.get("/server/:id/files/contents", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      let file = String(req.query.file || "").trim();
      if (!file) {
        return res.status(400).json({ error: "File parameter is required" });
      }
      file = file.replace(/\/+/g, '/').replace(/\/+$/, '');
      if (!file) {
        return res.status(400).json({ error: "Invalid file path" });
      }

      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/contents`,
        {
          params: { file },
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          responseType: "text", // Treat the response as plain text
        }
      );

      // Send the raw file content back to the client
      res.send(response.data);
    } catch (error) {
      console.error("Error getting file contents:", error?.response?.data || error.message);
      const status = error?.response?.status || 500;
      const errorMsg = error?.response?.data?.errors?.[0]?.detail
        || error?.response?.data?.error
        || error?.response?.data?.message
        || error.message
        || "Internal server error";
      res.status(status).json({ error: errorMsg });
    }
  });

  // GET /api/server/:id/files/download
  router.get("/server/:id/files/download", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      let file = String(req.query.file || "").trim().replace(/\/+/g, '/').replace(/\/+$/, '');
      if (!file) {
        return res.status(400).json({ error: "File parameter is required" });
      }

      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/download`,
        {
          params: { file },
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error("Error getting download link:", error?.response?.data || error.message);
      const status = error?.response?.status || 500;
      const errorMsg = error?.response?.data?.errors?.[0]?.detail
        || error?.response?.data?.error
        || error?.response?.data?.message
        || error.message
        || "Internal server error";
      res.status(status).json({ error: errorMsg });
    }
  });

  app.use("/api", router);
};
