const axios = require('axios');
const loadConfig = require('./config');

const settings = loadConfig('./config.toml');

function createAuthz(db) {
  const pteroApi = axios.create({
    baseURL: settings.pterodactyl.domain,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${settings.pterodactyl.key}`,
    },
  });

  function getSessionUser(req) {
    return req.session?.userinfo || null;
  }

  function getPterodactylUser(req) {
    return req.session?.pterodactyl || null;
  }

  function hasUserSession(req) {
    return Boolean(getSessionUser(req));
  }

  function hasPterodactylSession(req) {
    return Boolean(getPterodactylUser(req));
  }

  async function getFreshSessionUserRecord(req) {
    const sessionUser = getSessionUser(req);
    if (!sessionUser?.id) {
      return null;
    }

    return db.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        id: true,
        username: true,
        email: true,
        isBanned: true,
        banReason: true,
        bannedAt: true,
        bannedByUserId: true,
        bannedByUsername: true,
        twoFactorEnabled: true,
        pterodactylId: true,
      },
    });
  }

  function isUserBanned(user) {
    return user?.isBanned === true;
  }

  function buildBanPayload(user) {
    if (!user) {
      return null;
    }

    return {
      reason: user.banReason || 'No reason provided.',
      bannedAt: user.bannedAt || null,
      staff: {
        id: user.bannedByUserId || null,
        username: user.bannedByUsername || 'Unknown staff member',
      },
    };
  }

  function isBanAllowedRequest(req) {
    const requestPath = req.path || '/';

    if (
      requestPath === '/' ||
      requestPath === '/website' ||
      requestPath === '/auth' ||
      requestPath === '/banned' ||
      requestPath === '/favicon.ico' ||
      requestPath === '/api/user/logout' ||
      requestPath === '/api/v5/state' ||
      requestPath === '/api/v5/settings'
    ) {
      return true;
    }

    if (requestPath.startsWith('/assets/')) {
      return true;
    }

    if (requestPath.startsWith('/auth/')) {
      return true;
    }

    return false;
  }

  function denyBannedRequest(req, res, user, options = {}) {
    const payload = buildBanPayload(user);
    const shouldForceJson = options.forceJson === true;
    const isApiRequest = req.path.startsWith('/api/');

    if (shouldForceJson || isApiRequest) {
      return res.status(403).json({
        code: 'USER_BANNED',
        error: 'Your account is banned',
        redirectTo: '/banned',
        ban: payload,
      });
    }

    return res.redirect('/banned');
  }

  async function enforceBanPolicy(req, res, next) {
    if (!hasUserSession(req) || isBanAllowedRequest(req)) {
      return next();
    }

    try {
      const user = await getFreshSessionUserRecord(req);
      if (!isUserBanned(user)) {
        return next();
      }

      return denyBannedRequest(req, res, user);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to verify account access' });
    }
  }

  function requireSession(req, res, next) {
    if (!hasUserSession(req)) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    next();
  }

  function requirePterodactylSession(req, res, next) {
    if (!hasPterodactylSession(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
  }

  async function getAdminStatus(req) {
    if (!hasUserSession(req) || !hasPterodactylSession(req)) {
      return false;
    }

    const cacheKey = 'adminStatusCache';
    const cacheExpiry = 60 * 1000;
    const cached = req.session?.[cacheKey];

    if (cached?.timestamp && Date.now() - cached.timestamp < cacheExpiry) {
      return cached.isAdmin === true;
    }

    try {
      const sessionUser = getSessionUser(req);
      const user = await db.user.findUnique({
        where: { id: sessionUser.id },
        select: { pterodactylId: true },
      });

      if (!user?.pterodactylId) {
        req.session[cacheKey] = { isAdmin: false, timestamp: Date.now() };
        return false;
      }

      const response = await pteroApi.get(`/api/application/users/${user.pterodactylId}?include=servers`);
      const isAdmin = response.data?.attributes?.root_admin === true;

      req.session[cacheKey] = {
        isAdmin,
        timestamp: Date.now(),
      };

      return isAdmin;
    } catch (error) {
      return false;
    }
  }

  async function getUserPermissions(req) {
    if (!hasUserSession(req)) {
      return { isRootAdmin: false, permissions: [], roles: [] };
    }

    const isRootAdmin = await getAdminStatus(req);
    const sessionUser = getSessionUser(req);

    const userWithRoles = await db.user.findUnique({
      where: { id: sessionUser.id },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    const userRoles = (userWithRoles?.roles || []).map((ur) => ur.role);

    if (isRootAdmin) {
      return {
        isRootAdmin: true,
        permissions: ['*'],
        roles: userRoles.length > 0 ? userRoles : [
          {
            id: 'superadmin',
            name: 'Super Admin',
            description: 'Pterodactyl Root Admin',
            color: '#ef4444',
            priority: 999,
            isSystem: true,
            permissions: JSON.stringify(['*']),
          },
        ],
      };
    }

    const permSet = new Set();
    for (const r of userRoles) {
      if (!r.permissions) continue;
      try {
        const list = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions;
        if (Array.isArray(list)) {
          list.forEach((p) => permSet.add(p));
        }
      } catch (err) {
        console.error('Error parsing role permissions:', err);
      }
    }

    return {
      isRootAdmin: false,
      permissions: Array.from(permSet),
      roles: userRoles,
    };
  }

  async function hasPermission(req, requiredPerm) {
    const { isRootAdmin, permissions } = await getUserPermissions(req);
    if (isRootAdmin || permissions.includes('*')) {
      return true;
    }
    return permissions.includes(requiredPerm);
  }

  function requirePermission(requiredPerm) {
    return async function (req, res, next) {
      if (!hasUserSession(req)) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const permitted = await hasPermission(req, requiredPerm);
      if (!permitted) {
        return res.status(403).json({ error: `Access denied: missing permission ${requiredPerm}` });
      }

      next();
    };
  }

  async function requireAdmin(req, res, next) {
    const { isRootAdmin, permissions } = await getUserPermissions(req);
    if (isRootAdmin || permissions.includes('*') || permissions.includes('admin.access') || permissions.some(p => p.startsWith('admin.'))) {
      return next();
    }

    return res.status(403).json({ error: 'Unauthorized' });
  }

  function clearAdminCache(req) {
    if (req.session?.adminStatusCache) {
      delete req.session.adminStatusCache;
    }
  }

  return {
    getSessionUser,
    getPterodactylUser,
    getFreshSessionUserRecord,
    hasUserSession,
    hasPterodactylSession,
    isUserBanned,
    buildBanPayload,
    isBanAllowedRequest,
    denyBannedRequest,
    enforceBanPolicy,
    requireSession,
    requirePterodactylSession,
    getAdminStatus,
    getUserPermissions,
    hasPermission,
    requirePermission,
    requireAdmin,
    clearAdminCache,
  };
}

module.exports = createAuthz;

