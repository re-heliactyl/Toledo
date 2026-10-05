const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const axios = require('axios');
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');

const HeliactylModule = {
  "name": "Extras",
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

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

/* Module */
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);

  app.get(`/api/password`, async (req, res) => {
    if (!authz.hasUserSession(req)) return res.redirect("/login");
    const sessionUser = authz.getSessionUser(req);
    const pteroUser = authz.getPterodactylUser(req);

    const user = await db.user.findUnique({
      where: { id: sessionUser.id },
      select: { sftpPassword: true }
    });

    let checkPassword = user?.sftpPassword;

    if (checkPassword) {
      return res.json({ password: checkPassword });
    } else {
      let newpassword = makeid(settings.api.client.passwordgenerator["length"]);

      await pteroApi.patch(`/api/application/users/${pteroUser.id}`, {
        username: pteroUser.username,
        email: pteroUser.email,
        first_name: pteroUser.first_name,
        last_name: pteroUser.last_name,
        password: newpassword
      });

      await db.user.update({
        where: { id: sessionUser.id },
        data: { sftpPassword: newpassword }
      });

      return res.json({ password: newpassword });
    }
  });

  app.get("/panel", async (req, res) => {
    res.redirect(settings.pterodactyl.domain);
  });

  app.get("/regen", async (req, res) => {
    if (!authz.hasPterodactylSession(req) || !authz.hasUserSession(req)) return res.redirect("/login");
    if (settings.api.client.allow.regen !== true) return res.send("You cannot regenerate your password currently.");

    const pteroUser = authz.getPterodactylUser(req);
    const sessionUser = authz.getSessionUser(req);
    let newpassword = makeid(settings.api.client.passwordgenerator["length"]);
    req.session.password = newpassword;

    await updatePassword(pteroUser, sessionUser.id, newpassword, settings, db);
    res.redirect("/security");
  });

  app.post("/api/password/change", validate(schemas.passwordChangeDirect), async (req, res) => {
    if (!authz.hasPterodactylSession(req) || !authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    if (!settings.api.client.allow.regen) return res.status(403).json({ error: "Password changes are not allowed" });

    const pteroUser = authz.getPterodactylUser(req);
    const sessionUser = authz.getSessionUser(req);
    const { password } = req.body;

    try {
      await updatePassword(pteroUser, sessionUser.id, password, settings, db);
      res.json({ success: true, message: "Password updated successfully" });
    } catch (error) {
      console.error("Password update error:", error);
      res.status(500).json({ error: "Failed to update password" });
    }
  });

  // Helper function to update password
  async function updatePassword(pteroUserInfo, heliactylUserId, newPassword, settings, db) {
    await pteroApi.patch(`/api/application/users/${pteroUserInfo.id}`, {
      username: pteroUserInfo.username,
      email: pteroUserInfo.email,
      first_name: pteroUserInfo.first_name,
      last_name: pteroUserInfo.last_name,
      password: newPassword
    });

    await db.user.update({
      where: { id: heliactylUserId },
      data: { sftpPassword: newPassword }
    });
  }
};

function makeid(length) {
  let result = '';
  let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
