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

module.exports = async () => {
  const allServers = [];

  async function getServersOnPage(page) {
    const response = await pteroApi.get(`/api/application/servers/?page=${page}`);
    return response.data;
  }

  let currentPage = 1;
  while (true) {
    const page = await getServersOnPage(currentPage);
    allServers.push(...page.data);
    if (page.meta.pagination.total_pages > currentPage) {
      currentPage++;
    } else {
      break;
    }
  }

  return allServers;
};
