/* --------------------------------------------- */
/* server_files_delete                           */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, logActivity, PANEL_URL, API_KEY } = require("./server_core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files Delete",
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

  // POST /api/server/:id/files/delete
  router.post("/server/:id/files/delete", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, files } = req.body;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'Files array is required' });
      }

      await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/files/delete`,
        { root, files },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      await logActivity(db, serverId, 'Delete Files', { root, files });
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting files:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/server/:id/files/compress
  router.post("/server/:id/files/compress", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, files } = req.body;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'Files array is required' });
      }

      const response = await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/files/compress`,
        { root, files },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      await logActivity(db, serverId, 'Compress Files', { root, files });
      res.status(200).json(response.data);
    } catch (error) {
      console.error("Error compressing files:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/server/:id/files/decompress
  router.post("/server/:id/files/decompress", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, file } = req.body;

      if (!file) {
        return res.status(400).json({ error: 'File is required' });
      }

      await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/files/decompress`,
        { root, file },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      await logActivity(db, serverId, 'Decompress File', { root, file });
      res.status(204).send();
    } catch (error) {
      console.error("Error decompressing file:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};