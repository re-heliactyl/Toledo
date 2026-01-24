const fetch = require("node-fetch");
const loadConfig = require("../handlers/config");
const settings = loadConfig("./config.toml");

module.exports = (userid, db) => {
  console.log("Fetching Pterodactyl user info...");
  console.log("User ID: "
    + userid);
  return new Promise(async (resolve, err) => {
    console.log(await db.get("users-" + userid));
    let cacheaccount = await fetch(
      settings.pterodactyl.domain +
      "/api/application/users/" +
      (await db.get("users-" + userid)) +
      "?include=servers",
      {
        method: "get",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.pterodactyl.key}`,
        },
      }
    );
    if ((await cacheaccount.statusText) === "Not Found")
      return err("Pterodactyl account not found!");
    let cacheaccountinfo = JSON.parse(await cacheaccount.text());
    resolve(cacheaccountinfo);
  });
};
