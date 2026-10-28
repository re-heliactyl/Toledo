/* --------------------------------------------- */
/* files_transfer                         */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, requireServerPermission, PANEL_URL, API_KEY } = require("./core.js");
const { validate, schemas } = require('../../handlers/validate');
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files Transfer",
  "version": "1.1.1",
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

  // GET /api/server/:id/files/upload
  router.get("/server/:id/files/upload", isAuthenticated, requireServerPermission("file.create"), async (req, res) => {
    try {
      const serverId = req.params.id;
      const directory = req.query.directory || "/";

      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/upload`,
        {
          params: { directory },
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error("Error getting upload URL:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/server/:id/files/copy
  router.post("/server/:id/files/copy", isAuthenticated, requireServerPermission("file.create"), validate(schemas.filesCopy), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { location } = req.body;

      await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/files/copy`,
        { location },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      await recordServerActivity(db, req, serverId, 'files.copy', {
        location,
      });
      res.status(204).send();
    } catch (error) {
      console.error("Error copying files:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};
