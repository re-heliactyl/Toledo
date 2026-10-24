/* --------------------------------------------- */
/* allocations                            */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, isServerOwner, PANEL_URL, API_KEY } = require("./core.js");
const { recordServerActivity } = require('../../handlers/activityLog');

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Allocations",
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

  // Get server allocations
  router.get('/server/:id/allocations', isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;

      // Fetch allocations from Pterodactyl Panel
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/network/allocations`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
          },
        }
      );

      // Transform Pterodactyl's response to the expected format
      const allocations = response.data.data.map(allocation => ({
        id: allocation.attributes.id,
        ip: allocation.attributes.ip,
        port: allocation.attributes.port,
        is_primary: allocation.attributes.is_default,
        alias: allocation.attributes.ip_alias || null,
      }));

      res.json(allocations);
    } catch (error) {
      console.error('Error fetching allocations:', error);
      res.status(500).json({
        error: 'Failed to fetch allocations',
        details: error.response?.data || error.message
      });
    }
  });

  // Add new allocation
  router.post('/server/:id/allocations', isAuthenticated, isServerOwner, async (req, res) => {
    try {
      const serverId = req.params.id;

      const response = await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/network/allocations`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      // Transform the new allocation to match the expected format
      const newAllocation = {
        id: response.data.attributes.id,
        ip: response.data.attributes.ip,
        port: response.data.attributes.port,
        is_primary: response.data.attributes.is_default,
        alias: response.data.attributes.ip_alias || null,
      };

      await recordServerActivity(db, req, serverId, 'settings.allocation.create', newAllocation);
      res.status(201).json(newAllocation);
    } catch (error) {
      console.error('Error adding allocation:', error);
      res.status(500).json({
        error: 'Failed to add allocation',
        details: error.response?.data || error.message
      });
    }
  });

  // Remove allocation
  router.delete('/server/:id/allocations/:allocationId', isAuthenticated, isServerOwner, async (req, res) => {
    try {
      const { id: serverId, allocationId } = req.params;

      // First, fetch allocations to check if this is the primary
      const allocationsResponse = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/network/allocations`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
          },
        }
      );

      const allocationToDelete = allocationsResponse.data.data.find(
        alloc => alloc.attributes.id.toString() === allocationId
      );

      if (!allocationToDelete) {
        return res.status(404).json({ error: 'Allocation not found' });
      }

      if (allocationToDelete.attributes.is_default) {
        return res.status(400).json({ error: 'Cannot delete the primary allocation' });
      }

      await axios.delete(
        `${PANEL_URL}/api/client/servers/${serverId}/network/allocations/${allocationId}`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
          },
        }
      );

      await recordServerActivity(db, req, serverId, 'settings.allocation.delete', {
        allocationId,
        ip: allocationToDelete.attributes.ip,
        port: allocationToDelete.attributes.port,
      });
      res.status(200).json({ message: 'Allocation removed successfully' });
    } catch (error) {
      console.error('Error removing allocation:', error);
      res.status(500).json({
        error: 'Failed to remove allocation',
        details: error.response?.data || error.message
      });
    }
  });

  // Set primary allocation
  router.post('/server/:id/allocations/:allocationId/set-primary', isAuthenticated, isServerOwner, async (req, res) => {
    try {
      const { id: serverId, allocationId } = req.params;

      await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/network/allocations/${allocationId}/primary`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      await recordServerActivity(db, req, serverId, 'settings.allocation.primary', {
        allocationId,
      });
      res.status(200).json({ message: 'Primary allocation updated successfully' });
    } catch (error) {
      console.error('Error setting primary allocation:', error);
      res.status(500).json({
        error: 'Failed to set primary allocation',
        details: error.response?.data || error.message
      });
    }
  });

  // Update allocation alias (notes)
  router.post('/server/:id/allocations/:allocationId/alias', isAuthenticated, isServerOwner, async (req, res) => {
    try {
      const { id: serverId, allocationId } = req.params;
      const { alias } = req.body;

      await axios.post(
        `${PANEL_URL}/api/client/servers/${serverId}/network/allocations/${allocationId}`,
        { notes: alias },
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      await recordServerActivity(db, req, serverId, 'settings.allocation.alias', {
        allocationId,
        alias,
      });
      res.status(200).json({ message: 'Allocation alias updated successfully' });
    } catch (error) {
      console.error('Error updating allocation alias:', error);
      res.status(500).json({
        error: 'Failed to update allocation alias',
        details: error.response?.data || error.message
      });
    }
  });

  app.use("/api", router);
};
