/* --------------------------------------------- */
/* variables                              */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");
const { validate, schemas } = require('../../handlers/validate');
const { recordServerActivity } = require('../../handlers/activityLog');

function respondWithUpstreamError(res, error, fallbackMessage) {
  const status = error.response?.status;
  const retryAfter = error.response?.headers?.['retry-after'];

  if (retryAfter) {
    res.set('Retry-After', retryAfter);
  }

  if (status && status >= 400 && status < 500) {
    return res.status(status).json(
      error.response?.data ?? { error: fallbackMessage }
    );
  }

  return res.status(500).json({ error: 'Internal server error' });
}

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Variables",
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

  // GET /api/server/:id/variables - Get server variables
  router.get('/server/:id/variables', isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/startup`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: 'application/json',
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      console.error('Error fetching server variables:', error);
      return respondWithUpstreamError(
        res,
        error,
        'Unable to fetch server variables from the panel'
      );
    }
  });

  // PUT /api/server/:id/variables - Update server variable
  router.put('/server/:id/variables', isAuthenticated, ownsServer, validate(schemas.serverVariable), async (req, res) => {
    try {
      const serverId = req.params.id;
      const { key, value } = req.body;

      const response = await axios.put(
        `${PANEL_URL}/api/client/servers/${serverId}/startup/variable`,
        { key, value },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );
      await recordServerActivity(db, req, serverId, 'settings.variable', {
        key,
        value,
      });
      res.json(response.data);
    } catch (error) {
      console.error('Error updating server variable:', error);
      return respondWithUpstreamError(
        res,
        error,
        'Unable to update server variable in the panel'
      );
    }
  });

  app.use("/api", router);
};
