/* --------------------------------------------- */
/* eggCheck - Verify server is a Minecraft server */
/* --------------------------------------------- */

const express = require("express");
const axios = require("axios");
const { isAuthenticated, ownsServer, PANEL_URL, API_KEY } = require("./core.js");

const HeliactylModule = {
  name: "Server -> Egg Check",
  version: "1.0.0",
  api_level: 4,
  target_platform: "10.0.0",
  description: "Verify a Pterodactyl server uses a Minecraft egg",
  author: { name: "Overnode", email: "contact@overnode.fr", url: "https://overnode.fr" },
  dependencies: [{ name: "server/core", optional: false }],
  permissions: [],
  routes: [],
  config: {},
  hooks: [],
  tags: ["core"],
  license: "MIT",
};

const MINECRAFT_KEYWORDS = [
  "minecraft", "paper", "spigot", "purpur", "fabric", "forge",
  "vanilla", "bukkit", "pufferfish", "airplane", "tuinity",
  "magma", "mohist", "catserver", "argon", "leaves", "canvas",
];

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const router = express.Router();

  // GET /api/server/:id/egg
  router.get("/server/:id/egg", isAuthenticated, ownsServer, async (req, res) => {
    try {
      const serverId = req.params.id;

      const response = await axios.get(
        `${PANEL_URL}/api/client/servers/${serverId}?include=egg`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json",
          },
        }
      );

      const eggAttrs = response.data?.attributes?.relationships?.egg?.attributes;
      if (!eggAttrs) {
        return res.json({ isMinecraft: false, egg: null });
      }

      const eggName = (eggAttrs.name || "").toLowerCase();

      const isMinecraft = MINECRAFT_KEYWORDS.some(
        (kw) => eggName.includes(kw)
      );

      res.json({
        isMinecraft,
        egg: { id: eggAttrs.id, name: eggAttrs.name, uuid: eggAttrs.uuid },
      });
    } catch (error) {
      console.error("Error checking server egg:", error);
      // If we can't determine, allow the panel (better UX than blocking)
      res.json({ isMinecraft: true, egg: null });
    }
  });

  app.use("/api", router);
};
