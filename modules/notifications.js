const createAuthz = require("../handlers/authz.js");

const HeliactylModule = {
  name: "Notifications",
  version: "1.0.0",
  api_level: 4,
  target_platform: "10.0.0",
  description: "User notification center module",
  author: {
    name: "aachul123",
    email: "ludo@overnode.fr",
    url: "https://achul123.pages.dev/"
  },
  dependencies: [],
  permissions: [],
  routes: [
    { path: "/api/v5/notifications", method: "GET" },
    { path: "/api/v5/notifications/:id/read", method: "POST" },
    { path: "/api/v5/notifications/read-all", method: "POST" },
    { path: "/api/v5/notifications/:id", method: "DELETE" }
  ],
  config: {},
  hooks: [],
  tags: ["core", "notifications"],
  license: "MIT"
};

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);

  // GET /api/v5/notifications - Retrieve paginated user notifications
  app.get("/api/v5/notifications", authz.requireSession, async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser?.id;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const rawPage = parseInt(req.query.page, 10);
      const rawLimit = parseInt(req.query.limit, 10);
      const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
      const parsedLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 20;
      const limit = Math.min(parsedLimit, 50);
      const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === true;

      const whereClause = {
        userId,
        ...(unreadOnly ? { read: false } : {})
      };

      const [notifications, total, unreadCount] = await Promise.all([
        db.notification.findMany({
          where: whereClause,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            action: true,
            name: true,
            read: true,
            createdAt: true
          }
        }),
        db.notification.count({
          where: whereClause
        }),
        db.notification.count({
          where: {
            userId,
            read: false
          }
        })
      ]);

      const totalPages = Math.ceil(total / limit) || 1;

      return res.json({
        data: notifications,
        unreadCount,
        pagination: {
          page,
          limit,
          total,
          totalPages
        }
      });
    } catch (error) {
      console.error("[Notifications] Error retrieving notifications:", error);
      return res.status(500).json({ error: "Failed to retrieve notifications" });
    }
  });

  // POST /api/v5/notifications/:id/read - Mark specific notification as read
  app.post("/api/v5/notifications/:id/read", authz.requireSession, async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser?.id;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      await db.notification.updateMany({
        where: {
          id: req.params.id,
          userId
        },
        data: {
          read: true
        }
      });

      return res.json({ success: true });
    } catch (error) {
      console.error("[Notifications] Error marking notification as read:", error);
      return res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  // Backward compatibility alias for /api/notifications/:id/read
  app.post("/api/notifications/:id/read", authz.requireSession, async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser?.id;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      await db.notification.updateMany({
        where: {
          id: req.params.id,
          userId
        },
        data: {
          read: true
        }
      });

      return res.json({ success: true });
    } catch (error) {
      console.error("[Notifications] Error marking notification as read:", error);
      return res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  // POST /api/v5/notifications/read-all - Mark all unread notifications as read
  app.post("/api/v5/notifications/read-all", authz.requireSession, async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser?.id;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const updateResult = await db.notification.updateMany({
        where: {
          userId,
          read: false
        },
        data: {
          read: true
        }
      });

      return res.json({
        success: true,
        updatedCount: updateResult.count
      });
    } catch (error) {
      console.error("[Notifications] Error marking all notifications as read:", error);
      return res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
  });

  // DELETE /api/v5/notifications/:id - Delete a notification
  app.delete("/api/v5/notifications/:id", authz.requireSession, async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser?.id;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      await db.notification.deleteMany({
        where: {
          id: req.params.id,
          userId
        }
      });

      return res.json({ success: true });
    } catch (error) {
      console.error("[Notifications] Error deleting notification:", error);
      return res.status(500).json({ error: "Failed to delete notification" });
    }
  });
};

