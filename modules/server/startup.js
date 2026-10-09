/* --------------------------------------------- */
/* startup                                */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY, ADMIN_KEY } = require("./core.js");
const { validate, schemas } = require('../../handlers/validate');
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Startup",
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

  // PUT /api/server/:id/startup - Update startup configuration
  router.put('/server/:serverId/startup', isAuthenticated, ownsServer, validate(schemas.serverStartup), async (req, res) => {
    try {
      let serverId = req.params.serverId;
      const { startup, environment, egg, image, skip_scripts } = req.body;

      // Resolve UUID to internal ID if needed
      if (!/^\d+$/.test(String(serverId))) {
        const listResponse = await axios.get(
          `${PANEL_URL}/api/application/servers?per_page=100000`,
          {
            headers: {
              'Authorization': `Bearer ${ADMIN_KEY}`,
              'Accept': 'application/json',
            }
          }
        );
        const matchingServer = listResponse.data.data.find(s => 
          s.attributes.identifier === serverId || s.attributes.uuid === serverId
        );
        if (!matchingServer) {
          return res.status(404).json({ error: 'Server not found' });
        }
        serverId = matchingServer.attributes.id;
      }

      // First, get the current server details
      const serverDetailsResponse = await axios.get(
        `${PANEL_URL}/api/application/servers/${serverId}?include=container`,
        {
          headers: {
            'Authorization': `Bearer ${ADMIN_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      const currentServerDetails = serverDetailsResponse.data.attributes;

      // Prepare the update payload
      const updatePayload = {
        startup: startup || currentServerDetails.container.startup_command,
        environment: environment || currentServerDetails.container.environment,
        egg: egg || currentServerDetails.egg,
        image: image || currentServerDetails.container.image,
        skip_scripts: skip_scripts !== undefined ? skip_scripts : false,
      };

      // Send the update request
      const response = await axios.patch(
        `${PANEL_URL}/api/application/servers/${serverId}/startup`,
        updatePayload,
        {
          headers: {
            'Authorization': `Bearer ${ADMIN_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      await recordServerActivity(db, req, serverId, 'settings.startup', {
        startup: updatePayload.startup,
        egg: updatePayload.egg,
        image: updatePayload.image,
        skip_scripts: updatePayload.skip_scripts,
        environmentKeys: Object.keys(updatePayload.environment || {}),
      });

      res.json(response.data);
    } catch (error) {
      console.error('Error updating server startup:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.use("/api", router);
};
