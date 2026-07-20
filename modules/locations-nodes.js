const express = require('express');
const axios = require('axios');
const loadConfig = require('../handlers/config.js');
const log = require('../handlers/log.js');
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');

const settings = loadConfig('./config.toml');

const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${settings.pterodactyl.key}`
  }
});

const LAST_SYNC_KEY = 'locations-nodes-last-sync';

const HeliactylModule = {
  name: 'Locations & Nodes',
  version: '1.0.0',
  api_level: 4,
  target_platform: '10.0.0',
  description: 'Dynamic location and node management with Pterodactyl sync',
  author: {
    name: 'aachul123',
    email: 'ludo@overnode.fr',
    url: 'https://achul123.pages.dev/'
  },
  dependencies: [],
  permissions: [],
  routes: [],
  config: {},
  hooks: [],
  tags: ['core'],
  license: 'MIT'
};

module.exports.HeliactylModule = HeliactylModule;

function safeJsonParse(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function checkAdminStatus(req, res, db, requiredPerm = 'admin.nodes.view') {
  const authz = createAuthz(db);
  return authz.hasPermission(req, requiredPerm);
}

async function getLocationsFromDB(db) {
  const locations = await db.locationConfig.findMany({
    orderBy: [
      { orderIndex: 'asc' },
      { pterodactylLocationId: 'asc' }
    ]
  });

  return locations.map((location) => ({
    id: location.id,
    pterodactylLocationId: location.pterodactylLocationId,
    name: location.name,
    description: location.description,
    enabled: location.enabled,
    packages: safeJsonParse(location.packages, []),
    full: location.full,
    flags: safeJsonParse(location.flags, []),
    order: location.orderIndex,
    lastSyncedAt: location.lastSyncedAt?.toISOString() || null
  }));
}

async function getNodesFromDB(db) {
  const nodes = await db.nodeConfig.findMany({
    include: {
      location: true
    },
    orderBy: [
      { locationId: 'asc' },
      { pterodactylNodeId: 'asc' }
    ]
  });

  return nodes.map((node) => ({
    id: node.id,
    pterodactylNodeId: node.pterodactylNodeId,
    locationId: node.locationId,
    locationName: node.location?.name || null,
    name: node.name,
    fqdn: node.fqdn,
    memory: node.memory,
    disk: node.disk,
    allocated_resources: safeJsonParse(node.allocatedResources, {}),
    enabled: node.enabled,
    lastSyncedAt: node.lastSyncedAt?.toISOString() || null
  }));
}

async function syncLocationsAndNodes(db) {
  const [locationsResponse, nodesResponse, existingLocations, existingNodes] = await Promise.all([
    pteroApi.get('/api/application/locations?per_page=10000'),
    pteroApi.get('/api/application/nodes?per_page=10000'),
    db.locationConfig.findMany(),
    db.nodeConfig.findMany()
  ]);

  const existingLocationMap = new Map(existingLocations.map((location) => [location.id, location]));
  const existingNodeMap = new Map(existingNodes.map((node) => [node.id, node]));
  const syncedAt = new Date();

  const locationIdsWithNodes = new Set(
    nodesResponse.data.data.map((node) => String(node.attributes.location_id))
  );

  const locationRows = locationsResponse.data.data.map((location, index) => {
    const locationId = String(location.attributes.id);
    const existing = existingLocationMap.get(locationId);
    const hasNodes = locationIdsWithNodes.has(locationId);

    return {
      id: locationId,
      pterodactylLocationId: location.attributes.id,
      name: existing?.name || location.attributes.long || location.attributes.short || `Location ${locationId}`,
      description: existing?.description || location.attributes.long || '',
      enabled: existing?.enabled ?? hasNodes,
      packages: existing?.packages || '[]',
      full: existing?.full ?? false,
      flags: existing?.flags || '[]',
      orderIndex: existing?.orderIndex ?? index,
      lastSyncedAt: syncedAt
    };
  });

  const availableLocationIds = new Set(locationRows.map((location) => location.id));

  const nodeRows = nodesResponse.data.data
    .filter((node) => availableLocationIds.has(String(node.attributes.location_id)))
    .map((node) => {
      const nodeId = String(node.attributes.id);
      const existing = existingNodeMap.get(nodeId);

      return {
        id: nodeId,
        pterodactylNodeId: node.attributes.id,
        locationId: String(node.attributes.location_id),
        name: node.attributes.name,
        fqdn: node.attributes.fqdn,
        memory: node.attributes.memory || 0,
        disk: node.attributes.disk || 0,
        allocatedResources: JSON.stringify(node.attributes.allocated_resources || {}),
        enabled: existing?.enabled ?? true,
        lastSyncedAt: syncedAt
      };
    });

  await db.$transaction([
    ...locationRows.map((location) => db.locationConfig.upsert({
      where: { id: location.id },
      update: {
        pterodactylLocationId: location.pterodactylLocationId,
        name: location.name,
        description: location.description,
        enabled: location.enabled,
        packages: location.packages,
        full: location.full,
        flags: location.flags,
        orderIndex: location.orderIndex,
        lastSyncedAt: location.lastSyncedAt
      },
      create: location
    })),
    ...nodeRows.map((node) => db.nodeConfig.upsert({
      where: { id: node.id },
      update: {
        pterodactylNodeId: node.pterodactylNodeId,
        locationId: node.locationId,
        name: node.name,
        fqdn: node.fqdn,
        memory: node.memory,
        disk: node.disk,
        allocatedResources: node.allocatedResources,
        enabled: node.enabled,
        lastSyncedAt: node.lastSyncedAt
      },
      create: node
    })),
    db.nodeConfig.deleteMany({
      where: {
        id: {
          notIn: nodeRows.map((node) => node.id)
        }
      }
    }),
    db.locationConfig.deleteMany({
      where: {
        id: {
          notIn: locationRows.map((location) => location.id)
        }
      }
    }),
    db.heliactyl.upsert({
      where: { key: LAST_SYNC_KEY },
      update: { value: JSON.stringify(syncedAt.toISOString()) },
      create: { key: LAST_SYNC_KEY, value: JSON.stringify(syncedAt.toISOString()) }
    })
  ]);

  return {
    syncedCount: nodeRows.length,
    locationCount: locationRows.length,
    nodeCount: nodeRows.length,
    lastSync: syncedAt.toISOString()
  };
}

module.exports.getLocationsFromDB = getLocationsFromDB;
module.exports.getNodesFromDB = getNodesFromDB;
module.exports.syncLocationsAndNodes = syncLocationsAndNodes;

module.exports.load = async function (app, db) {
  const router = express.Router();

  // Public endpoint - counts of enabled locations and nodes
  router.get('/locations', async (req, res) => {
    try {
      const [locations, nodes] = await Promise.all([
        db.locationConfig.count({ where: { enabled: true } }),
        db.nodeConfig.count({ where: { enabled: true } })
      ]);

      res.json({ locations, nodes });
    } catch (error) {
      console.error('Error fetching location counts:', error);
      res.status(500).json({ error: 'Failed to fetch location counts' });
    }
  });

  router.get('/admin/locations-nodes', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      let [locations, nodes] = await Promise.all([
        getLocationsFromDB(db),
        getNodesFromDB(db)
      ]);

      if (locations.length === 0) {
        await syncLocationsAndNodes(db);
        [locations, nodes] = await Promise.all([
          getLocationsFromDB(db),
          getNodesFromDB(db)
        ]);
      }

      const nodesByLocationId = nodes.reduce((accumulator, node) => {
        if (!accumulator[node.locationId]) {
          accumulator[node.locationId] = [];
        }

        accumulator[node.locationId].push(node);
        return accumulator;
      }, {});

      const lastSyncRow = await db.heliactyl.findUnique({ where: { key: LAST_SYNC_KEY } });

      res.json({
        locations: locations.map((location) => ({
          ...location,
          nodes: nodesByLocationId[location.id] || []
        })),
        lastSync: lastSyncRow ? safeJsonParse(lastSyncRow.value, null) : null
      });
    } catch (error) {
      console.error('Error fetching locations and nodes:', error);
      res.status(500).json({ error: 'Failed to fetch locations and nodes' });
    }
  });

  router.post('/admin/locations-nodes/sync', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const syncResult = await syncLocationsAndNodes(db);

      log(
        'locations_nodes_synced',
        `${req.session.userinfo.username} synced ${syncResult.locationCount} locations and ${syncResult.nodeCount} nodes from Pterodactyl.`
      );

      res.json({
        success: true,
        ...syncResult
      });
    } catch (error) {
      console.error('Error syncing locations and nodes:', error);
      res.status(500).json({ error: 'Failed to sync locations and nodes from Pterodactyl' });
    }
  });

  router.patch('/admin/locations/:id', validate(schemas.locationConfigUpdate), async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const locationId = req.params.id;
      const existing = await db.locationConfig.findUnique({ where: { id: locationId } });

      if (!existing) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const updates = {};

      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.description !== undefined) updates.description = req.body.description;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      if (req.body.packages !== undefined) updates.packages = JSON.stringify(req.body.packages);
      if (req.body.full !== undefined) updates.full = req.body.full;
      if (req.body.flags !== undefined) updates.flags = JSON.stringify(req.body.flags);
      if (req.body.order !== undefined) updates.orderIndex = req.body.order;

      const location = await db.locationConfig.update({
        where: { id: locationId },
        data: updates
      });

      res.json({
        success: true,
        location: {
          id: location.id,
          pterodactylLocationId: location.pterodactylLocationId,
          name: location.name,
          description: location.description,
          enabled: location.enabled,
          packages: safeJsonParse(location.packages, []),
          full: location.full,
          flags: safeJsonParse(location.flags, []),
          order: location.orderIndex,
          lastSyncedAt: location.lastSyncedAt?.toISOString() || null
        }
      });
    } catch (error) {
      console.error('Error updating location:', error);
      res.status(500).json({ error: 'Failed to update location' });
    }
  });

  router.patch('/admin/locations/:id/toggle', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const locationId = req.params.id;
      const existing = await db.locationConfig.findUnique({ where: { id: locationId } });

      if (!existing) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const location = await db.locationConfig.update({
        where: { id: locationId },
        data: { enabled: !existing.enabled }
      });

      res.json({ success: true, enabled: location.enabled });
    } catch (error) {
      console.error('Error toggling location:', error);
      res.status(500).json({ error: 'Failed to toggle location' });
    }
  });

  router.patch('/admin/nodes/:id', validate(schemas.nodeConfigUpdate), async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const nodeId = req.params.id;
      const existing = await db.nodeConfig.findUnique({ where: { id: nodeId } });

      if (!existing) {
        return res.status(404).json({ error: 'Node not found' });
      }

      const node = await db.nodeConfig.update({
        where: { id: nodeId },
        data: {
          enabled: req.body.enabled !== undefined ? req.body.enabled : existing.enabled
        }
      });

      res.json({ success: true, enabled: node.enabled });
    } catch (error) {
      console.error('Error updating node:', error);
      res.status(500).json({ error: 'Failed to update node' });
    }
  });

  router.patch('/admin/nodes/:id/toggle', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const nodeId = req.params.id;
      const existing = await db.nodeConfig.findUnique({ where: { id: nodeId } });

      if (!existing) {
        return res.status(404).json({ error: 'Node not found' });
      }

      const node = await db.nodeConfig.update({
        where: { id: nodeId },
        data: { enabled: !existing.enabled }
      });

      res.json({ success: true, enabled: node.enabled });
    } catch (error) {
      console.error('Error toggling node:', error);
      res.status(500).json({ error: 'Failed to toggle node' });
    }
  });

  app.use('/api', router);
};
