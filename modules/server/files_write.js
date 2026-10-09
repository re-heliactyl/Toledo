/* --------------------------------------------- */
/* files_write                            */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");
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
  "name": "Server -> Files Write",
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

  // POST /api/server/:id/files/write
  router.post("/server/:id/files/write", isAuthenticated, ownsServer, express.text({ limit: "50mb", type: "*/*" }), async (req, res) => {
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

      let content = req.body;
      if (content === undefined || content === null) {
        content = "";
      } else if (typeof content !== "string") {
        content = typeof content === "object" ? JSON.stringify(content, null, 2) : String(content);
      }

      const response = await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/files/write`,
        content,
        {
          params: { file },
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "text/plain",
          },
        }
      );

      // Log response status & text if error
      if (response.status !== 204) {
        console.error("Error writing file:", response.status, response.statusText, response.data);
        const errorMsg = response.data?.errors?.[0]?.detail
          || response.data?.error
          || response.data?.message
          || response.statusText
          || "Failed to write file";
        return res.status(response.status).json({ error: errorMsg });
      }

      await invalidateFolderSizeCache(serverId);
      await recordServerActivity(db, req, serverId, 'files.write', {
        file,
      });
      res.status(204).send();
    } catch (error) {
      console.error("Error writing file:", error?.response?.data || error.message);
      const status = error?.response?.status || 500;
      const errorMsg = error?.response?.data?.errors?.[0]?.detail
        || error?.response?.data?.error
        || error?.response?.data?.message
        || error.message
        || "Internal server error";
      res.status(status).json({ error: errorMsg });
    }
  });

  // POST /api/server/:id/files/create-folder
  router.post("/server/:id/files/create-folder", isAuthenticated, ownsServer, validate(schemas.fileCreateFolder), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, name } = req.body;

      await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/files/create-folder`,
        { root, name },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      await invalidateFolderSizeCache(serverId);
      await recordServerActivity(db, req, serverId, 'files.create', {
        root,
        name,
      });
      res.status(204).send();
    } catch (error) {
      console.error("Error creating folder:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/server/:id/files/rename
  router.put("/server/:id/files/rename", isAuthenticated, ownsServer, validate(schemas.fileRename), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { root, files } = req.body;

      await axios.put(
        `${PANEL_URL}/api/client/servers/${serverId}/files/rename`,
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
      await recordServerActivity(db, req, serverId, 'files.rename', {
        root,
        files,
      });
      res.status(204).send();
    } catch (error) {
      console.error("Error renaming file/folder:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};
