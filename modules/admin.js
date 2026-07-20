const express = require('express');
const { spawn } = require('child_process');
const { exec } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const TOML = require('@iarna/toml');
const log = require('../handlers/log.js');
const cache = require('../handlers/cache.js');
const loadConfig = require('../handlers/config.js');
const settings = loadConfig('./config.toml');
const { validate, schemas } = require('../handlers/validate');
const { adminWriteRateLimit } = require('../handlers/rateLimit');
const createAuthz = require('../handlers/authz');
const { getSftpIpMode, setSftpIpMode } = require('../handlers/sftp');
const { removeServerSubdomains } = require('./server/subdomains.js');
const { getClientIp, normalizeIp } = require('../handlers/antiVpnAllowlist');

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

const pteroClientApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  timeout: 5000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.client_key}`
  }
});

async function getServerRuntimeStatus(serverIdentifier) {
  if (!serverIdentifier || !settings.pterodactyl.client_key) {
    return 'unknown';
  }

  return cache.getOrSet(
    `admin:server-status:${serverIdentifier}`,
    async () => {
      try {
        const response = await pteroClientApi.get(`/api/client/servers/${serverIdentifier}/resources`);
        return response.data?.attributes?.current_state || 'unknown';
      } catch (error) {
        return 'unknown';
      }
    },
    30
  );
}

async function enrichServersWithRuntimeStatus(servers) {
  const concurrency = 10;
  const enrichedServers = [];

  for (let index = 0; index < servers.length; index += concurrency) {
    const batch = servers.slice(index, index + concurrency);
    const enrichedBatch = await Promise.all(
      batch.map(async (server) => {
        const runtimeStatus = await getServerRuntimeStatus(server.attributes?.identifier);

        return {
          ...server,
          attributes: {
            ...server.attributes,
            runtimeStatus,
            isOnline: runtimeStatus === 'running'
          }
        };
      })
    );

    enrichedServers.push(...enrichedBatch);
  }

  return enrichedServers;
}

const HeliactylModule = {
  "name": "Admin",
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

/* Module */
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  let configNeedsReboot = false;
  const authz = createAuthz(db);
  const checkAdmin = (req, requiredPerm) => {
    if (!requiredPerm) {
      console.warn('[RBAC Warning] checkAdmin called without requiredPerm key');
    }
    return authz.hasPermission(req, requiredPerm || 'admin.access');
  };
  const banUserSelect = {
    id: true,
    username: true,
    email: true,
    pterodactylId: true,
    isBanned: true,
    banReason: true,
    bannedAt: true,
    bannedByUserId: true,
    bannedByUsername: true,
  };

  const serializeBanState = (user) => ({
    isBanned: user?.isBanned === true,
    reason: user?.banReason || null,
    bannedAt: user?.bannedAt || null,
    bannedByUserId: user?.bannedByUserId || null,
    bannedByUsername: user?.bannedByUsername || null,
  });

  const resolveLocalUser = async (userIdParam) => {
    const parsedPterodactylId = Number.parseInt(userIdParam, 10);

    return db.user.findFirst({
      where: Number.isNaN(parsedPterodactylId)
        ? { id: userIdParam }
        : {
            OR: [
              { id: userIdParam },
              { pterodactylId: parsedPterodactylId },
            ],
          },
      select: banUserSelect,
    });
  };

  const serializeAntiVpnAllowlistEntry = (entry) => ({
    id: entry.id,
    ipAddress: entry.ipAddress,
    reason: entry.reason,
    createdByUserId: entry.createdByUserId,
    createdByUsername: entry.createdByUsername,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    users: (entry.users || []).map((link) => ({
      id: link.user?.id || link.userId,
      username: link.user?.username || 'Unknown',
      email: link.user?.email || null,
      pterodactylId: link.user?.pterodactylId || null,
      linkedAt: link.createdAt,
    })),
    audits: (entry.audits || []).map((audit) => ({
      id: audit.id,
      action: audit.action,
      actorUserId: audit.actorUserId,
      actorUsername: audit.actorUsername,
      actorIpAddress: audit.actorIpAddress,
      oldValue: audit.oldValue ? JSON.parse(audit.oldValue) : null,
      newValue: audit.newValue ? JSON.parse(audit.newValue) : null,
      createdAt: audit.createdAt,
    })),
  });

  // New /api/admin endpoint
  app.get("/api/admin", async (req, res) => {
    const userPerms = await authz.getUserPermissions(req);
    const hasAdmin = await checkAdmin(req);
    res.json({
      admin: hasAdmin,
      isRootAdmin: userPerms.isRootAdmin,
      permissions: userPerms.permissions,
      roles: userPerms.roles
    });
  });

  // Update dashboard name
  app.patch("/api/config/name", validate(schemas.configName), async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { name } = req.body;

      // Read the current config
      const configPath = path.join(process.cwd(), 'config.toml');
      const configContent = await fs.readFile(configPath, 'utf8');

      // Parse TOML
      const parsedConfig = TOML.parse(configContent);

      // Update name
      parsedConfig.name = name;

      // Convert back to TOML and write
      const updatedConfigContent = TOML.stringify(parsedConfig);
      await fs.writeFile(configPath, updatedConfigContent, 'utf8');

      // Mark that config needs reboot
      configNeedsReboot = true;

      log(
        "config updated",
        `${req.session.userinfo.username} updated the dashboard name to "${name}".`
      );

      res.json({
        success: true,
        message: "Dashboard name updated successfully"
      });
    } catch (error) {
      console.error("Error updating dashboard name:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update dashboard logo
  app.patch("/api/config/logo", validate(schemas.configLogo), async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { logo } = req.body;

      // Read the current config
      const configPath = path.join(process.cwd(), 'config.toml');
      const configContent = await fs.readFile(configPath, 'utf8');

      // Parse TOML
      const parsedConfig = TOML.parse(configContent);

      // Update logo
      parsedConfig.logo = logo;

      // Convert back to TOML and write
      const updatedConfigContent = TOML.stringify(parsedConfig);
      await fs.writeFile(configPath, updatedConfigContent, 'utf8');

      // Mark that config needs reboot
      configNeedsReboot = true;

      log(
        "config updated",
        `${req.session.userinfo.username} updated the dashboard logo.`
      );

      res.json({
        success: true,
        message: "Dashboard logo updated successfully"
      });
    } catch (error) {
      console.error("Error updating dashboard logo:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Rebuild panel
  app.post("/api/panel/rebuild", async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {

      // Path to the panel directory
      const panelPath = path.join(process.cwd(), '..', 'panel');

      // Send immediate response
      res.json({
        success: true,
        message: "Panel rebuild initiated"
      });

      // Execute rebuild in a child process
      const buildProcess = exec('npm run build', {
        cwd: panelPath
      }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Panel rebuild error: ${error}`);
          log(
            "panel rebuild failed",
            `${req.session.userinfo.username} attempted to rebuild the panel but encountered an error.`
          );
          return;
        }

        log(
          "panel rebuilt",
          `${req.session.userinfo.username} successfully rebuilt the panel.`
        );
        if (stderr) console.error(`Panel rebuild stderr: ${stderr}`);
      });
    } catch (error) {
      console.error("Error initiating panel rebuild:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get config backups
  app.get("/api/config/backups", async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const backupsDir = path.join(process.cwd(), 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      const files = await fs.readdir(backupsDir);
      const backups = files
        .filter(file => file.startsWith('config-') && file.endsWith('.toml'))
        .map(file => ({
          name: file,
          timestamp: parseInt(file.replace('config-', '').replace('.toml', '')),
          path: path.join('backups', file)
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      res.json(backups);
    } catch (error) {
      console.error("Error getting backups:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/config", async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const config = await loadConfig("./config.toml");
      res.json(config);
    } catch (error) {
      console.error("Error fetching config:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/settings/sftp", async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const mode = await getSftpIpMode(db);
      res.json({ mode });
    } catch (error) {
      console.error("Error fetching SFTP settings:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/settings/sftp", adminWriteRateLimit, validate(schemas.configSftpMode), async (req, res) => {
    if (!await checkAdmin(req, 'admin.settings.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const mode = await setSftpIpMode(db, req.body.mode);

      log(
        "sftp config updated",
        `${req.session.userinfo.username} updated the SFTP IP mode to "${mode}".`
      );

      res.json({
        success: true,
        mode,
      });
    } catch (error) {
      console.error("Error updating SFTP settings:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get specific backup
  app.get("/api/config/backups/:file", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const fileName = req.params.file.replace(/[^a-zA-Z0-9\-\.]/g, ''); // Basic sanitization
      const backupPath = path.join(process.cwd(), 'backups', fileName);

      const content = await fs.readFile(backupPath, 'utf8');
      res.type('text/plain').send(content);
    } catch (error) {
      console.error("Error reading backup:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Restore from backup
  app.post("/api/config/backups/:file/restore", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const fileName = req.params.file.replace(/[^a-zA-Z0-9\-\.]/g, ''); // Basic sanitization
      const backupPath = path.join(process.cwd(), 'backups', fileName);
      const configPath = path.join(process.cwd(), 'config.toml');

      // Verify backup exists and is valid TOML
      const backupContent = await fs.readFile(backupPath, 'utf8');
      try {
        TOML.parse(backupContent);
      } catch (e) {
        return res.status(400).json({ error: "Invalid TOML in backup file" });
      }

      // Create backup of current config before restore
      const newBackupPath = path.join(process.cwd(), 'backups', `config-${Date.now()}.toml`);
      await fs.copyFile(configPath, newBackupPath);

      // Restore from backup
      await fs.copyFile(backupPath, configPath);

      // Mark that config needs reboot
      configNeedsReboot = true;

      log(
        "config restored",
        `${req.session.userinfo.username} restored the dashboard configuration from backup: ${fileName}`
      );

      res.json({
        success: true,
        message: "Configuration restored successfully",
        newBackup: newBackupPath
      });
    } catch (error) {
      console.error("Error restoring backup:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete backup
  app.delete("/api/config/backups/:file", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const fileName = req.params.file.replace(/[^a-zA-Z0-9\-\.]/g, ''); // Basic sanitization
      const backupPath = path.join(process.cwd(), 'backups', fileName);

      // Verify backup exists
      try {
        await fs.access(backupPath);
      } catch (e) {
        return res.status(404).json({ error: "Backup file not found" });
      }

      // Delete backup
      await fs.unlink(backupPath);

      log(
        "backup deleted",
        `${req.session.userinfo.username} deleted a configuration backup: ${fileName}`
      );

      res.json({
        success: true,
        message: "Backup deleted successfully"
      });
    } catch (error) {
      console.error("Error deleting backup:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Check if reboot is needed
  app.get("/api/reboot/status", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      res.json({
        needsReboot: configNeedsReboot
      });
    } catch (error) {
      console.error("Error checking reboot status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Improved reboot endpoint
  app.post("/api/reboot", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      log(
        "dashboard reboot",
        `${req.session.userinfo.username} initiated a dashboard reboot.`
      );

      // Send response before reboot
      res.json({ success: true, message: "Initiating dashboard reboot" });

      // Reset the reboot flag
      configNeedsReboot = false;

      // Schedule the restart after response is sent
      setTimeout(() => {
        // Kill all child processes
        if (global.tailwindProcess) {
          global.tailwindProcess.kill();
        }

        // Close the database connection
        if (db && typeof db.close === 'function') {
          db.close();
        }

        // Close the Express server
        if (global.server) {
          global.server.close();
        }

        // Get the current process's PID
        const oldPid = process.pid;

        // Spawn a new process
        const scriptPath = path.join(process.cwd(), 'app.js');
        const child = spawn('bun', [scriptPath], {
          detached: true,
          stdio: 'inherit',
          env: { ...process.env, REBOOT_OLD_PID: oldPid }
        });

        // Unref child to allow old process to exit
        child.unref();

        // Kill the old process and any remaining children
        process.kill(oldPid);
      }, 1000);

    } catch (error) {
      console.error("Error initiating reboot:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/radar/nodes", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");

      // Check status of each node
      const nodesWithStatus = await Promise.all(nodes.map(async (node) => {
        try {
          const response = await axios.get(`http://${node.fqdn}:${node.port}/api/stats`, {
            timeout: 5000
          });
          return {
            ...node,
            status: "online",
            stats: response.data
          };
        } catch (error) {
          return {
            ...node,
            status: "offline",
            stats: null
          };
        }
      }));

      res.json(nodesWithStatus);
    } catch (error) {
      console.error("Error fetching radar nodes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get specific radar node
  app.get("/api/radar/nodes/:id", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");
      const node = nodes.find(n => n.id === req.params.id);

      if (!node) return res.status(404).json({ error: "Node not found" });

      try {
        const response = await axios.get(`http://${node.fqdn}:${node.port}/api/stats`, {
          timeout: 5000
        });
        res.json({
          ...node,
          status: "online",
          stats: response.data
        });
      } catch (error) {
        res.json({
          ...node,
          status: "offline",
          stats: null
        });
      }
    } catch (error) {
      console.error("Error fetching radar node:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Add new radar node
  app.post("/api/radar/nodes", validate(schemas.nodeCreate), async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { name, fqdn, port, webhookUrl } = req.body;

      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");
      const id = Math.random().toString(36).substring(2, 15);

      const newNode = {
        id,
        name,
        fqdn,
        port,
        webhookUrl,
        createdAt: new Date().toISOString()
      };

      nodes.push(newNode);
      await db.heliactyl.upsert({ where: { key: "radar-nodes" }, create: { key: "radar-nodes", value: JSON.stringify(nodes) }, update: { value: JSON.stringify(nodes) } });

      log(
        "radar node added",
        `${req.session.userinfo.username} added a new Radar node: ${name} (${fqdn}:${port})`
      );

      res.status(201).json(newNode);
    } catch (error) {
      console.error("Error adding radar node:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update radar node
  app.patch("/api/radar/nodes/:id", validate(schemas.nodeUpdate), async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");
      const nodeIndex = nodes.findIndex(n => n.id === req.params.id);

      if (nodeIndex === -1) return res.status(404).json({ error: "Node not found" });

      const updatedNode = {
        ...nodes[nodeIndex],
        ...req.body,
        id: nodes[nodeIndex].id // Prevent ID from being changed
      };

      nodes[nodeIndex] = updatedNode;
      await db.heliactyl.upsert({ where: { key: "radar-nodes" }, create: { key: "radar-nodes", value: JSON.stringify(nodes) }, update: { value: JSON.stringify(nodes) } });

      log(
        "radar node updated",
        `${req.session.userinfo.username} updated Radar node: ${updatedNode.name}`
      );

      res.json(updatedNode);
    } catch (error) {
      console.error("Error updating radar node:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete radar node
  app.delete("/api/radar/nodes/:id", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");
      const nodeIndex = nodes.findIndex(n => n.id === req.params.id);

      if (nodeIndex === -1) return res.status(404).json({ error: "Node not found" });

      const deletedNode = nodes[nodeIndex];
      nodes.splice(nodeIndex, 1);
      await db.heliactyl.upsert({ where: { key: "radar-nodes" }, create: { key: "radar-nodes", value: JSON.stringify(nodes) }, update: { value: JSON.stringify(nodes) } });

      log(
        "radar node deleted",
        `${req.session.userinfo.username} deleted Radar node: ${deletedNode.name}`
      );

      res.status(204).send();
    } catch (error) {
      console.error("Error deleting radar node:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get analytics across all nodes
  app.get("/api/radar/analytics", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");

      // Collect stats from all online nodes
      const nodeStats = await Promise.all(nodes.map(async (node) => {
        try {
          const response = await axios.get(`http://${node.fqdn}:${node.port}/api/stats`, {
            timeout: 5000
          });
          return {
            node: node.name,
            status: "online",
            stats: response.data
          };
        } catch (error) {
          return {
            node: node.name,
            status: "offline",
            stats: null
          };
        }
      }));

      // Aggregate statistics
      const analytics = {
        total_nodes: nodes.length,
        online_nodes: nodeStats.filter(n => n.status === "online").length,
        total_detections: nodeStats.reduce((acc, n) =>
          acc + (n.stats?.total_detections || 0), 0),
        detections_by_type: {},
        detections_by_node: {},
        recent_detections: nodeStats.reduce((acc, n) =>
          acc + (n.stats?.recent_detections || 0), 0)
      };

      // Combine detection types across nodes
      nodeStats.forEach(nodeStat => {
        if (nodeStat.stats?.detection_types) {
          Object.entries(nodeStat.stats.detection_types).forEach(([type, count]) => {
            analytics.detections_by_type[type] = (analytics.detections_by_type[type] || 0) + count;
          });
        }
      });

      res.json(analytics);
    } catch (error) {
      console.error("Error fetching radar analytics:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get detections from a specific node
  app.get("/api/radar/nodes/:id/detections", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const result = await db.heliactyl.findUnique({ where: { key: "radar-nodes" } });
      const nodes = JSON.parse(result?.value || "[]");
      const node = nodes.find(n => n.id === req.params.id);

      if (!node) return res.status(404).json({ error: "Node not found" });

      try {
        const response = await axios.get(`http://${node.fqdn}:${node.port}/api/detections`, {
          timeout: 5000
        });
        res.json(response.data);
      } catch (error) {
        res.status(502).json({ error: "Unable to connect to Radar node" });
      }
    } catch (error) {
      console.error("Error fetching node detections:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/servers", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      // Get servers with pagination
      const page = parseInt(req.query.page) || 1;

      const serversResponse = await pteroApi.get(`/api/application/servers?page=${page}&per_page=10000&include=user,node`);
      const servers = serversResponse.data?.data || [];
      const serversWithRuntimeStatus = await enrichServersWithRuntimeStatus(servers);

      res.json({
        ...serversResponse.data,
        data: serversWithRuntimeStatus
      });
    } catch (error) {
      console.error("Error fetching servers:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/servers/:id", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const serverResponse = await pteroApi.get(`/api/application/servers/${req.params.id}?include=allocations,user,subusers,pack,nest,egg,variables,location,node,databases`);
      res.json(serverResponse.data);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "Server not found" });
      }
      console.error("Error fetching server:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/servers/:id/suspend", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      await pteroApi.post(`/api/application/servers/${req.params.id}/suspend`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error suspending server:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/servers/:id/unsuspend", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      await pteroApi.post(`/api/application/servers/${req.params.id}/unsuspend`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error unsuspending server:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/servers/:id", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const force = req.query.force === 'true';
      const endpoint = force ?
        `/api/application/servers/${req.params.id}/force` :
        `/api/application/servers/${req.params.id}`;

      await pteroApi.delete(endpoint);

      try {
        await removeServerSubdomains(db, req.params.id);
      } catch (subdomainError) {
        console.error('Failed to remove server subdomains:', subdomainError);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting server:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Nests endpoints
  app.get("/api/nests", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const page = parseInt(req.query.page) || 1;

      const response = await pteroApi.get(`/api/application/nests?page=${page}&per_page=10000`);
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching nests:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/nests/:id/eggs", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const page = parseInt(req.query.page) || 1;
      const includes = req.query.include ? req.query.include.split(',').join(',') : 'nest,servers,config,script,variables';

      const response = await pteroApi.get(`/api/application/nests/${req.params.id}/eggs?include=${includes}&page=${page}&per_page=10000`);
      res.json(response.data);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "Nest not found" });
      }
      console.error("Error fetching eggs:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Users endpoints
  app.get("/api/users", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const page = parseInt(req.query.page) || 1;

      const response = await pteroApi.get(`/api/application/users?page=${page}&per_page=10000`);
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const response = await pteroApi.get(`/api/application/users/${req.params.id}?include=servers`);
      res.json(response.data);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "User not found" });
      }
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/users", validate(schemas.adminCreateUser), async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { email, username, first_name, last_name, password } = req.body;

      const response = await pteroApi.post('/api/application/users', {
        email,
        username,
        first_name,
        last_name,
        password,
        root_admin: false // Default to non-admin for safety
      });

      res.status(201).json(response.data);
    } catch (error) {
      if (error.response) {
        return res.status(error.response.status).json(error.response.data);
      }
      console.error("Error creating user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/users/:id", validate(schemas.adminUpdateUser), async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const updateData = req.body;

      const response = await pteroApi.patch(`/api/application/users/${req.params.id}`, updateData);
      res.json(response.data);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "User not found" });
      }
      if (error.response) {
        return res.status(error.response.status).json(error.response.data);
      }
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/users/:id", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      await pteroApi.delete(`/api/application/users/${req.params.id}`);
      res.status(204).send();
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "User not found" });
      }
      if (error.response) {
        return res.status(error.response.status).json(error.response.data);
      }
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id/anti-vpn-allowlist", async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const user = await resolveLocalUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const entries = await db.antiVpnAllowlist.findMany({
        where: {
          users: {
            some: { userId: user.id }
          }
        },
        include: {
          users: {
            include: {
              user: {
                select: { id: true, username: true, email: true, pterodactylId: true }
              }
            },
            orderBy: { createdAt: 'asc' }
          },
          audits: {
            orderBy: { createdAt: 'desc' },
            take: 50
          }
        },
        orderBy: { updatedAt: 'desc' }
      });

      res.json({ user, entries: entries.map(serializeAntiVpnAllowlistEntry) });
    } catch (error) {
      console.error("Error fetching anti-VPN allowlist:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/users/:id/anti-vpn-allowlist", adminWriteRateLimit, validate(schemas.adminAntiVpnAllowlistCreate), async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const user = await resolveLocalUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const actor = authz.getSessionUser(req);
      const actorIp = getClientIp(req);
      const ipAddress = normalizeIp(req.body.ipAddress);
      if (!ipAddress) {
        return res.status(400).json({ error: "IP address must be a valid IPv4 or IPv6 address" });
      }

      const entry = await db.$transaction(async (tx) => {
        const existingEntry = await tx.antiVpnAllowlist.findUnique({
          where: { ipAddress },
          include: {
            users: true
          }
        });

        const allowlist = await tx.antiVpnAllowlist.upsert({
          where: { ipAddress },
          update: {
            reason: req.body.reason
          },
          create: {
            ipAddress,
            reason: req.body.reason,
            createdByUserId: actor?.id || null,
            createdByUsername: actor?.username || null
          }
        });

        await tx.antiVpnAllowlistUser.upsert({
          where: {
            allowlistId_userId: {
              allowlistId: allowlist.id,
              userId: user.id
            }
          },
          update: {},
          create: {
            allowlistId: allowlist.id,
            userId: user.id
          }
        });

        const alreadyLinked = existingEntry?.users?.some((link) => link.userId === user.id) === true;
        await tx.antiVpnAllowlistAudit.create({
          data: {
            allowlistId: allowlist.id,
            action: existingEntry ? (alreadyLinked ? 'update' : 'link') : 'create',
            actorUserId: actor?.id || null,
            actorUsername: actor?.username || null,
            actorIpAddress: actorIp,
            oldValue: existingEntry ? JSON.stringify({
              ipAddress: existingEntry.ipAddress,
              reason: existingEntry.reason,
              linkedUserIds: existingEntry.users.map((link) => link.userId)
            }) : null,
            newValue: JSON.stringify({
              ipAddress,
              reason: req.body.reason,
              linkedUserId: user.id
            })
          }
        });

        return tx.antiVpnAllowlist.findUnique({
          where: { id: allowlist.id },
          include: {
            users: {
              include: {
                user: {
                  select: { id: true, username: true, email: true, pterodactylId: true }
                }
              },
              orderBy: { createdAt: 'asc' }
            },
            audits: {
              orderBy: { createdAt: 'desc' },
              take: 50
            }
          }
        });
      });

      log(
        "anti-vpn allowlist updated",
        `${actor?.username || 'staff'} allowed IP ${ipAddress} for ${user.username}: ${req.body.reason}`
      );

      res.status(201).json({ entry: serializeAntiVpnAllowlistEntry(entry) });
    } catch (error) {
      console.error("Error updating anti-VPN allowlist:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/users/:id/anti-vpn-allowlist/:entryId", adminWriteRateLimit, async (req, res) => {
    if (!await checkAdmin(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const user = await resolveLocalUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const actor = authz.getSessionUser(req);
      const actorIp = getClientIp(req);
      const entry = await db.antiVpnAllowlist.findUnique({
        where: { id: req.params.entryId },
        include: { users: true }
      });

      if (!entry || !entry.users.some((link) => link.userId === user.id)) {
        return res.status(404).json({ error: "Allowlist entry not found for this user" });
      }

      await db.$transaction([
        db.antiVpnAllowlistUser.deleteMany({
          where: {
            allowlistId: entry.id,
            userId: user.id
          }
        }),
        db.antiVpnAllowlistAudit.create({
          data: {
            allowlistId: entry.id,
            action: 'unlink',
            actorUserId: actor?.id || null,
            actorUsername: actor?.username || null,
            actorIpAddress: actorIp,
            oldValue: JSON.stringify({
              ipAddress: entry.ipAddress,
              reason: entry.reason,
              linkedUserIds: entry.users.map((link) => link.userId)
            }),
            newValue: JSON.stringify({
              ipAddress: entry.ipAddress,
              unlinkedUserId: user.id
            })
          }
        })
      ]);

      log(
        "anti-vpn allowlist removed",
        `${actor?.username || 'staff'} removed IP ${entry.ipAddress} from ${user.username}`
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Error removing anti-VPN allowlist entry:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Nodes endpoints
  app.get("/api/nodes", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const page = parseInt(req.query.page) || 1;

      const response = await pteroApi.get(`/api/application/nodes?page=${page}&per_page=10000`);
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching nodes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/nodes/:id", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const response = await pteroApi.get(`/api/application/nodes/${req.params.id}?include=allocations,location,servers`);
      res.json(response.data);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "Node not found" });
      }
      console.error("Error fetching node:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get node configuration details
  app.get("/api/nodes/:id/configuration", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const response = await pteroApi.get(`/api/application/nodes/${req.params.id}/configuration`);
      res.json(response.data);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: "Node not found" });
      }
      console.error("Error fetching node configuration:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get multiple users' coins in bulk (MUST be before /api/users/:id/coins)
  app.get("/api/users/bulk/coins", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const ids = req.query.ids;
      if (!ids) {
        return res.status(400).json({ error: "Missing ids parameter" });
      }

      const pterodactylIds = ids.split(',').map(id => id.trim()).filter(id => id).map(id => parseInt(id));
      if (pterodactylIds.length === 0) {
        return res.status(400).json({ error: "Invalid ids parameter" });
      }

      const users = await db.user.findMany({
        where: { pterodactylId: { in: pterodactylIds } },
        select: { pterodactylId: true, coins: true }
      });

      const results = {};
      for (const user of users) {
        results[user.pterodactylId] = user.coins;
      }

      res.json(results);
    } catch (error) {
      console.error("Error fetching bulk user coins:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get multiple users' resources in bulk (MUST be before /api/users/:id/resources)
  app.get("/api/users/bulk/resources", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const ids = req.query.ids;
      if (!ids) {
        return res.status(400).json({ error: "Missing ids parameter" });
      }

      const pterodactylIds = ids.split(',').map(id => id.trim()).filter(id => id).map(id => parseInt(id));
      if (pterodactylIds.length === 0) {
        return res.status(400).json({ error: "Invalid ids parameter" });
      }

      const users = await db.user.findMany({
        where: { pterodactylId: { in: pterodactylIds } },
        select: { pterodactylId: true, extraRam: true, extraDisk: true, extraCpu: true, extraServers: true }
      });

      const results = {};
      for (const user of users) {
        results[user.pterodactylId] = {
          ram: user.extraRam,
          disk: user.extraDisk,
          cpu: user.extraCpu,
          servers: user.extraServers
        };
      }

      res.json(results);
    } catch (error) {
      console.error("Error fetching bulk user resources:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/bulk/ban-status", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const ids = req.query.ids;
      if (!ids) {
        return res.status(400).json({ error: "Missing ids parameter" });
      }

      const pterodactylIds = ids
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id)
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => !Number.isNaN(id));

      if (pterodactylIds.length === 0) {
        return res.status(400).json({ error: "Invalid ids parameter" });
      }

      const users = await db.user.findMany({
        where: { pterodactylId: { in: pterodactylIds } },
        select: banUserSelect,
      });

      const results = {};
      for (const pterodactylId of pterodactylIds) {
        results[pterodactylId] = serializeBanState(null);
      }

      for (const user of users) {
        if (user.pterodactylId != null) {
          results[user.pterodactylId] = serializeBanState(user);
        }
      }

      res.json(results);
    } catch (error) {
      console.error("Error fetching bulk ban status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get discord ID map for all users (used for admin search by discord ID)
  app.get("/api/users/bulk/discord-ids", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const users = await db.user.findMany({
        where: { discordId: { not: null }, pterodactylId: { not: null } },
        select: { pterodactylId: true, discordId: true }
      });

      const results = {};
      for (const user of users) {
        results[user.pterodactylId] = user.discordId;
      }

      res.json(results);
    } catch (error) {
      console.error("Error fetching bulk discord IDs:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id/ban", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const user = await resolveLocalUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        userId: user.id,
        username: user.username,
        ...serializeBanState(user),
      });
    } catch (error) {
      console.error("Error fetching user ban state:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/users/:id/ban", adminWriteRateLimit, validate(schemas.adminBanUser), async (req, res) => {
    if (!await authz.hasPermission(req, 'admin.users.ban')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const actor = authz.getSessionUser(req);
      const user = await resolveLocalUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.id === actor?.id) {
        return res.status(400).json({ error: "You cannot ban your own account" });
      }

      const updatedUser = await db.user.update({
        where: { id: user.id },
        data: {
          isBanned: true,
          banReason: req.body.reason,
          bannedAt: new Date(),
          bannedByUserId: actor?.id || null,
          bannedByUsername: actor?.username || null,
        },
        select: banUserSelect,
      });

      await db.notification.create({
        data: {
          userId: user.id,
          action: "user:ban",
          name: `Account banned by ${actor?.username || 'staff'}`,
        }
      });

      log(
        "user banned",
        `${actor?.username || 'staff'} banned ${updatedUser.username}: ${req.body.reason}`
      );

      if (app.afkManager) {
        app.afkManager.disconnectUser(user.id, 'banned');
      }

      res.json({
        success: true,
        userId: updatedUser.id,
        username: updatedUser.username,
        ...serializeBanState(updatedUser),
      });
    } catch (error) {
      console.error("Error banning user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/users/:id/ban", adminWriteRateLimit, async (req, res) => {
    if (!await authz.hasPermission(req, 'admin.users.ban')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const actor = authz.getSessionUser(req);
      const user = await resolveLocalUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const updatedUser = await db.user.update({
        where: { id: user.id },
        data: {
          isBanned: false,
          banReason: null,
          bannedAt: null,
          bannedByUserId: null,
          bannedByUsername: null,
        },
        select: banUserSelect,
      });

      await db.notification.create({
        data: {
          userId: user.id,
          action: "user:unban",
          name: `Account unbanned by ${actor?.username || 'staff'}`,
        }
      });

      log(
        "user unbanned",
        `${actor?.username || 'staff'} unbanned ${updatedUser.username}`
      );

      res.json({
        success: true,
        userId: updatedUser.id,
        username: updatedUser.username,
        ...serializeBanState(updatedUser),
      });
    } catch (error) {
      console.error("Error unbanning user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get user coins
  app.get("/api/users/:id/coins", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const pterodactylId = req.params.id;
      const user = await db.user.findFirst({
        where: { OR: [{ id: pterodactylId }, { pterodactylId: parseInt(pterodactylId) }] },
        select: { coins: true }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ coins: user.coins });
    } catch (error) {
      console.error("Error fetching user coins:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get user resources
  app.get("/api/users/:id/resources", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const pterodactylId = req.params.id;
      const user = await db.user.findFirst({
        where: { OR: [{ id: pterodactylId }, { pterodactylId: parseInt(pterodactylId) }] },
        select: { extraRam: true, extraDisk: true, extraCpu: true, extraServers: true }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        ram: user.extraRam,
        disk: user.extraDisk,
        cpu: user.extraCpu,
        servers: user.extraServers
      });
    } catch (error) {
      console.error("Error fetching user resources:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id/addcoins/:coins", adminWriteRateLimit, async (req, res) => {
    if (!await authz.hasPermission(req, 'admin.users.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const pterodactylId = req.params.id;
      const user = await db.user.findFirst({
        where: { OR: [{ id: pterodactylId }, { pterodactylId: parseInt(pterodactylId) }] }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const coinsToAdd = parseInt(req.params.coins);
      if (isNaN(coinsToAdd) || coinsToAdd < 0 || coinsToAdd > 999999999999999) {
        return res.status(400).json({ error: "Invalid coin amount" });
      }

      const updatedUser = await db.user.update({
        where: { id: user.id },
        data: { coins: user.coins + coinsToAdd }
      });

      res.json({ success: true, coins: updatedUser.coins });
    } catch (error) {
      console.error("Error updating user coins:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update user coins
  app.patch("/api/users/:id/coins", adminWriteRateLimit, validate(schemas.adminSetCoins), async (req, res) => {
    if (!await authz.hasPermission(req, 'admin.users.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const pterodactylId = req.params.id;
      const user = await db.user.findFirst({
        where: { OR: [{ id: pterodactylId }, { pterodactylId: parseInt(pterodactylId) }] }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { coins } = req.body;
      await db.user.update({
        where: { id: user.id },
        data: { coins: coins }
      });

      log(
        "coins updated",
        `${req.session.userinfo.username} updated coins to ${coins} for user ID ${user.id}`
      );

      res.json({ success: true, coins });
    } catch (error) {
      console.error("Error updating user coins:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update user resources
  app.patch("/api/users/:id/resources", adminWriteRateLimit, validate(schemas.adminSetResources), async (req, res) => {
    if (!await authz.hasPermission(req, 'admin.users.manage')) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const pterodactylId = req.params.id;
      const user = await db.user.findFirst({
        where: { OR: [{ id: pterodactylId }, { pterodactylId: parseInt(pterodactylId) }] }
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const resources = req.body;
      await db.user.update({
        where: { id: user.id },
        data: {
          extraRam: resources.ram,
          extraDisk: resources.disk,
          extraCpu: resources.cpu,
          extraServers: resources.servers
        }
      });

      await suspendIfNeeded(user.id, settings, db);

      log(
        "resources updated",
        `${req.session.userinfo.username} updated resources for user ID ${user.id}`
      );

      res.json({ success: true, ...resources });
    } catch (error) {
      console.error("Error updating user resources:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Config management endpoints
  app.get("/api/config/raw", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const configPath = path.join(process.cwd(), 'config.toml');
      const configContent = await fs.readFile(configPath, 'utf8');
      res.type('text/plain').send(configContent);
    } catch (error) {
      console.error("Error reading config:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/config/raw", express.text(), async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      try {
        parsedConfig = TOML.parse(req.body);
      } catch (parseError) {
        return res.status(400).json({
          error: "Invalid TOML syntax",
          details: parseError.message,
          line: parseError.line,
          column: parseError.column
        });
      }

      // Validate required config keys exist
      const requiredKeys = [
        { path: ['website', 'domain'], name: 'website.domain' },
        { path: ['pterodactyl', 'domain'], name: 'pterodactyl.domain' },
        { path: ['pterodactyl', 'key'], name: 'pterodactyl.key' }
      ];

      for (const { path, name } of requiredKeys) {
        let value = parsedConfig;
        for (const key of path) {
          value = value?.[key];
        }
        if (!value) {
          return res.status(400).json({
            error: "Missing required configuration",
            details: `Required key '${name}' is missing or empty`
          });
        }
      }

      const configPath = path.join(process.cwd(), 'config.toml');
      const backupPath = path.join(process.cwd(), 'backups', `config-${Date.now()}.toml`);

      // Create backup
      await fs.mkdir(path.join(process.cwd(), 'backups'), { recursive: true });
      await fs.copyFile(configPath, backupPath);

      // Write validated config
      await fs.writeFile(configPath, req.body, 'utf8');

      configNeedsReboot = true;

      log(
        "config updated",
        `${req.session.userinfo.username} updated dashboard configuration`
      );

      res.json({ success: true, backup: backupPath });
    } catch (error) {
      console.error("Error updating config:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reboot management endpoints
  app.get("/api/reboot/status", async (req, res) => {
    if (!await checkAdminStatus(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    res.json({ needsReboot: configNeedsReboot });
  });

  app.post("/api/reboot", async (req, res) => {
    if (!await authz.getAdminStatus(req)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    log(
      "dashboard reboot",
      `${req.session.userinfo.username} initiated a dashboard reboot`
    );

    res.json({ success: true, message: "Initiating reboot" });

    // Reset reboot flag and handle restart
    configNeedsReboot = false;
    setTimeout(handleReboot, 1000);
  });

  // Platform Statistics endpoint - accessible to all authenticated users
  // Should be other place than admin modules because all users need access to it, not just admins
  app.get("/api/stats", async (req, res) => {
    if (!req.session.pterodactyl) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      // Fetch data from Pterodactyl + local DB
      const [usersResponse, serversResponse, nodesResponse, enabledLocations] = await Promise.all([
        pteroApi.get('/api/application/users?per_page=1'),
        pteroApi.get('/api/application/servers?per_page=1'),
        pteroApi.get('/api/application/nodes?per_page=1'),
        db.locationConfig.count({ where: { enabled: true } })
      ]);

      const stats = {
        totalUsers: usersResponse.data.meta.pagination.total || 0,
        totalServers: serversResponse.data.meta.pagination.total || 0,
        totalNodes: nodesResponse.data.meta.pagination.total || 0,
        totalLocations: enabledLocations
      };

      res.json(stats);
    } catch (error) {
      console.error("Error fetching platform stats:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};


// Utility function to check and handle server suspension
async function suspendIfNeeded(userId, settings, db) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { pterodactylId: true, packageName: true, extraRam: true, extraDisk: true, extraCpu: true, extraServers: true }
  });

  if (!user || !user.pterodactylId) return;

  try {
    const userResponse = await pteroApi.get(`/api/application/users/${user.pterodactylId}?include=servers`);

    const userData = userResponse.data;
    const servers = userData.attributes.relationships.servers.data;

    // Calculate resource usage
    const usage = servers.reduce((acc, server) => ({
      ram: acc.ram + server.attributes.limits.memory,
      disk: acc.disk + server.attributes.limits.disk,
      cpu: acc.cpu + server.attributes.limits.cpu
    }), { ram: 0, disk: 0, cpu: 0 });

    // Get user's resource limits
    const package = settings.api.client.packages.list[user.packageName || settings.api.client.packages.default];
    const extra = { ram: user.extraRam, disk: user.extraDisk, cpu: user.extraCpu, servers: user.extraServers };

    // Check if over limits
    const isOverLimit =
      usage.ram > (package.ram + extra.ram) ||
      usage.disk > (package.disk + extra.disk) ||
      usage.cpu > (package.cpu + extra.cpu) ||
      servers.length > (package.servers + extra.servers);

    // Suspend/unsuspend servers as needed
    for (const server of servers) {
      await pteroApi.post(`/api/application/servers/${server.attributes.id}/${isOverLimit ? 'suspend' : 'unsuspend'}`);
    }
  } catch (error) {
    console.error("Error in suspendIfNeeded:", error);
  }
}

module.exports.suspend = suspendIfNeeded;
