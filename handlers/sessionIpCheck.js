"use strict";

const { getClientIp, areIpsEquivalent } = require('./antiVpnAllowlist');
const loadConfig = require('./config');
const db = require('../db');
const settings = loadConfig('./config.toml');

// Safe endpoints that must stay reachable while a session is being
// re-validated (ban page, settings bootstrap, logout, public app info).
const ALLOWED_PATHS = new Set([
  '/',
  '/website',
  '/auth',
  '/banned',
  '/favicon.ico',
  '/api/user/logout',
  '/api/v5/state',
  '/api/v5/settings',
]);

function isAllowedRequest(req) {
  const path = req.path || '/';

  if (ALLOWED_PATHS.has(path)) return true;
  if (path.startsWith('/assets/')) return true;
  if (path.startsWith('/auth/')) return true;
  if (path.startsWith('/api/v5/app')) return true;

  return false;
}

function createSessionIpCheck() {
  return async function sessionIpCheck(req, res, next) {
    if (!req.session?.userinfo) {
      return next();
    }

    if (isAllowedRequest(req)) {
      return next();
    }

    // Force re-login for sessions created before IP binding feature
    if (!req.session?.sessionIp) {
      return req.session.destroy((err) => {
        if (err) return next();
        const isApiRequest = req.path.startsWith('/api/');
        if (isApiRequest) {
          return res.status(401).json({
            code: 'SESSION_IP_REQUIRED',
            error: 'Session expired. Please login again.',
            redirectTo: '/auth'
          });
        }
        return res.redirect('/auth?error=session_expired');
      });
    }

    const currentIp = getClientIp(req);
    if (!currentIp) {
      return next();
    }

    if (!req.session.userAgent && req.headers['user-agent']) {
      req.session.userAgent = req.headers['user-agent'];
    }
    if (!req.session.createdAt) {
      req.session.createdAt = Date.now();
    }
    const now = Date.now();
    if (!req.session.lastActivity || now - req.session.lastActivity > 60000) {
      req.session.lastActivity = now;
    }

    // Check if IP changed to an entirely different network / subnet
    if (!areIpsEquivalent(req.session.sessionIp, currentIp)) {
      if (req.session.vpnBypassed === undefined) {
        try {
          const user = await db.user.findUnique({
            where: { id: req.session.userinfo.id },
            select: { discordId: true, twoFactorEnabled: true }
          });

          const bypassIds = (settings.api?.client?.discord?.vpn_bypass_ids || []).map(String);
          req.session.vpnBypassed = Boolean(
            user?.discordId &&
            user.twoFactorEnabled &&
            bypassIds.includes(user.discordId)
          );
        } catch (error) {
          req.session.vpnBypassed = false;
        }
      }

      if (req.session.vpnBypassed === true) {
        req.session.sessionIp = currentIp;
        return next();
      }

      return req.session.destroy((err) => {
        if (err) {
          return next();
        }

        const isApiRequest = req.path.startsWith('/api/');
        if (isApiRequest) {
          return res.status(401).json({
            code: 'SESSION_IP_CHANGED',
            error: 'Your IP address has changed. Please login again.',
            redirectTo: '/auth'
          });
        }

        return res.redirect('/auth?error=ip_changed');
      });
    } else if (req.session.sessionIp !== currentIp) {
      // User rotated temporary IPv6 host identifier within same /64 subnet (RFC 4941).
      // Smoothly update sessionIp without dropping the active session.
      req.session.sessionIp = currentIp;
    }

    next();
  };
}

module.exports = createSessionIpCheck;
