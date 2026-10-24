/* --------------------------------------------- */
/* core                                   */
/* --------------------------------------------- */

const express = require("express");
const WebSocket = require("ws");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const loadConfig = require("../../handlers/config");
const dbClient = require("../../db.js");
const settings = loadConfig("./config.toml");
let db;
const getPteroUser = require('../../handlers/getPteroUser');
const NodeCache = require("node-cache");
const createAuthz = require('../../handlers/authz');
const { fetchWebSocketCredentials, invalidateWebSocketCredentials } = require('./websocketCredentials');
const serverCache = new NodeCache({ stdTTL: 60 });
let authz = null;

function invalidateServerAccessCache(serverId) {
  if (!serverId) {
    return;
  }

  serverCache.del(`server_subusers_${serverId}`);
}

const workflowsFilePath = path.join(__dirname, "../../storage/workflows.json");

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
  "name": "Server -> Core",
  "version": "1.1.1",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "contributors": [
    {
      "name": "aachul123",
      "email": "ludo@overnode.fr",
      "url": "https://achul123.pages.dev/"
    }
  ],
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

const PANEL_URL = settings.pterodactyl.domain;
const API_KEY = settings.pterodactyl.client_key;
const ADMIN_KEY = settings.pterodactyl.key;

function ensureAuthz() {
  if (!db) {
    db = dbClient;
  }

  if (!authz && db) {
    authz = createAuthz(db);
  }

  return authz;
}

// Middleware for authentication check
const isAuthenticated = (req, res, next) => {
  const authzHandler = ensureAuthz();

  if (!authzHandler) {
    return res.status(500).json({ error: 'Authentication handler is not initialized' });
  }

  return authzHandler.requirePterodactylSession(req, res, next);
};

// Normalize server IDs for comparison
const normalizeId = (id) => {
  if (id === null || id === undefined) return '';
  const value = String(id);
  return value.includes('-') ? value.split('-')[0] : value;
};

// Check if a Pterodactyl user is the actual owner of a server via Application API
// Returns true/false. On API failure, logs and returns false.
// Uses serverCache (60s TTL) - same cache as isServerOwner middleware.
async function checkIsServerOwner(pteroUser, serverId) {
  const normalizedTargetId = normalizeId(serverId);
  const cacheKey = `user_servers_${pteroUser.id}`;
  let ownedServers = serverCache.get(cacheKey);

  if (!ownedServers) {
    const userResponse = await axios.get(
      `${PANEL_URL}/api/application/users/${pteroUser.id}?include=servers`,
      {
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          Accept: 'application/json',
        },
      }
    );
    ownedServers = userResponse.data.attributes.relationships.servers.data;
    serverCache.set(cacheKey, ownedServers);
  }

  return ownedServers.some(s => {
    const internalId = normalizeId(s.attributes?.id);
    const identifier = normalizeId(s.attributes?.identifier);
    return internalId === normalizedTargetId || identifier === normalizedTargetId;
  });
}

// Invalidate the ownership cache for a given user
async function invalidateOwnershipCache(userIdOrPteroId) {
  if (!userIdOrPteroId) return;
  serverCache.del(`user_servers_${userIdOrPteroId}`);

  try {
    const user = await db.user.findUnique({
      where: { id: String(userIdOrPteroId) },
      select: { pterodactylId: true }
    });
    if (user?.pterodactylId) {
      serverCache.del(`user_servers_${user.pterodactylId}`);
    }
  } catch (error) {
    // Ignore db lookup failures (e.g. if db not loaded yet)
  }
}

// Fetch subusers for a server directly from Pterodactyl Client API
async function fetchServerSubusers(serverId) {
  const cacheKey = `server_subusers_${serverId}`;
  let serverUsers = serverCache.get(cacheKey);
  if (serverUsers) {
    return serverUsers;
  }

  try {
    let clientServerId = serverId;
    if (/^\d+$/.test(String(serverId))) {
      try {
        const appServerRes = await axios.get(
          `${PANEL_URL}/api/application/servers/${serverId}`,
          {
            headers: {
              Authorization: `Bearer ${ADMIN_KEY}`,
              Accept: 'application/json',
            },
          }
        );
        if (appServerRes.data?.attributes?.identifier) {
          clientServerId = appServerRes.data.attributes.identifier;
        }
      } catch (e) {
        // Fallback to original serverId
      }
    }

    const response = await axios.get(
      `${PANEL_URL}/api/client/servers/${clientServerId}/users`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: 'application/json',
        },
      }
    );
    serverUsers = Array.isArray(response.data?.data) ? response.data.data : [];
    serverCache.set(cacheKey, serverUsers);
    return serverUsers;
  } catch (error) {
    console.error('Error fetching server subusers from Pterodactyl:', error.message);
    return [];
  }
}

// Match subuser against Pterodactyl server users and return permissions
async function fetchSubuserPermissions(pteroUser, serverId) {
  const subusers = await fetchServerSubusers(serverId);
  const matched = subusers.find(u => {
    const attr = u.attributes || {};
    return (pteroUser.id && String(attr.id) === String(pteroUser.id))
      || (pteroUser.uuid && attr.uuid && String(attr.uuid).toLowerCase() === String(pteroUser.uuid).toLowerCase())
      || (pteroUser.username && attr.username && attr.username.toLowerCase() === pteroUser.username.toLowerCase())
      || (pteroUser.email && attr.email && attr.email.toLowerCase() === pteroUser.email.toLowerCase());
  });

  if (matched) {
    return {
      isSubuser: true,
      permissions: Array.isArray(matched.attributes?.permissions) ? matched.attributes.permissions : []
    };
  }
  return { isSubuser: false, permissions: [] };
}

// Fixed enhancedOwnsServer middleware with fresh Pterodactyl data
// Passes both server owners AND subusers (subusers can view/use the server)
const ownsServer = async (req, res, next) => {
  try {
    const serverId = req.params.id || req.params.serverId || req.params.instanceId || req.params.idOrIdentifier || req.query?.id;
    if (!serverId) {
      return res.status(400).json({ error: 'No server ID provided' });
    }

    const authzHandler = ensureAuthz();

    if (!authzHandler) {
      return res.status(500).json({ error: 'Authentication handler is not initialized' });
    }

    if (!authzHandler.hasPterodactylSession(req) || !authzHandler.hasUserSession(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pteroUser = authzHandler.getPterodactylUser(req);
    const sessionUser = authzHandler.getSessionUser(req);
    const normalizedTargetId = normalizeId(serverId);

    // FIRST CHECK: Verify ownership via Pterodactyl Application API
    let isOwner = false;
    try {
      isOwner = await checkIsServerOwner(pteroUser, serverId);
    } catch (error) {
      console.error('Error fetching fresh server data from Pterodactyl:', error);
    }

    if (isOwner) {
      req.isOwner = true;
      req.serverPermissions = ['*'];
      return next();
    }

    // FORCE CHECK
    try {
      const forced = await db.subuserServer.findFirst({ where: { serverId, source: 'forced' } });
      if (forced && forced.userId === sessionUser.id) {
        req.isOwner = true;
        req.serverPermissions = ['*'];
        return next();
      }
    } catch (error) {
      console.error('Error checking force access:', error);
    }

    // SUBUSER CHECK: Retrieve granular permissions from Pterodactyl
    const subuserResult = await fetchSubuserPermissions(pteroUser, serverId);
    if (subuserResult.isSubuser) {
      req.isOwner = false;
      req.serverPermissions = subuserResult.permissions;
      return next();
    }

    // FALLBACK DATABASE CHECK: Check if registered in local db
    let dbSubuser = false;
    try {
      const pteroUsername = pteroUser.username;
      const userId = sessionUser.id;
      const exists = await db.subuserServer.findFirst({
        where: {
          serverId,
          source: 'subuser',
          OR: [{ userId }, { user: { pteroUsername } }]
        }
      });
      if (exists) {
        dbSubuser = true;
      }
    } catch (error) {
      console.error('Error checking subuser access in database:', error);
    }

    if (dbSubuser) {
      req.isOwner = false;
      req.serverPermissions = subuserResult.permissions || [];
      return next();
    }

    // User does not have access
    return res.status(403).json({ error: 'You do not have permission to access this server' });
  } catch (error) {
    console.error('Error in enhancedOwnsServer middleware:', error);
    return res.status(500).json({ error: 'Internal server error while checking server access' });
  }
};

// Middleware that only allows the actual server owner (rejects subusers)
const isServerOwner = async (req, res, next) => {
  try {
    const serverId = req.params.id || req.params.serverId || req.params.instanceId || req.params.idOrIdentifier || req.query?.id;
    if (!serverId) {
      return res.status(400).json({ error: 'No server ID provided' });
    }

    const authzHandler = ensureAuthz();

    if (!authzHandler) {
      return res.status(500).json({ error: 'Authentication handler is not initialized' });
    }

    if (!authzHandler.hasPterodactylSession(req) || !authzHandler.hasUserSession(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pteroUser = authzHandler.getPterodactylUser(req);

    let isOwner = false;
    try {
      isOwner = await checkIsServerOwner(pteroUser, serverId);
    } catch (error) {
      console.error('Error verifying server ownership:', error);
      // On API failure, deny access rather than returning 500
      return res.status(403).json({ error: 'Only the server owner can perform this action' });
    }

    if (!isOwner) {
      return res.status(403).json({ error: 'Only the server owner can perform this action' });
    }

    req.isOwner = true;
    req.serverPermissions = ['*'];
    next();
  } catch (error) {
    console.error('Error in isServerOwner middleware:', error);
    return res.status(500).json({ error: 'Internal server error while checking server ownership' });
  }
};



// Middleware to require specific Pterodactyl permission(s) for a server
const requireServerPermission = (requiredPermission) => {
  return async (req, res, next) => {
    const evaluate = () => {
      if (req.isOwner) {
        return next();
      }

      const perms = req.serverPermissions || [];
      if (perms.includes('*') || perms.includes('admin')) {
        return next();
      }

      const requiredList = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
      const hasPerm = requiredList.some(p => perms.includes(p));

      if (hasPerm) {
        return next();
      }

      return res.status(403).json({
        error: 'You do not have permission to perform this action',
        required: requiredList
      });
    };

    if (req.isOwner === undefined || req.serverPermissions === undefined) {
      return ownsServer(req, res, (err) => {
        if (err) return next(err);
        evaluate();
      });
    }

    evaluate();
  };
};

// WebSocket helper function with retry
async function withServerWebSocket(serverId, callback, retries = 2) {
  let ws = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Get WebSocket credentials
      const credsResponse = await fetchWebSocketCredentials({
        serverId,
        panelUrl: PANEL_URL,
        apiKey: API_KEY,
      });

      const { socket, token } = credsResponse.data;

      // Connect to WebSocket
      return await new Promise((resolve, reject) => {
        ws = new WebSocket(socket);
        const timeout = setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.close();
          }
          reject(new Error('WebSocket operation timed out'));
        }, 10000); // 10 second timeout

        let consoleBuffer = [];
        let authenticated = false;
        let callbackStarted = false;

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        ws.on('open', () => {
          // Authenticate
          ws.send(JSON.stringify({
            event: "auth",
            args: [token]
          }));
      });

      ws.on('message', async (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (message.event === 'auth success') {
          if (callbackStarted) {
            return;
          }

          callbackStarted = true;
          authenticated = true;
          try {
            await callback(ws, consoleBuffer);
            clearTimeout(timeout);
            resolve();
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        }
        else if (message.event === 'console output') {
          consoleBuffer.push(message.args[0]);
        }
        else if (message.event === 'token expiring') {
          // Get new token
          invalidateWebSocketCredentials(serverId);
          const newCredsResponse = await fetchWebSocketCredentials({
            serverId,
            panelUrl: PANEL_URL,
            apiKey: API_KEY,
          });
          // Send new token
          ws.send(JSON.stringify({
            event: "auth",
            args: [newCredsResponse.data.token]
          }));
        }
      });

      ws.on('close', () => {
        if (!authenticated) {
          clearTimeout(timeout);
          reject(new Error('WebSocket closed before authentication'));
        }
      });
    });
    } catch (error) {
      if (attempt < retries) {
        console.warn(`WebSocket attempt ${attempt + 1}/${retries + 1} failed for server ${serverId}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      console.error(`WebSocket failed after ${retries + 1} attempts for server ${serverId}:`, error);
      throw error;
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    break;
  }
}

// Helper to send command and wait for response
async function sendCommandAndGetResponse(serverId, command, responseTimeout = 5000) {
  return withServerWebSocket(serverId, async (ws, consoleBuffer) => {
    return new Promise((resolve) => {
      // Clear existing buffer
      consoleBuffer.length = 0;

      // Send command
      ws.send(JSON.stringify({
        event: "send command",
        args: [command]
      }));

      // Wait for response
      setTimeout(() => {
        resolve([...consoleBuffer]); // Return a copy of the buffer
      }, responseTimeout);
    });
  });
}

// API request helper
async function apiRequest(endpoint, method = "GET", body = null) {
  try {
    const config = {
      method: method.toLowerCase(),
      url: `${PANEL_URL}/api/application${endpoint}`,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "Application/vnd.pterodactyl.v1+json",
      },
    };

    if (body) {
      config.data = body;
    }

    const response = await axios(config);
    return response.data;
  } catch (error) {
    throw new Error(`API request failed: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
  }
}

module.exports.load = async function (app, _db) {
  db = _db;
  authz = createAuthz(_db || dbClient);
};

module.exports = {
  HeliactylModule,
  load: module.exports.load,
  isAuthenticated,
  ownsServer,
  isServerOwner,
  requireServerPermission,
  fetchServerSubusers,
  fetchSubuserPermissions,
  checkIsServerOwner,
  invalidateOwnershipCache,
  invalidateServerAccessCache,
  withServerWebSocket,
  sendCommandAndGetResponse,
  apiRequest,
  workflowsFilePath,
  PANEL_URL,
  API_KEY,
  ADMIN_KEY
};

