const axios = require("axios");
const loadConfig = require("../handlers/config");
const settings = loadConfig("./config.toml");

const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${settings.pterodactyl.key}`
  }
});

module.exports = async (userid, db) => {
  console.log("Fetching Pterodactyl user info...");
  console.log("User ID: " + userid);
  
  const pteroId = await db.get("users-" + userid);
  console.log(pteroId);
  
  try {
    const response = await pteroApi.get(`/api/application/users/${pteroId}?include=servers`);
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error("Pterodactyl account not found!");
    }
    throw error;
  }
};
