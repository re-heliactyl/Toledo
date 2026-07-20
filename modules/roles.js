const express = require('express');
const createAuthz = require('../handlers/authz');
const { PERMISSION_CATEGORIES, ALL_PERMISSION_KEYS, isValidPermission } = require('../handlers/permissions');

const HeliactylModule = {
  name: "Roles",
  version: "10.0.0",
  api_level: 4,
  target_platform: "10.0.0",
  description: "Custom roles and fine-grained permissions management",
  author: {
    name: "aachul123",
    email: "ludo@overnode.fr",
    url: "https://achul123.pages.dev/"
  }
};

async function load(app, db) {
  const authz = createAuthz(db);
  const router = express.Router();

  // All endpoints require general session
  router.use(authz.requireSession);


  /**
   * GET /api/admin/permissions
   * Return canonical permission categories and metadata
   */
  router.get('/admin/permissions', authz.requirePermission('admin.roles.manage'), (req, res) => {
    return res.json({
      categories: PERMISSION_CATEGORIES,
      allKeys: ALL_PERMISSION_KEYS,
    });
  });

  /**
   * GET /api/admin/roles
   * List all roles with user counts
   */
  router.get('/admin/roles', authz.requirePermission('admin.roles.manage'), async (req, res) => {
    try {
      const roles = await db.role.findMany({
        orderBy: { priority: 'desc' },
        include: {
          _count: {
            select: { users: true },
          },
        },
      });

      const formatted = roles.map((r) => {
        let parsedPerms = [];
        try {
          parsedPerms = JSON.parse(r.permissions);
        } catch (e) {
          parsedPerms = [];
        }

        return {
          ...r,
          permissions: parsedPerms,
          userCount: r._count.users,
        };
      });

      return res.json({
        roles: formatted,
        categories: PERMISSION_CATEGORIES,
      });
    } catch (err) {
      console.error('Error fetching roles:', err);
      return res.status(500).json({ error: 'Failed to fetch roles' });
    }
  });

  /**
   * POST /api/admin/roles
   * Create a new custom role
   */
  router.post('/admin/roles', authz.requirePermission('admin.roles.manage'), async (req, res) => {
    try {
      const { name, description, color, priority, permissions } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Role name is required' });
      }

      const existing = await db.role.findUnique({ where: { name: name.trim() } });
      if (existing) {
        return res.status(400).json({ error: 'A role with this name already exists' });
      }

      const validPerms = Array.isArray(permissions)
        ? permissions.filter((p) => isValidPermission(p))
        : [];

      const role = await db.role.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
          color: color || '#6366f1',
          priority: typeof priority === 'number' ? priority : 0,
          isSystem: false,
          permissions: JSON.stringify(validPerms),
        },
      });

      return res.status(201).json({
        ...role,
        permissions: validPerms,
        userCount: 0,
      });
    } catch (err) {
      console.error('Error creating role:', err);
      return res.status(500).json({ error: 'Failed to create role' });
    }
  });

  /**
   * PATCH /api/admin/roles/:id
   * Update an existing role
   */
  router.patch('/api/admin/roles/:id', authz.requirePermission('admin.roles.manage'), async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, color, priority, permissions } = req.body;

      const role = await db.role.findUnique({ where: { id } });
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      if (role.isSystem) {
        return res.status(400).json({ error: 'System roles cannot be modified' });
      }

      const updateData = {};

      if (name && typeof name === 'string' && name.trim()) {
        const checkName = await db.role.findFirst({
          where: { name: name.trim(), id: { not: id } },
        });
        if (checkName) {
          return res.status(400).json({ error: 'Another role already uses this name' });
        }
        updateData.name = name.trim();
      }

      if (description !== undefined) {
        updateData.description = description ? description.trim() : null;
      }

      if (color) {
        updateData.color = color;
      }

      if (typeof priority === 'number') {
        updateData.priority = priority;
      }

      if (Array.isArray(permissions)) {
        const validPerms = permissions.filter((p) => isValidPermission(p));
        updateData.permissions = JSON.stringify(validPerms);
      }

      const updated = await db.role.update({
        where: { id },
        data: updateData,
        include: {
          _count: { select: { users: true } },
        },
      });

      let parsedPerms = [];
      try {
        parsedPerms = JSON.parse(updated.permissions);
      } catch (e) {
        parsedPerms = [];
      }

      return res.json({
        ...updated,
        permissions: parsedPerms,
        userCount: updated._count.users,
      });
    } catch (err) {
      console.error('Error updating role:', err);
      return res.status(500).json({ error: 'Failed to update role' });
    }
  });

  /**
   * DELETE /api/admin/roles/:id
   * Delete a custom role
   */
  router.delete('/api/admin/roles/:id', authz.requirePermission('admin.roles.manage'), async (req, res) => {
    try {
      const { id } = req.params;

      const role = await db.role.findUnique({ where: { id } });
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      if (role.isSystem) {
        return res.status(400).json({ error: 'System roles cannot be deleted' });
      }

      await db.role.delete({ where: { id } });

      return res.json({ success: true, message: 'Role deleted successfully' });
    } catch (err) {
      console.error('Error deleting role:', err);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
  });

  /**
   * GET /api/admin/users/:id/roles
   * Fetch roles assigned to a user
   */
  router.get('/api/admin/users/:id/roles', authz.requirePermission('admin.roles.manage'), async (req, res) => {
    try {
      const { id } = req.params;

      const userRoles = await db.userRole.findMany({
        where: { userId: id },
        include: { role: true },
      });

      const roles = userRoles.map((ur) => {
        let parsed = [];
        try {
          parsed = JSON.parse(ur.role.permissions);
        } catch (e) {}

        return {
          ...ur.role,
          permissions: parsed,
          assignedAt: ur.assignedAt,
        };
      });

      return res.json({ roles });
    } catch (err) {
      console.error('Error fetching user roles:', err);
      return res.status(500).json({ error: 'Failed to fetch user roles' });
    }
  });

  /**
   * POST /api/admin/users/:id/roles
   * Update roles assigned to a user (takes array of roleIds)
   */
  router.post('/api/admin/users/:id/roles', authz.requirePermission('admin.roles.manage'), async (req, res) => {
    try {
      const { id } = req.params;
      const { roleIds } = req.body;

      if (!Array.isArray(roleIds)) {
        return res.status(400).json({ error: 'roleIds must be an array' });
      }

      const user = await db.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Remove existing assigned roles
      await db.userRole.deleteMany({ where: { userId: id } });

      // Add new role assignments
      if (roleIds.length > 0) {
        const validRoles = await db.role.findMany({
          where: { id: { in: roleIds } },
        });

        const userRolesData = validRoles.map((r) => ({
          userId: id,
          roleId: r.id,
        }));

        await db.userRole.createMany({
          data: userRolesData,
        });
      }

      // Return updated roles
      const updatedUserRoles = await db.userRole.findMany({
        where: { userId: id },
        include: { role: true },
      });

      const roles = updatedUserRoles.map((ur) => {
        let parsed = [];
        try {
          parsed = JSON.parse(ur.role.permissions);
        } catch (e) {}

        return {
          ...ur.role,
          permissions: parsed,
          assignedAt: ur.assignedAt,
        };
      });

      return res.json({ success: true, roles });
    } catch (err) {
      console.error('Error setting user roles:', err);
      return res.status(500).json({ error: 'Failed to update user roles' });
    }
  });

  app.use(router);
}

module.exports = {
  load,
  HeliactylModule,
};

