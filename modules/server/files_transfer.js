/* --------------------------------------------- */
/* files_transfer                         */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");
const { validate, schemas } = require('../../handlers/validate');
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files Transfer",
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
  router.get("/server/:id/files/upload", isAuthenticated, ownsServer, async (req, res) => {
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
  router.post("/server/:id/files/copy", isAuthenticated, ownsServer, validate(schemas.filesCopy), async (req, res) => {
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

  async function getAvailableAllocations(nodeId) {
    const response = await axios.get(
      `${PANEL_URL}/nodes/${nodeId}/allocations?per_page=10000`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data.filter(allocation => !allocation.attributes.assigned);
  }

  // GET server details helper
  async function getServerDetails(serverId) {
    const response = await axios.get(
      `${PANEL_URL}/api/application/servers/${serverId}`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data;
  }

  // Server transfer endpoint
  router.get("/server/transfer", isAuthenticated, ownsServer, async (req, res) => {
    const { id, nodeId } = req.query;

    if (!id || !nodeId) {
      return res.status(400).json({ error: "Missing required parameters: id or nodeId" });
    }

    try {
      const server = await getServerDetails(id);
      const availableAllocations = await getAvailableAllocations(nodeId);

      if (availableAllocations.length === 0) {
        return res.status(500).json({ error: "No available allocations on the target node" });
      }

      await axios.post(
        `${PANEL_URL}/admin/servers/view/${id}/manage/transfer`,
        {
          node_id: nodeId,
          allocation_id: availableAllocations[0].attributes.id
        },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      await recordServerActivity(db, req, id, 'server.transfer', {
        nodeId,
      });
      res.status(200).json({
        message: `Transfer for server ${id} to node ${nodeId} initiated.`,
      });
    } catch (error) {
      console.error("Error transferring server:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};
