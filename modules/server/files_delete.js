/* --------------------------------------------- */
/* files_delete                           */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, requireServerPermission, PANEL_URL, API_KEY } = require("./core.js");
const { validate, schemas } = require('../../handlers/validate');
const cache = require('../../handlers/cache');
const { recordServerActivity } = require('../../handlers/activityLog');

async function invalidateFolderSizeCache(serverId) {
  await cache.delPattern(`folder_size:${serverId}:*`);
}

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files Delete",
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

  // POST /api/server/:id/files/delete
  router.post("/server/:id/files/delete", isAuthenticated, requireServerPermission("file.delete"), validate(schemas.fileDelete), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, files } = req.body;

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

      await invalidateFolderSizeCache(serverId);
      await recordServerActivity(db, req, serverId, 'files.delete', {
        root,
        files,
      });
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting files:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/server/:id/files/compress
  router.post("/server/:id/files/compress", isAuthenticated, requireServerPermission(["file.archive", "file.create"]), validate(schemas.fileCompress), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, files } = req.body;

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

      await invalidateFolderSizeCache(serverId);
      await recordServerActivity(db, req, serverId, 'files.compress', {
        root,
        files,
      });
      res.status(200).json(response.data);
    } catch (error) {
      console.error("Error compressing files:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/server/:id/files/decompress
  router.post("/server/:id/files/decompress", isAuthenticated, requireServerPermission(["file.archive", "file.create"]), validate(schemas.fileDecompress), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, file } = req.body;

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

      await invalidateFolderSizeCache(serverId);
      await recordServerActivity(db, req, serverId, 'files.decompress', {
        root,
        file,
      });
      res.status(204).send();
    } catch (error) {
      console.error("Error decompressing file:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};
