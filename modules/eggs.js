const express = require('express');
const axios = require('axios');
const loadConfig = require('../handlers/config.js');
const settings = loadConfig('./config.toml');
const log = require('../handlers/log.js');
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

const HeliactylModule = {
  "name": "Eggs",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Dynamic egg management with Pterodactyl sync",
  "author": {
    "name": "aachul123",
    "email": "ludo@overnode.fr",
    "url": "https://achul123.pages.dev/"
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

// Check admin status utility function
async function checkAdminStatus(req, res, db, requiredPerm = 'admin.eggs.view') {
  const authz = createAuthz(db);
  return authz.hasPermission(req, requiredPerm);
}

/**
 * Get all eggs from database with their configurations
 */
async function getEggsFromDB(db) {
  const eggRows = await db.eggConfig.findMany();
  const eggs = {};
  for (const row of eggRows) {
    eggs[row.id] = {
      pterodactylNestId: row.pterodactylNestId,
      pterodactylEggId: row.pterodactylEggId,
      nestName: row.nestName,
      originalName: row.originalName,
      displayName: row.displayName,
      description: row.description,
      dockerImage: row.dockerImage,
      startup: row.startup,
      environment: JSON.parse(row.environment),
      enabled: row.enabled,
      category: row.categoryId || 'other',
      minimum: JSON.parse(row.minimum),
      maximum: row.maximum ? JSON.parse(row.maximum) : null,
      packages: JSON.parse(row.packages),
      featureLimits: JSON.parse(row.featureLimits),
      order: row.orderIndex,
      lastSyncedAt: row.lastSyncedAt?.toISOString() || null
    };
  }
  return eggs;
}


/**
 * Get all categories from database
 */
async function getCategoriesFromDB(db) {
  const categories = await db.eggCategory.findMany({ orderBy: { orderIndex: 'asc' } });
  if (categories.length === 0) {
    return [
      { id: 'minecraft', name: 'Minecraft', icon: 'cube', order: 0 },
      { id: 'discord', name: 'Discord Bots', icon: 'message-circle', order: 1 },
      { id: 'web', name: 'Web Hosting', icon: 'globe', order: 2 },
      { id: 'game', name: 'Game Servers', icon: 'gamepad-2', order: 3 },
      { id: 'other', name: 'Other', icon: 'box', order: 99 }
    ];
  }
  return categories.map(c => ({ id: c.id, name: c.name, icon: c.icon, order: c.orderIndex }));
}
/**
 * Ensure default categories exist in database
 */
async function ensureDefaultCategories(db) {
  const defaults = [
    { id: 'minecraft', name: 'Minecraft', icon: 'cube', orderIndex: 0 },
    { id: 'discord', name: 'Discord Bots', icon: 'message-circle', orderIndex: 1 },
    { id: 'web', name: 'Web Hosting', icon: 'globe', orderIndex: 2 },
    { id: 'game', name: 'Game Servers', icon: 'gamepad-2', orderIndex: 3 },
    { id: 'other', name: 'Other', icon: 'box', orderIndex: 99 }
  ];

  for (const category of defaults) {
    await db.eggCategory.upsert({
      where: { id: category.id },
      update: {},
      create: category
    });
  }
  return defaults.map(d => d.id);
}



module.exports.load = async function (app, db) {
  const router = express.Router();
  // Ensure categories exist on load
  ensureDefaultCategories(db).catch(err => console.error("Error ensuring categories:", err));


  // ============================================
  // PUBLIC ENDPOINTS (for server creation)
  // ============================================

  /**
   * GET /api/eggs
   * Get all enabled eggs for server creation (public, requires auth)
   */
  router.get('/eggs', async (req, res) => {
    try {
      if (!req.session.pterodactyl) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const eggs = await getEggsFromDB(db);
      const categories = await getCategoriesFromDB(db);

      const userRecord = await db.user.findUnique({ where: { id: req.session.userinfo.id }, select: { packageName: true } });
      const userPackage = userRecord?.packageName || settings.api.client.packages.default;

      // Filter enabled eggs and format for client
      const enabledEggs = Object.entries(eggs)
        .filter(([_, egg]) => egg.enabled)
        .filter(([_, egg]) => {
          // Check package restrictions
          if (egg.packages && egg.packages.length > 0) {
            return egg.packages.includes(userPackage);
          }
          return true;
        })
        .map(([id, egg]) => ({
          id,
          name: egg.displayName || egg.originalName,
          description: egg.description || '',
          category: egg.category || 'other',
          minimum: {
            ram: egg.minimum?.ram || 0,
            disk: egg.minimum?.disk || 0,
            cpu: egg.minimum?.cpu || 0
          },
          maximum: egg.maximum || null,
          info: {
            egg: egg.pterodactylEggId,
            docker_image: egg.dockerImage,
            startup: egg.startup,
            environment: egg.environment || {},
            feature_limits: egg.featureLimits || { databases: 4, backups: 4 }
          }
        }));

      // Group by category
      const groupedEggs = {};
      for (const category of categories) {
        groupedEggs[category.id] = {
          ...category,
          eggs: enabledEggs.filter(e => e.category === category.id)
        };
      }

      res.json({
        eggs: enabledEggs,
        categories: groupedEggs
      });
    } catch (error) {
      console.error('Error fetching eggs:', error);
      res.status(500).json({ error: 'Failed to fetch eggs' });
    }
  });

  /**
   * GET /api/eggs/categories
   * Get all categories
   */
  router.get('/eggs/categories', async (req, res) => {
    try {
      if (!req.session.pterodactyl) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const categories = await getCategoriesFromDB(db);
      res.json(categories);
    } catch (error) {
      console.error('Error fetching categories:', error);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  // ============================================
  // ADMIN ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/eggs
   * Get all eggs with full configuration (admin only)
   */
  router.get('/admin/eggs', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const eggs = await getEggsFromDB(db);
      const categories = await getCategoriesFromDB(db);

      const lastSyncRow = await db.heliactyl.findUnique({ where: { key: 'eggs-last-sync' } });
      res.json({
        eggs,
        categories,
        lastSync: lastSyncRow ? JSON.parse(lastSyncRow.value) : null
      });
    } catch (error) {
      console.error('Error fetching admin eggs:', error);
      res.status(500).json({ error: 'Failed to fetch eggs' });
    }
  });


  /**
   * POST /api/admin/eggs/sync
   * Sync eggs from Pterodactyl panel
   */
  router.post('/admin/eggs/sync', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      // Ensure categories exist before sync and get valid IDs
      const validCategoryIds = await db.eggCategory.findMany({ select: { id: true } }).then(cats => cats.map(c => c.id));
      if (!validCategoryIds.includes('other')) await ensureDefaultCategories(db);

      // Get all nests
      const nestsResponse = await pteroApi.get('/api/application/nests?per_page=10000');
      const nests = nestsResponse.data.data;

      // Get existing eggs config
      const existingEggs = await getEggsFromDB(db);
      const newEggs = {};
      let syncedCount = 0;
      let newCount = 0;

      // Fetch eggs for each nest
      for (const nest of nests) {
        const nestId = nest.attributes.id;
        const nestName = nest.attributes.name;

        try {
          const eggsResponse = await pteroApi.get(
            `/api/application/nests/${nestId}/eggs?include=variables&per_page=10000`
          );
          const eggs = eggsResponse.data.data;

          for (const egg of eggs) {
            const eggId = `${nestId}_${egg.attributes.id}`;
            const existingEgg = existingEggs[eggId];
            const normalizedDescription = (egg.attributes.description || '').slice(0, 1000);

            // Build environment from variables
            const environment = {};
            if (egg.attributes.relationships?.variables?.data) {
              for (const variable of egg.attributes.relationships.variables.data) {
                environment[variable.attributes.env_variable] = variable.attributes.default_value || '';
              }
            }

            // Determine category based on nest name
            let category = 'other';
            const nestNameLower = nestName.toLowerCase();
            if (nestNameLower.includes('minecraft')) category = 'minecraft';
            else if (nestNameLower.includes('discord') || nestNameLower.includes('bot')) category = 'discord';
            else if (nestNameLower.includes('web') || nestNameLower.includes('hosting')) category = 'web';
            else if (nestNameLower.includes('game')) category = 'game';

            let finalCategory = existingEgg?.category || category;
            if (!validCategoryIds.includes(finalCategory)) finalCategory = 'other';

            newEggs[eggId] = {
              // Pterodactyl data (always updated on sync)
              pterodactylNestId: nestId,
              pterodactylEggId: egg.attributes.id,
              nestName: nestName,
              originalName: egg.attributes.name,
              description: normalizedDescription,
              dockerImage: egg.attributes.docker_image,
              startup: egg.attributes.startup,
              environment: environment,

              // Configuration (preserve existing or set defaults)
              enabled: existingEgg?.enabled ?? false,
              displayName: existingEgg?.displayName || egg.attributes.name,
              category: finalCategory,
              minimum: existingEgg?.minimum || { ram: 512, disk: 1024, cpu: 50 },
              maximum: existingEgg?.maximum || null,
              packages: existingEgg?.packages || [],
              featureLimits: existingEgg?.featureLimits || { databases: 4, backups: 4 },
              order: existingEgg?.order ?? 0,

              // Metadata
              lastSyncedAt: new Date().toISOString()
            };

            if (!existingEgg) newCount++;
            syncedCount++;
          }
        } catch (eggError) {
          console.error(`Error fetching eggs for nest ${nestId}:`, eggError.message);
        }
      }

      // Save to database
      await db.$transaction([
        ...Object.entries(newEggs).map(([id, egg]) =>
          db.eggConfig.upsert({
            where: { id },
            update: {
              pterodactylNestId: egg.pterodactylNestId,
              pterodactylEggId: egg.pterodactylEggId,
              nestName: egg.nestName,
              originalName: egg.originalName,
              displayName: egg.displayName,
              description: egg.description || '',
              dockerImage: egg.dockerImage,
              startup: egg.startup,
              environment: JSON.stringify(egg.environment || {}),
              enabled: egg.enabled ?? false,
              categoryId: egg.category,
              minimum: JSON.stringify(egg.minimum || {}),
              maximum: egg.maximum ? JSON.stringify(egg.maximum) : '{}',
              packages: JSON.stringify(egg.packages || []),
              featureLimits: JSON.stringify(egg.featureLimits || {}),
              orderIndex: egg.order ?? 0,
              lastSyncedAt: egg.lastSyncedAt ? new Date(egg.lastSyncedAt) : null
            },
            create: {
              id,
              pterodactylNestId: egg.pterodactylNestId,
              pterodactylEggId: egg.pterodactylEggId,
              nestName: egg.nestName,
              originalName: egg.originalName,
              displayName: egg.displayName,
              description: egg.description || '',
              dockerImage: egg.dockerImage,
              startup: egg.startup,
              environment: JSON.stringify(egg.environment || {}),
              enabled: egg.enabled ?? false,
              categoryId: egg.category,
              minimum: JSON.stringify(egg.minimum || {}),
              maximum: egg.maximum ? JSON.stringify(egg.maximum) : '{}',
              packages: JSON.stringify(egg.packages || []),
              featureLimits: JSON.stringify(egg.featureLimits || {}),
              orderIndex: egg.order ?? 0,
              lastSyncedAt: egg.lastSyncedAt ? new Date(egg.lastSyncedAt) : null
            }
          })
        ),
        db.heliactyl.upsert({
          where: { key: 'eggs-last-sync' },
          update: { value: JSON.stringify(new Date().toISOString()) },
          create: { key: 'eggs-last-sync', value: JSON.stringify(new Date().toISOString()) }
        })
      ]);


      log(
        'eggs synced',
        `${req.session.userinfo.username} synced eggs from Pterodactyl. ${syncedCount} eggs synced, ${newCount} new.`
      );

      res.json({
        success: true,
        message: `Synced ${syncedCount} eggs from ${nests.length} nests`,
        syncedCount,
        newCount,
        lastSync: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error syncing eggs:', error);
      res.status(500).json({ error: 'Failed to sync eggs from Pterodactyl' });
    }
  });

  /**
   * PATCH /api/admin/eggs/:id
   * Update egg configuration
   */
  router.patch('/admin/eggs/:id', validate(schemas.eggUpdate), async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const eggId = req.params.id;
      const eggs = await getEggsFromDB(db);

      if (!eggs[eggId]) {
        return res.status(404).json({ error: 'Egg not found' });
      }

      const allowedFields = [
        'enabled', 'displayName', 'category', 'minimum', 'maximum',
        'packages', 'featureLimits', 'order', 'dockerImage', 'startup', 'environment'
      ];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          eggs[eggId][field] = req.body[field];
        }
      }

      eggs[eggId].updatedAt = new Date().toISOString();

      const eggData = eggs[eggId];
      await db.eggConfig.update({
        where: { id: eggId },
        data: {
          enabled: eggData.enabled,
          displayName: eggData.displayName,
          categoryId: eggData.category,
          minimum: JSON.stringify(eggData.minimum || {}),
          maximum: eggData.maximum ? JSON.stringify(eggData.maximum) : '{}',
          packages: JSON.stringify(eggData.packages || []),
          featureLimits: JSON.stringify(eggData.featureLimits || {}),
          orderIndex: eggData.order ?? 0,
          dockerImage: eggData.dockerImage,
          startup: eggData.startup,
          environment: JSON.stringify(eggData.environment || {})
        }
      });

      log(
        'egg updated',
        `${req.session.userinfo.username} updated egg "${eggs[eggId].displayName}"`
      );

      res.json({
        success: true,
        egg: eggs[eggId]
      });
    } catch (error) {
      console.error('Error updating egg:', error);
      res.status(500).json({ error: 'Failed to update egg' });
    }
  });

  /**
   * PATCH /api/admin/eggs/:id/toggle
   * Quick toggle egg enabled status
   */
  router.patch('/admin/eggs/:id/toggle', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const eggId = req.params.id;
      const eggs = await getEggsFromDB(db);

      if (!eggs[eggId]) {
        return res.status(404).json({ error: 'Egg not found' });
      }

      eggs[eggId].enabled = !eggs[eggId].enabled;
      eggs[eggId].updatedAt = new Date().toISOString();

      await db.eggConfig.update({
        where: { id: eggId },
        data: { enabled: eggs[eggId].enabled }
      });

      log(
        'egg toggled',
        `${req.session.userinfo.username} ${eggs[eggId].enabled ? 'enabled' : 'disabled'} egg "${eggs[eggId].displayName}"`
      );

      res.json({
        success: true,
        enabled: eggs[eggId].enabled
      });
    } catch (error) {
      console.error('Error toggling egg:', error);
      res.status(500).json({ error: 'Failed to toggle egg' });
    }
  });

  /**
   * POST /api/admin/eggs/batch
   * Batch update multiple eggs
   */
  router.post('/admin/eggs/batch', validate(schemas.eggBatch), async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const { action, ids } = req.body;
      const eggIds = ids;
      const eggs = await getEggsFromDB(db);

      let updatedCount = 0;

      for (const eggId of eggIds) {
        if (!eggs[eggId]) continue;

        switch (action) {
          case 'enable':
            eggs[eggId].enabled = true;
            break;
          case 'disable':
            eggs[eggId].enabled = false;
            break;
          case 'setCategory':
            eggs[eggId].category = data.category;
            break;
          case 'setMinimum':
            eggs[eggId].minimum = data.minimum;
            break;
        }

        eggs[eggId].updatedAt = new Date().toISOString();
        updatedCount++;
      }

      await db.$transaction(
        eggIds.filter(id => eggs[id]).map(id => {
          const egg = eggs[id];
          return db.eggConfig.update({
            where: { id },
            data: {
              enabled: egg.enabled,
              categoryId: egg.category,
              minimum: JSON.stringify(egg.minimum || {})
            }
          });
        })
      );

      log(
        'eggs batch updated',
        `${req.session.userinfo.username} batch ${action} on ${updatedCount} eggs`
      );

      res.json({
        success: true,
        updatedCount
      });
    } catch (error) {
      console.error('Error batch updating eggs:', error);
      res.status(500).json({ error: 'Failed to batch update eggs' });
    }
  });


  // ============================================
  // CATEGORY MANAGEMENT
  // ============================================

  /**
   * GET /api/admin/eggs/categories
   * Get all categories (admin)
   */
  router.get('/admin/eggs/categories', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const categories = await getCategoriesFromDB(db);
      res.json(categories);
    } catch (error) {
      console.error('Error fetching categories:', error);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  /**
   * POST /api/admin/eggs/categories
   * Create a new category
   */
  router.post('/admin/eggs/categories', validate(schemas.eggCategory), async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const { id, name, icon, order } = req.body;

      const categories = await getCategoriesFromDB(db);

      // Check for duplicate ID
      if (categories.find(c => c.id === id)) {
        return res.status(400).json({ error: 'Category ID already exists' });
      }

      categories.push({
        id,
        name,
        icon: icon || 'folder',
        order: order ?? categories.length
      });

      await db.eggCategory.upsert({
        where: { id },
        update: { name, icon: icon || 'folder', orderIndex: order ?? categories.length },
        create: { id, name, icon: icon || 'folder', orderIndex: order ?? categories.length }
      });

      log(
        'category created',
        `${req.session.userinfo.username} created category "${name}"`
      );

      res.status(201).json({
        success: true,
        categories
      });
    } catch (error) {
      console.error('Error creating category:', error);
      res.status(500).json({ error: 'Failed to create category' });
    }
  });


  /**
   * PATCH /api/admin/eggs/categories/:id
   * Update a category
   */
  router.patch('/admin/eggs/categories/:id', validate(schemas.eggCategoryUpdate), async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const categoryId = req.params.id;
      const categories = await getCategoriesFromDB(db);

      const categoryIndex = categories.findIndex(c => c.id === categoryId);
      if (categoryIndex === -1) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const allowedFields = ['name', 'icon', 'order'];
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          categories[categoryIndex][field] = req.body[field];
        }
      }

      const updatedCategory = categories[categoryIndex];
      await db.eggCategory.update({
        where: { id: categoryId },
        data: {
          name: updatedCategory.name,
          icon: updatedCategory.icon,
          orderIndex: updatedCategory.order
        }
      });


      log(
        'category updated',
        `${req.session.userinfo.username} updated category "${categories[categoryIndex].name}"`
      );

      res.json({
        success: true,
        category: categories[categoryIndex]
      });
    } catch (error) {
      console.error('Error updating category:', error);
      res.status(500).json({ error: 'Failed to update category' });
    }
  });

  /**
   * DELETE /api/admin/eggs/categories/:id
   * Delete a category (eggs will be moved to 'other')
   */
  router.delete('/admin/eggs/categories/:id', async (req, res) => {
    if (!await checkAdminStatus(req, res, db)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
      const categoryId = req.params.id;

      if (categoryId === 'other') {
        return res.status(400).json({ error: 'Cannot delete the "other" category' });
      }

      const categories = await getCategoriesFromDB(db);
      const categoryIndex = categories.findIndex(c => c.id === categoryId);

      if (categoryIndex === -1) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const deletedCategory = categories[categoryIndex];

      await db.$transaction([
        db.eggConfig.updateMany({
          where: { categoryId },
          data: { categoryId: 'other' }
        }),
        db.eggCategory.delete({
          where: { id: categoryId }
        })
      ]);

      log(
        'category deleted',
        `${req.session.userinfo.username} deleted category "${deletedCategory.name}"`
      );

      res.status(204).send();
    } catch (error) {
      console.error('Error deleting category:', error);
      res.status(500).json({ error: 'Failed to delete category' });
    }
  });

  // Mount the router
  app.use('/api', router);
};

// Export helper functions for use in servers.js
module.exports.getEggsFromDB = getEggsFromDB;
module.exports.getCategoriesFromDB = getCategoriesFromDB;
