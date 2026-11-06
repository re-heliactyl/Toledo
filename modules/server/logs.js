const { validate, schemas } = require('../../handlers/validate');
/* --------------------------------------------- */
/* logs                                   */
/* --------------------------------------------- */

const express = require("express");
const { isAuthenticated, ownsServer } = require("./core.js");

function parseLogDetails(details) {
  if (!details) {
    return null;
  }

  try {
    return JSON.parse(details);
  } catch (error) {
    return details;
  }
}

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
  router.get('/server/:id/logs', isAuthenticated, ownsServer, validate(schemas.serverIdParam, 'params'), async (req, res) => {
    try {
      const serverId = req.params.id;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;

      const [totalLogs, activityLogs] = await Promise.all([
        db.activityLog.count({
          where: { serverId },
        }),
        db.activityLog.findMany({
          where: { serverId },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
      ]);

      // Calculate pagination
      const totalPages = totalLogs === 0 ? 1 : Math.ceil(totalLogs / limit);
      const endIndex = skip + activityLogs.length;

      const paginatedLogs = activityLogs.map((log) => ({
        id: log.id,
        timestamp: log.createdAt,
        action: log.action,
        details: parseLogDetails(log.details),
        username: log.username,
      }));

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
