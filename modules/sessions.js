const { validate, schemas } = require('../handlers/validate');
const path = require('path');
const sqlite3 = require('sqlite3');
const geoip = require('geoip-lite');
const { normalizeIp } = require('../handlers/antiVpnAllowlist');
const loadConfig = require('../handlers/config');
const settings = loadConfig('./config.toml');

const HeliactylModule = {
  name: 'Sessions',
  version: '1.1.1',
  api_level: 4,
  target_platform: '10.0.0',
  description: 'Active session management',
  author: {
    name: "aachul123",
    email: "ludo@overnode.fr",
    url: "https://achul123.pages.dev/"
  },
  dependencies: ['geoip-lite'],
  tags: ['core'],
  license: 'MIT'
};

function isPrivateIp(rawIp) {
  if (!rawIp) return true;
  const ip = normalizeIp(rawIp) || String(rawIp).trim();
  if (!ip) return true;
  if (ip.startsWith('127.') || ip === '::1' || ip.toLowerCase() === 'localhost') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return false;
}

function lookupLocation(rawIp) {
  if (isPrivateIp(rawIp)) return null;
  const ip = normalizeIp(rawIp) || String(rawIp).trim();
  try {
    const geo = geoip.lookup(ip);
    if (!geo) return null;
    return {
      country: geo.country || null,
      region: geo.region || null,
      city: geo.city || null
    };
  } catch {
    return null;
  }
}

function getStore(req, app) {
  return req.sessionStore || app.get('sessionStore') || null;
}

function isNonSqliteProvider() {
  const dbUrl = typeof settings.database === 'object' ? settings.database.url : settings.database;
  return Boolean(
    (process.env.DB_PROVIDER && process.env.DB_PROVIDER.toLowerCase() !== 'sqlite') ||
    (typeof dbUrl === 'string' && (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')))
  );
}

async function fetchActiveSessionRows(store, db, sessionsDbPath, now) {
  if (store && store.db && typeof store.db.all === 'function') {
    const table = store.table || 'sessions';
    return new Promise((resolve, reject) => {
      store.db.all("SELECT sid, expired, sess FROM " + table + " WHERE ? <= expired", [now], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  if (store && store.pool && typeof store.pool.query === 'function') {
    try {
      const table = typeof store.quotedTable === 'function' ? store.quotedTable() : (store.tableName ? '"' + store.tableName.replace(/"/g, '""') + '"' : '"session"');
      const result = await store.pool.query("SELECT sid, expire as expired, sess FROM " + table + " WHERE expire > to_timestamp($1)", [now / 1000]);
      return result.rows || [];
    } catch (err) {
      console.error('Failed to query sessions from PG pool:', err);
    }
  }

  // PostgreSQL fallback via Prisma
  if (db && typeof db.$queryRawUnsafe === 'function' && isNonSqliteProvider()) {
    try {
      const rows = await db.$queryRawUnsafe('SELECT sid, expire as expired, sess FROM "session" WHERE expire > NOW()');
      return rows || [];
    } catch {}
  }

  // If deployed on PostgreSQL or non-SQLite, avoid opening SQLite database
  if (isNonSqliteProvider()) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(sessionsDbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      conn.all("SELECT sid, expired, sess FROM sessions WHERE ? <= expired", [now], (qErr, rows) => {
        conn.close();
        if (qErr) return reject(qErr);
        resolve(rows || []);
      });
    });
  });
}

async function fetchSingleSession(store, db, sessionsDbPath, sid) {
  if (store && typeof store.get === 'function') {
    return new Promise((resolve, reject) => {
      store.get(sid, (err, sess) => {
        if (err) return reject(err);
        resolve(sess || null);
      });
    });
  }

  if (db && typeof db.$queryRawUnsafe === 'function' && isNonSqliteProvider()) {
    try {
      const rows = await db.$queryRawUnsafe('SELECT sess FROM "session" WHERE sid = $1', sid);
      const row = rows && rows[0];
      if (!row) return null;
      return typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
    } catch {}
  }

  if (isNonSqliteProvider()) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(sessionsDbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      conn.get("SELECT sess FROM sessions WHERE sid = ?", [sid], (qErr, row) => {
        conn.close();
        if (qErr) return reject(qErr);
        if (!row) return resolve(null);
        try { resolve(JSON.parse(row.sess)); } catch { resolve(null); }
      });
    });
  });
}

async function deleteSessionRecord(store, db, sessionsDbPath, sid) {
  if (store && typeof store.destroy === 'function') {
    return new Promise((resolve, reject) => {
      store.destroy(sid, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  if (db && typeof db.$executeRawUnsafe === 'function' && isNonSqliteProvider()) {
    try {
      await db.$executeRawUnsafe('DELETE FROM "session" WHERE sid = $1', sid);
      return;
    } catch {}
  }

  if (isNonSqliteProvider()) {
    return;
  }

  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(sessionsDbPath, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      conn.run("DELETE FROM sessions WHERE sid = ?", [sid], (qErr) => {
        conn.close();
        if (qErr) return reject(qErr);
        resolve();
      });
    });
  });
}

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const createAuthz = require('../handlers/authz');
  const authz = createAuthz(db);
  const sessionDbName = (settings.session && typeof settings.session.db === 'string') ? settings.session.db : 'sessions.db';
  const sessionsDbPath = path.isAbsolute(sessionDbName) ? sessionDbName : path.resolve(__dirname, '..', sessionDbName);

  app.get('/api/user/sessions', authz.requireSession, validate(schemas.emptyPayload, 'query'), async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const currentSid = req.sessionID;
      const store = getStore(req, app);
      const now = Date.now();

      await new Promise((resolve) => {
        if (req.session && typeof req.session.save === 'function') {
          req.session.save(resolve);
        } else {
          resolve();
        }
      });

      const rows = await fetchActiveSessionRows(store, db, sessionsDbPath, now);

      const sessions = [];
      for (const row of rows) {
        let sess;
        try {
          sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
        } catch {
          continue;
        }
        if (!sess || !sess.userinfo || sess.userinfo.id !== userId) continue;

        const isCurrent = row.sid === currentSid;
        const maxAge = sess.cookie?.originalMaxAge || 7 * 24 * 60 * 60 * 1000;
        const expiredTime = row.expired instanceof Date ? row.expired.getTime() : Number(row.expired);
        const lastActivity = sess.lastActivity || (expiredTime ? expiredTime - maxAge : null) || sess.createdAt || now;

        sessions.push({
          id: row.sid,
          isCurrent,
          ip: sess.sessionIp || (isCurrent ? req.session.sessionIp : null),
          userAgent: sess.userAgent || (isCurrent ? req.session.userAgent || req.headers['user-agent'] : null),
          createdAt: sess.createdAt || lastActivity || now,
          lastActivity: isCurrent ? (req.session.lastActivity || now) : lastActivity,
          expiresAt: expiredTime,
        });
      }

      if (!sessions.some((s) => s.isCurrent)) {
        sessions.unshift({
          id: currentSid,
          isCurrent: true,
          ip: req.session.sessionIp || null,
          userAgent: req.session.userAgent || req.headers['user-agent'] || null,
          createdAt: req.session.createdAt || now,
          lastActivity: req.session.lastActivity || now,
          expiresAt: req.session.cookie?.expires ? new Date(req.session.cookie.expires).getTime() : now + 7 * 86400000,
        });
      }

      sessions.sort((a, b) => {
        if (a.isCurrent) return -1;
        if (b.isCurrent) return 1;
        return (b.lastActivity || b.createdAt || 0) - (a.lastActivity || a.createdAt || 0);
      });

      const uniqueIps = [...new Set(sessions.map((s) => s.ip).filter(Boolean))];
      const locationMap = new Map();

      for (const ip of uniqueIps) {
        locationMap.set(ip, lookupLocation(ip));
      }

      for (const session of sessions) {
        if (session.ip) {
          session.location = locationMap.get(session.ip) || null;
        }
      }

      res.json({ sessions });
    } catch (error) {
      console.error('Error listing sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  const handleRevokeOthers = async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const currentSid = req.sessionID;
      const store = getStore(req, app);
      const now = Date.now();

      const rows = await fetchActiveSessionRows(store, db, sessionsDbPath, now);
      let revokedCount = 0;

      for (const row of rows) {
        if (row.sid === currentSid) continue;
        let sess;
        try {
          sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
        } catch {
          continue;
        }
        if (sess && sess.userinfo && sess.userinfo.id === userId) {
          await deleteSessionRecord(store, db, sessionsDbPath, row.sid);
          revokedCount++;
        }
      }

      try {
        await db.notification.create({
          data: {
            userId,
            action: 'user:sessions_revoked',
            name: 'All other sessions disconnected'
          }
        });
      } catch {}

      res.json({
        success: true,
        revokedCount,
        message: revokedCount + " other session" + (revokedCount !== 1 ? "s" : "") + " disconnected"
      });
    } catch (error) {
      console.error('Error revoking other sessions:', error);
      res.status(500).json({ error: 'Failed to revoke other sessions' });
    }
  };

  // Register literal /others and /revoke-others BEFORE parameterized /:sid to prevent route conflicts
  app.post('/api/user/sessions/revoke-others', authz.requireSession, handleRevokeOthers);
  app.delete('/api/user/sessions/revoke-others', authz.requireSession, handleRevokeOthers);
  app.delete('/api/user/sessions/others', authz.requireSession, handleRevokeOthers);

  app.delete('/api/user/sessions/:sid', authz.requireSession, validate(schemas.stringIdParam, 'params'), async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const targetSid = req.params.sid;
      const currentSid = req.sessionID;
      const store = getStore(req, app);

      if (targetSid === currentSid) {
        return res.status(400).json({ error: 'Cannot disconnect your current session. Use logout instead.' });
      }

      const sess = await fetchSingleSession(store, db, sessionsDbPath, targetSid);
      if (!sess) return res.status(404).json({ error: 'Session not found' });
      if (!sess.userinfo || sess.userinfo.id !== userId) {
        return res.status(403).json({ error: 'Not your session' });
      }

      await deleteSessionRecord(store, db, sessionsDbPath, targetSid);

      try {
        await db.notification.create({
          data: { userId, action: 'user:session_disconnected', name: 'Session disconnected' }
        });
      } catch {}

      res.json({ message: 'Session disconnected' });
    } catch (error) {
      console.error('Error disconnecting session:', error);
      res.status(500).json({ error: 'Failed to disconnect session' });
    }
  });
};
