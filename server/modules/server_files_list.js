/* --------------------------------------------- */
/* server_files_list                             */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./server_core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Files List",
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

  // GET /api/server/:id/files/list
  router.get("/server/:id/files/list", isAuthenticated, ownsServer, async (req, res) => {
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

  app.use("/api", router);
};