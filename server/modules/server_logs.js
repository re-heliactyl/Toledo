/* --------------------------------------------- */
/* server_logs                                   */
/* --------------------------------------------- */

const express = require("express");
const { isAuthenticated, ownsServer } = require("./server_core.js");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Logs",
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

  // GET /api/server/:id/logs - Get server activity logs
  router.get('/server/:id/logs', isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;

      // Get logs from database
      const activityLog = await db.get(`activity_log_${serverId}`) || [];

      // Calculate pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const totalLogs = activityLog.length;
      const totalPages = Math.ceil(totalLogs / limit);

      // Get paginated logs
      const paginatedLogs = activityLog.slice(startIndex, endIndex);

      // Format response with pagination metadata
      const response = {
        data: paginatedLogs,
        pagination: {
          current_page: page,
          total_pages: totalPages,
          total_items: totalLogs,
          items_per_page: limit,
          has_more: endIndex < totalLogs
        }
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching activity logs:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.use("/api", router);
};