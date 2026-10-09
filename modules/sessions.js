const path = require('path');
const sqlite3 = require('sqlite3');

const HeliactylModule = {
  name: 'Sessions',
  version: '1.0.0',
  api_level: 4,
  target_platform: '10.0.0',
  description: 'Active session management',
  author: {
    name: "aachul123",
    email: "ludo@overnode.fr",
    url: "https://achul123.pages.dev/"
  },
  dependencies: [],
  tags: ['core'],
  license: 'MIT'
};

const geoCache = new Map();
const GEO_CACHE_TTL = 1000 * 60 * 60;

async function lookupLocation(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return null;
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) return cached.data;
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
    const data = await response.json();
    if (data.status === 'success') {
      const location = { country: data.country, region: data.regionName, city: data.city };
      geoCache.set(ip, { data: location, ts: Date.now() });
      return location;
    }
  } catch {}
  return null;
}

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const createAuthz = require('../handlers/authz');
  const authz = createAuthz(db);
  const sessionsDbPath = path.join(__dirname, '..', 'sessions.db');

  function openDb(mode) {
    return new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(sessionsDbPath, mode, (err) => {
        if (err) return reject(err);
        resolve(conn);
      });
    });
  }

  app.get('/api/user/sessions', authz.requireSession, async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const currentSid = req.sessionID;
      const conn = await openDb(sqlite3.OPEN_READONLY);

      const rows = await new Promise((resolve, reject) => {
        conn.all('SELECT sid, expired, sess FROM sessions', (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      });
      conn.close();

      const sessions = [];
      for (const row of rows) {
        let sess;
        try { sess = JSON.parse(row.sess); } catch { continue; }
        if (!sess.userinfo || sess.userinfo.id !== userId) continue;

        const isCurrent = row.sid === currentSid;
        const maxAge = sess.cookie?.originalMaxAge || 7 * 24 * 60 * 60 * 1000;
        const lastActivity = row.expired - maxAge;

        sessions.push({
          id: row.sid,
          isCurrent,
          ip: sess.sessionIp || null,
          userAgent: sess.userAgent || null,
          createdAt: sess.createdAt || lastActivity || Date.now(),
          lastActivity: lastActivity || Date.now(),
          expiresAt: row.expired,
        });
      }

      sessions.sort((a, b) => {
        if (a.isCurrent) return -1;
        if (b.isCurrent) return 1;
        return b.createdAt - a.createdAt;
      });

      await Promise.all(sessions.map(async (s) => {
        if (s.ip) s.location = await lookupLocation(s.ip);
      }));

      res.json({ sessions });
    } catch (error) {
      console.error('Error listing sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  app.delete('/api/user/sessions/:sid', authz.requireSession, async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const targetSid = req.params.sid;
      const currentSid = req.sessionID;

      if (targetSid === currentSid) {
        return res.status(400).json({ error: 'Cannot disconnect your current session. Use logout instead.' });
      }

      const conn = await openDb(sqlite3.OPEN_READONLY);
      const row = await new Promise((resolve, reject) => {
        conn.get('SELECT sess FROM sessions WHERE sid = ?', [targetSid], (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });
      conn.close();

      if (!row) return res.status(404).json({ error: 'Session not found' });

      let sess;
      try { sess = JSON.parse(row.sess); } catch { return res.status(404).json({ error: 'Session not found' }); }
      if (!sess.userinfo || sess.userinfo.id !== userId) {
        return res.status(403).json({ error: 'Not your session' });
      }

      const writeConn = await openDb(sqlite3.OPEN_READWRITE);
      await new Promise((resolve, reject) => {
        writeConn.run('DELETE FROM sessions WHERE sid = ?', [targetSid], (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      writeConn.close();

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
