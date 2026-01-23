const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./server_core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                        */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Plugins",
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

  const SPIGOT_API_BASE = "https://api.spiget.org/v2";
  const BUKKIT_API_BASE = "https://dev.bukkit.org/api";
  const MODRINTH_API_BASE = "https://api.modrinth.com/v2";

  // Cache mechanism to reduce API calls
  const cache = {
    plugins: {},
    categories: {},
    platforms: ['spigot', 'bukkit', 'modrinth'],
    ttl: 15 * 60 * 1000 // 15 minutes cache
  };

  // Helper to check if cache is valid
  const isCacheValid = (key) => {
    return cache[key] &&
      cache[key].timestamp &&
      (Date.now() - cache[key].timestamp < cache.ttl);
  };

  // GET /api/plugins/platforms - List available plugin platforms
  router.get("/plugins/platforms", (req, res) => {
    res.json({
      platforms: cache.platforms,
      default: 'spigot'
    });
  });

  // GET /api/plugins/categories - List plugin categories
  router.get("/plugins/categories", async (req, res) => {
    const { platform = 'spigot' } = req.query;

    if (!cache.platforms.includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    try {
      // Check if we have cached categories
      if (isCacheValid(`categories_${platform}`)) {
        return res.json(cache[`categories_${platform}`].data);
      }

      let categories = [];

      if (platform === 'spigot') {
        const response = await axios.get(`${SPIGOT_API_BASE}/categories`);
        categories = response.data.map(category => ({
          id: category.id,
          name: category.name,
          icon: category.icon?.url || null
        }));
      } else if (platform === 'modrinth') {
        const response = await axios.get(`${MODRINTH_API_BASE}/categories`);
        categories = response.data.map(category => ({
          id: category.name,
          name: category.name,
          icon: null
        }));
      }

      // Store in cache
      cache[`categories_${platform}`] = {
        timestamp: Date.now(),
        data: categories
      };

      res.json(categories);
    } catch (error) {
      console.error(`Error fetching ${platform} categories:`, error);
      res.status(500).json({ error: "Failed to fetch categories" });
    }
  });

  // GET /api/plugins/list - List plugins with filtering and pagination
  router.get("/plugins/list", async (req, res) => {
    const {
      platform = 'spigot',
      category,
      page = 1,
      size = 50,
      sort = "downloads"
    } = req.query;

    if (!cache.platforms.includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    try {
      let plugins = [];
      const cacheKey = `plugins_${platform}_${category || 'all'}_${page}_${size}_${sort}`;

      // Check cache first
      if (isCacheValid(cacheKey)) {
        return res.json(cache[cacheKey].data);
      }

      if (platform === 'spigot') {
        // Build parameters
        const params = {
          size: size,
          page: page - 1, // Spigot API is 0-indexed
          sort: sort === 'downloads' ? '-downloads' :
            sort === 'rating' ? '-rating.average' :
              sort === 'newest' ? '-updateDate' : '-downloads'
        };

        if (category) {
          params.category = category;
        }

        const response = await axios.get(`${SPIGOT_API_BASE}/resources`, { params });

        // Normalize data structure
        plugins = response.data.map(plugin => ({
          id: plugin.id,
          name: plugin.name,
          tag: plugin.tag || plugin.description || '',
          version: {
            id: plugin.version?.id || 'latest'
          },
          downloads: plugin.downloads || 0,
          rating: plugin.rating || { average: 0 },
          icon: plugin.icon?.url || null,
          premium: plugin.premium || false,
          price: plugin.price || null,
          author: {
            id: plugin.author?.id || 'Unknown',
            name: plugin.author?.name || 'Unknown'
          },
          platform: 'spigot',
          updateDate: plugin.updateDate,
          external_url: `https://www.spigotmc.org/resources/${plugin.id}`
        }));
      } else if (platform === 'modrinth') {
        // For modrinth, implement similar logic but with their API structure
        const params = {
          limit: size,
          offset: (page - 1) * size,
          index: sort === 'downloads' ? 'downloads' :
            sort === 'rating' ? 'follows' :
              sort === 'newest' ? 'newest' : 'relevance'
        };

        let endpoint = `${MODRINTH_API_BASE}/search`;
        if (category) {
          params.facets = JSON.stringify([["categories:" + category]]);
        }
        params.facets = JSON.stringify([["project_type:plugin"]]);

        const response = await axios.get(endpoint, { params });

        plugins = response.data.hits.map(plugin => ({
          id: plugin.project_id,
          name: plugin.title,
          tag: plugin.description || '',
          version: {
            id: 'latest'
          },
          downloads: plugin.downloads || 0,
          rating: { average: plugin.follows / 10 || 0 }, // Convert follows to a rating-like number
          icon: plugin.icon_url || null,
          premium: false,
          price: null,
          author: {
            id: plugin.author || 'Unknown',
            name: plugin.author || 'Unknown'
          },
          platform: 'modrinth',
          updateDate: plugin.date_modified,
          external_url: `https://modrinth.com/plugin/${plugin.slug}`
        }));
      }

      // Store in cache
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: plugins
      };

      res.json(plugins);
    } catch (error) {
      console.error(`Error fetching ${platform} plugins:`, error);
      res.status(500).json({ error: "Failed to fetch plugins" });
    }
  });

  // GET /api/plugins/search - Search plugins
  router.get("/plugins/search", async (req, res) => {
    const {
      query,
      platform = 'spigot',
      page = 1,
      size = 50
    } = req.query;

    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }

    if (!cache.platforms.includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    try {
      const cacheKey = `search_${platform}_${query}_${page}_${size}`;

      // Check cache first
      if (isCacheValid(cacheKey)) {
        return res.json(cache[cacheKey].data);
      }

      let plugins = [];

      if (platform === 'spigot') {
        const response = await axios.get(
          `${SPIGOT_API_BASE}/search/resources/${encodeURIComponent(query)}`,
          {
            params: {
              size: size,
              page: page - 1,
              sort: "-downloads"
            }
          }
        );

        plugins = response.data.map(plugin => ({
          id: plugin.id,
          name: plugin.name,
          tag: plugin.tag || '',
          version: {
            id: plugin.version?.id || 'latest'
          },
          downloads: plugin.downloads || 0,
          rating: plugin.rating || { average: 0 },
          icon: plugin.icon?.url || null,
          premium: plugin.premium || false,
          price: plugin.price || null,
          author: {
            id: plugin.author?.id || 'Unknown',
            name: plugin.author?.name || 'Unknown'
          },
          platform: 'spigot',
          updateDate: plugin.updateDate,
          external_url: `https://www.spigotmc.org/resources/${plugin.id}`
        }));
      } else if (platform === 'modrinth') {
        const response = await axios.get(`${MODRINTH_API_BASE}/search`, {
          params: {
            query: query,
            limit: size,
            offset: (page - 1) * size,
            facets: JSON.stringify([["project_type:plugin"]])
          }
        });

        plugins = response.data.hits.map(plugin => ({
          id: plugin.project_id,
          name: plugin.title,
          tag: plugin.description || '',
          version: {
            id: 'latest'
          },
          downloads: plugin.downloads || 0,
          rating: { average: plugin.follows / 10 || 0 },
          icon: plugin.icon_url || null,
          premium: false,
          price: null,
          author: {
            id: plugin.author || 'Unknown',
            name: plugin.author || 'Unknown'
          },
          platform: 'modrinth',
          updateDate: plugin.date_modified,
          external_url: `https://modrinth.com/plugin/${plugin.slug}`
        }));
      }

      // Store in cache
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: plugins
      };

      res.json(plugins);
    } catch (error) {
      console.error(`Error searching ${platform} plugins:`, error);
      res.status(500).json({ error: "Failed to search plugins" });
    }
  });

  // GET /api/plugins/details/:pluginId - Get plugin details
  router.get("/plugins/details/:pluginId", async (req, res) => {
    const { pluginId } = req.params;
    const { platform = 'spigot' } = req.query;

    if (!pluginId) {
      return res.status(400).json({ error: "Plugin ID is required" });
    }

    if (!cache.platforms.includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    try {
      const cacheKey = `details_${platform}_${pluginId}`;

      // Check cache first
      if (isCacheValid(cacheKey)) {
        return res.json(cache[cacheKey].data);
      }

      let pluginDetails = {};

      if (platform === 'spigot') {
        const detailsResponse = await axios.get(`${SPIGOT_API_BASE}/resources/${pluginId}`);

        // Get additional data like version history and reviews if needed
        const versionResponse = await axios.get(`${SPIGOT_API_BASE}/resources/${pluginId}/versions?size=5`);

        pluginDetails = {
          id: detailsResponse.data.id,
          name: detailsResponse.data.name,
          tag: detailsResponse.data.tag || '',
          description: detailsResponse.data.description || 'No description available',
          version: {
            id: detailsResponse.data.version?.id || 'latest',
            name: detailsResponse.data.version?.name || 'Latest Version'
          },
          versions: versionResponse.data.map(version => ({
            id: version.id,
            name: version.name,
            releaseDate: version.releaseDate
          })),
          downloads: detailsResponse.data.downloads || 0,
          rating: detailsResponse.data.rating || { average: 0 },
          icon: detailsResponse.data.icon?.url || null,
          premium: detailsResponse.data.premium || false,
          price: detailsResponse.data.price || null,
          author: {
            id: detailsResponse.data.author?.id || 'Unknown',
            name: detailsResponse.data.author?.name || 'Unknown'
          },
          platform: 'spigot',
          releaseDate: detailsResponse.data.releaseDate,
          updateDate: detailsResponse.data.updateDate,
          testedVersions: detailsResponse.data.testedVersions || [],
          external_url: `https://www.spigotmc.org/resources/${detailsResponse.data.id}`
        };
      } else if (platform === 'modrinth') {
        const detailsResponse = await axios.get(`${MODRINTH_API_BASE}/project/${pluginId}`);
        const versionResponse = await axios.get(`${MODRINTH_API_BASE}/project/${pluginId}/version`);

        pluginDetails = {
          id: detailsResponse.data.id,
          name: detailsResponse.data.title,
          tag: detailsResponse.data.description || '',
          description: detailsResponse.data.body || 'No description available',
          version: {
            id: 'latest',
            name: versionResponse.data[0]?.name || 'Latest Version'
          },
          versions: versionResponse.data.slice(0, 5).map(version => ({
            id: version.id,
            name: version.name,
            releaseDate: version.date_published
          })),
          downloads: detailsResponse.data.downloads || 0,
          rating: { average: detailsResponse.data.follows / 10 || 0 },
          icon: detailsResponse.data.icon_url || null,
          premium: false,
          price: null,
          author: {
            id: detailsResponse.data.team || 'Unknown',
            name: detailsResponse.data.team || 'Unknown'
          },
          platform: 'modrinth',
          releaseDate: detailsResponse.data.published,
          updateDate: detailsResponse.data.updated,
          testedVersions: detailsResponse.data.game_versions || [],
          external_url: `https://modrinth.com/plugin/${detailsResponse.data.slug}`
        };
      }

      // Store in cache
      cache[cacheKey] = {
        timestamp: Date.now(),
        data: pluginDetails
      };

      res.json(pluginDetails);
    } catch (error) {
      console.error(`Error fetching ${platform} plugin details:`, error);
      res.status(500).json({ error: "Failed to fetch plugin details" });
    }
  });

  // Add this new endpoint to server_plugins.js
  // GET /api/plugins/scan/:serverId - Scan server plugins directory and update DB
  router.get("/plugins/scan/:serverId", isAuthenticated, ownsServer, async (req, res) => {
    const { serverId } = req.params;

    try {
      // Get file listing from Pterodactyl
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/list`,
        {
          params: {
            directory: '/plugins'
          },
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
          },
        }
      );

      // Extract .jar files
      const pluginFiles = response.data.data
        .filter(file => file.attributes.name.endsWith('.jar'))
        .map(file => ({
          name: file.attributes.name.replace(/\.jar$/, ''),
          size: file.attributes.size,
          modified: file.attributes.modified_at
        }));

      // Get current installed plugins from DB
      let installedPlugins = [];
      if (db) {
        const stored = db.get(`servers.${serverId}.plugins`);
        installedPlugins = Array.isArray(stored) ? stored : [];
      }

      // Add plugin files not already in DB
      let added = 0;
      for (const file of pluginFiles) {
        // Check if plugin is already in DB
        const normalizedName = file.name.toLowerCase();
        const isTracked = installedPlugins.some(p =>
          p && (p.name.toLowerCase() === normalizedName || p.pluginName?.toLowerCase() === normalizedName)
        );

        if (!isTracked) {
          installedPlugins.push({
            id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: file.name,
            platform: 'manual',
            installedAt: file.modified || new Date().toISOString(),
            manuallyAdded: true
          });
          added++;
        }
      }

      // Update the DB
      if (db && added > 0) {
        db.set(`servers.${serverId}.plugins`, installedPlugins);
      }

      res.json({
        success: true,
        message: `Scanned plugins directory and found ${pluginFiles.length} plugin files. Added ${added} new plugins to tracking.`,
        plugins: installedPlugins
      });
    } catch (error) {
      console.error("Error scanning plugins directory:", error);
      res.status(500).json({
        success: false,
        error: "Failed to scan plugins directory",
        details: error.message
      });
    }
  });

  // POST /api/plugins/install/:serverId - Install plugin
  router.post("/plugins/install/:serverId", isAuthenticated, ownsServer, async (req, res) => {
    const { serverId } = req.params;
    const { pluginId, platform = 'spigot' } = req.body;

    if (!pluginId) {
      return res.status(400).json({ error: "Plugin ID is required" });
    }

    if (!cache.platforms.includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    try {
      let downloadUrl, pluginName;

      if (platform === 'spigot') {
        // Get plugin details
        const pluginDetails = await axios.get(`${SPIGOT_API_BASE}/resources/${pluginId}`);
        pluginName = pluginDetails.data.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/download`;
      } else if (platform === 'modrinth') {
        // Get plugin details
        const pluginDetails = await axios.get(`${MODRINTH_API_BASE}/project/${pluginId}`);
        const versions = await axios.get(`${MODRINTH_API_BASE}/project/${pluginId}/version`);

        if (versions.data.length === 0) {
          return res.status(404).json({ error: "No version available to download" });
        }

        pluginName = pluginDetails.data.title.replace(/[^a-zA-Z0-9-_]/g, '_');

        // Get the latest version files
        const latestVersion = versions.data[0];
        if (!latestVersion.files || latestVersion.files.length === 0) {
          return res.status(404).json({ error: "No download file available" });
        }

        downloadUrl = latestVersion.files[0].url;
      } else {
        return res.status(400).json({ error: "Platform not supported for installation" });
      }

      // Download the plugin
      const pluginResponse = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
      });
      const pluginBuffer = Buffer.from(pluginResponse.data, "binary");

      // Get upload URL from Pterodactyl
      const uploadUrlResponse = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/upload`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
          },
        }
      );

      const uploadUrl = uploadUrlResponse.data.attributes.url;

      // Upload plugin using multipart/form-data
      const form = new FormData();
      const tempFileName = `temp_${Date.now()}_${pluginId}.jar`;
      form.append("files", pluginBuffer, {
        filename: tempFileName,
        contentType: "application/java-archive",
      });

      const headers = form.getHeaders();
      await axios.post(uploadUrl, form, {
        headers: {
          ...headers,
          "Content-Length": form.getLengthSync(),
        },
      });

      // Create plugins directory if it doesn't exist
      try {
        await axios.post(
          `${PANEL_URL}/api/client/servers/${serverId}/files/create-folder`,
          { name: 'plugins', path: '/' },
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              Accept: "application/json",
            },
          }
        );
      } catch (folderError) {
        // Folder may already exist, continue
      }

      // Move plugin to plugins directory
      await axios.put(
        `${PANEL_URL}/api/client/servers/${serverId}/files/rename`,
        {
          root: "/",
          files: [
            {
              from: tempFileName,
              to: `plugins/${pluginName}.jar`,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
          },
        }
      );

      if (db) {
        try {
          // Get existing plugins or initialize empty array if doesn't exist or invalid
          let installedPlugins = db.get(`servers.${serverId}.plugins`);
          if (!Array.isArray(installedPlugins)) {
            installedPlugins = [];
          }

          // Only add if not already tracked
          const pluginIdentifier = String(pluginId);
          const platformName = String(platform);

          // Check if already installed using both id and name
          const isAlreadyInstalled = installedPlugins.some(p =>
            p && ((p.id === pluginIdentifier && p.platform === platformName) ||
              (p.name.toLowerCase() === pluginName.toLowerCase()))
          );

          if (!isAlreadyInstalled) {
            installedPlugins.push({
              id: pluginIdentifier,
              name: pluginName,
              pluginName: pluginName, // Add both for compatibility
              platform: platformName,
              installedAt: new Date().toISOString()
            });

            db.set(`servers.${serverId}.plugins`, installedPlugins);
          }
        } catch (dbError) {
          console.error("Error tracking plugin installation in database:", dbError);
        }
      }

      res.json({
        success: true,
        message: "Plugin installed successfully",
        pluginName
      });
    } catch (error) {
      console.error("Error installing plugin:", error);
      res.status(500).json({
        success: false,
        error: "Failed to install plugin",
        details: error.message
      });
    }
  });

  // GET /api/plugins/installed/:serverId - List installed plugins
  router.get("/plugins/installed/:serverId", isAuthenticated, ownsServer, async (req, res) => {
    const { serverId } = req.params;

    try {
      // Check DB for installed plugins
      let installedPlugins = [];
      if (db) {
        const storedPlugins = db.get(`servers.${serverId}.plugins`);
        // Ensure we always return an array even if DB value is invalid
        installedPlugins = Array.isArray(storedPlugins) ? storedPlugins : [];
      }

      // Return the list of installed plugins
      res.json(installedPlugins);
    } catch (error) {
      console.error("Error fetching installed plugins:", error);
      // Return empty array on error instead of error message
      res.json([]);
    }
  });

  app.use("/api", router);
};