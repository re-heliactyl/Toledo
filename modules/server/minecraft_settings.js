const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");
const { recordServerActivity } = require('../../handlers/activityLog');

const HeliactylModule = {
  "name": "Server -> Minecraft Settings",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Expose and manage Minecraft-specific settings (server.properties and spigot.yml)",
  "author": {
    "name": "Antigravity",
    "email": "antigravity@google.com",
    "url": "https://google.com"
  },
  "dependencies": [{ "name": "server/core", "optional": false }],
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

  // Helper: Read file contents from Pterodactyl client API
  async function readFile(serverId, filename) {
    try {
      const file = encodeURIComponent(filename);
      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}/files/contents?file=${file}`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          responseType: "text",
        }
      );
      return response.data;
    } catch (error) {
      if (error.response && (error.response.status === 404 || error.response.status === 400 || error.response.status === 500)) {
        return null;
      }
      throw error;
    }
  }

  // Helper: Write file contents to Pterodactyl client API
  async function writeFile(serverId, filename, content) {
    const file = encodeURIComponent(filename);
    const response = await axios.post(
      `${PANEL_URL}/api/client/servers/${serverId}/files/write?file=${file}`,
      content,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
          "Content-Type": "text/plain",
        },
      }
    );
    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`Failed to write file ${filename}: ${response.statusText}`);
    }
  }

  // GET /api/server/:id/minecraft/settings
  router.get("/server/:id/minecraft/settings", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;

      // Try reading server.properties
      const propertiesContent = await readFile(serverId, "/server.properties");
      if (propertiesContent === null) {
        return res.json({ isMinecraft: false });
      }

      // Parse server.properties
      const properties = {};
      const lines = propertiesContent.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          const value = trimmed.substring(eqIdx + 1).trim();
          properties[key] = value;
        }
      }

      // Try reading spigot.yml
      const spigotContent = await readFile(serverId, "/spigot.yml");
      const spigot = {};
      if (spigotContent !== null) {
        // Simple regex extraction for bungeecord
        const bungeecordMatch = spigotContent.match(/^\s*bungeecord\s*:\s*(true|false)/m);
        if (bungeecordMatch) {
          spigot.bungeecord = bungeecordMatch[1];
        }
      }

      res.json({
        isMinecraft: true,
        properties,
        spigot
      });
    } catch (error) {
      console.error("Error reading Minecraft settings:", error);
      res.status(500).json({ error: "Failed to read Minecraft settings" });
    }
  });

  // POST /api/server/:id/minecraft/settings
  router.post("/server/:id/minecraft/settings", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;
      const { properties: propertiesUpdates, spigot: spigotUpdates } = req.body;

      let activityLogged = false;

      // 1. Update server.properties
      if (propertiesUpdates && Object.keys(propertiesUpdates).length > 0) {
        const propertiesContent = await readFile(serverId, "/server.properties");
        if (propertiesContent !== null) {
          const lines = propertiesContent.split(/\r?\n/);
          const modifiedLines = [];
          const processedKeys = new Set();

          for (let line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx !== -1) {
                const key = trimmed.substring(0, eqIdx).trim();
                if (propertiesUpdates.hasOwnProperty(key)) {
                  line = `${key}=${propertiesUpdates[key]}`;
                  processedKeys.add(key);
                }
              }
            }
            modifiedLines.push(line);
          }

          // Add any keys that weren't in the original file
          for (const [key, val] of Object.entries(propertiesUpdates)) {
            if (!processedKeys.has(key)) {
              modifiedLines.push(`${key}=${val}`);
            }
          }

          await writeFile(serverId, "/server.properties", modifiedLines.join('\n'));
          activityLogged = true;
        }
      }

      // 2. Update spigot.yml
      if (spigotUpdates && Object.keys(spigotUpdates).length > 0) {
        const spigotContent = await readFile(serverId, "/spigot.yml");
        if (spigotContent !== null) {
          let newSpigotContent = spigotContent;

          if (spigotUpdates.hasOwnProperty("bungeecord")) {
            const newValue = spigotUpdates.bungeecord;
            const bungeecordRegex = /^(\s*bungeecord\s*:\s*)(true|false)/m;
            if (bungeecordRegex.test(newSpigotContent)) {
              newSpigotContent = newSpigotContent.replace(bungeecordRegex, `$1${newValue}`);
            } else {
              // Try to find settings: block and append
              if (/^settings:/m.test(newSpigotContent)) {
                newSpigotContent = newSpigotContent.replace(/^settings:/m, `settings:\n  bungeecord: ${newValue}`);
              } else {
                newSpigotContent = newSpigotContent + `\nsettings:\n  bungeecord: ${newValue}`;
              }
            }
          }

          await writeFile(serverId, "/spigot.yml", newSpigotContent);
          activityLogged = true;
        }
      }

      if (activityLogged) {
        await recordServerActivity(db, req, serverId, 'minecraft.settings.update', {
          properties: Object.keys(propertiesUpdates || {}),
          spigot: Object.keys(spigotUpdates || {})
        });
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error updating Minecraft settings:", error);
      res.status(500).json({ error: "Failed to update Minecraft settings" });
    }
  });

  app.use("/api", router);
};
