/* --------------------------------------------- */
/* files_list                             */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, requireServerPermission, PANEL_URL, API_KEY } = require("./core.js");
const cache = require("../../handlers/cache");

const FOLDER_SIZE_CACHE_TTL = 120;
const PANEL_LIST_PAGE_SIZE = 100;

function normalizeDirectoryPath(directory = "/") {
  const normalized = `/${String(directory || "/")}`.replace(/\/+/, "/").replace(/\/+/g, "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function joinDirectoryPath(root, name) {
  return normalizeDirectoryPath(`${normalizeDirectoryPath(root)}${name}`);
}

async function listDirectoryEntries(serverId, directory) {
  const entries = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await axios.get(
      `${PANEL_URL}/api/client/servers/${serverId}/files/list`,
      {
        params: {
          directory,
          page,
          per_page: PANEL_LIST_PAGE_SIZE,
        },
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );

    const pageEntries = Array.isArray(response.data?.data)
      ? response.data.data.map((item) => item.attributes)
      : [];

    entries.push(...pageEntries);
    totalPages = response.data?.meta?.pagination?.total_pages || 1;
    page += 1;
  } while (page <= totalPages);

  return entries;
}

async function computeFolderSize(serverId, directory, visited = new Set(), options = {}) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  const { bypassCache = false } = options;

  if (visited.has(normalizedDirectory)) {
    return 0;
  }

  visited.add(normalizedDirectory);

  const cacheKey = `folder_size:${serverId}:${normalizedDirectory}`;
  if (!bypassCache) {
    const cachedSize = await cache.get(cacheKey);
    if (typeof cachedSize === "number") {
      return cachedSize;
    }
  }

  const entries = await listDirectoryEntries(serverId, normalizedDirectory);
  let totalSize = 0;

  for (const entry of entries) {
    if (entry?.is_file) {
      totalSize += entry.size || 0;
      continue;
    }

    const childDirectory = joinDirectoryPath(normalizedDirectory, entry?.name || "");
    totalSize += await computeFolderSize(serverId, childDirectory, visited, options);
  }

  await cache.set(cacheKey, totalSize, FOLDER_SIZE_CACHE_TTL);
  return totalSize;
}

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files List",
  "version": "1.0.1",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
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

  // GET /api/server/:id/files/list
  router.get("/server/:id/files/list", isAuthenticated, requireServerPermission("file.read"), async (req, res) => {
    try {
      const serverId = req.params.id;
      const directory = req.query.directory || "/";
      const page = parseInt(req.query.page) || 1;
      const perPage = parseInt(req.query.per_page) || 10;

      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/list`,
        {
          params: {
            directory,
            page: page,
            per_page: perPage
          },
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        }
      );

      // Add pagination metadata to the response
      const totalItems = response.data.meta?.pagination?.total || 0;
      const totalPages = Math.ceil(totalItems / perPage);

      const paginatedResponse = {
        ...response.data,
        meta: {
          ...response.data.meta,
          pagination: {
            ...response.data.meta?.pagination,
            current_page: page,
            per_page: perPage,
            total_pages: totalPages
          }
        }
      };

      res.json(paginatedResponse);
    } catch (error) {
      console.error("Error listing files:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/server/:id/files/folder-size", isAuthenticated, requireServerPermission("file.read"), async (req, res) => {
    try {
      const serverId = req.params.id;
      const directory = normalizeDirectoryPath(req.query.directory || "/");
      const bypassCache = req.query.refresh === "1";
      const size = await computeFolderSize(serverId, directory, new Set(), { bypassCache });

      res.json({
        object: "folder_size",
        attributes: {
          directory,
          size,
          cached_ttl: FOLDER_SIZE_CACHE_TTL,
        },
      });
    } catch (error) {
      console.error("Error getting folder size:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.use("/api", router);
};
