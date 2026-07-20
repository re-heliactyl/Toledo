"use strict";

const startTime = process.hrtime();
const express = require("express");
const session = require("express-session");
const compression = require("compression");
const nocache = require("nocache");
const cookieParser = require("cookie-parser");
const path = require("path");
const chalk = require('./handlers/colors');

require("dotenv").config({ path: path.join(__dirname, ".env") });

const createLogger = require("./handlers/console.js");
const loadConfig = require("./handlers/config");
const createAuthz = require("./handlers/authz");
const db = require("./db.js");
const ModuleLoader = require("./handlers/modules.js");

const VERSION = "10.0.0";
const PLATFORM_CODENAME = "Toledo";
const API_LEVEL = 4;

const settings = loadConfig("./config.toml");
const logger = createLogger();
const app = express();
app.set('trust proxy', 1);
const wsInstance = require("express-ws")(app);

wsInstance.getWss().on("connection", logger.wsRequestLogger.bind(logger));

app.use(logger.requestLogger());
app.use(compression({ threshold: 1024 }));
app.use(cookieParser());
app.use(express.json({ limit: "500kb" }));
app.use(express.text({ limit: "5mb", type: "text/plain" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Powered-By", `10th Gen Heliactyl Next (${PLATFORM_CODENAME})`);
  res.setHeader("X-Heliactyl", `Heliactyl Next v${VERSION} - "${PLATFORM_CODENAME}"`);
  next();
});

app.use("/assets", express.static(path.join(__dirname, "public"), { maxAge: "7d" }));
app.use(nocache());

const dbUrl = typeof settings.database === "object" ? settings.database.url : settings.database;
const isPostgres = dbUrl && (dbUrl.startsWith("postgresql://") || dbUrl.startsWith("postgres://"));

let sessionStore;
if (isPostgres) {
  const PgStore = require("connect-pg-simple")(session);
  sessionStore = new PgStore({ conString: dbUrl, tableName: "session", createTableIfMissing: true });
} else {
  const SQLiteStore = require("connect-sqlite3")(session);
  let sessionDb = "sessions.db";
  if (typeof settings.database === "string") {
    sessionDb = settings.database;
  } else if (settings.database && typeof settings.database.url === "string") {
    sessionDb = settings.database.url.replace(/^file:/, "");
  }
  try {
    const sqlite3 = require("sqlite3");
    const dbInstance = new sqlite3.Database("./" + sessionDb);
    sessionStore = new SQLiteStore({ db: dbInstance });
  } catch (err) {
    sessionStore = new SQLiteStore({ db: sessionDb, dir: "./" });
  }
}

app.use(session({
  store: sessionStore,
  secret: settings.website.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  },
  proxy: true
}));

app.use((req, res, next) => {
  if (!req.session) {
    logger.error("Session store error occurred");
    return res.status(500).send("Internal Server Error");
  }
  next();
});

const authz = createAuthz(db);
app.use(authz.enforceBanPolicy);

const createSessionIpCheck = require("./handlers/sessionIpCheck");
app.use(createSessionIpCheck());

const moduleExports = { app, db, VERSION, PLATFORM_CODENAME, API_LEVEL };
module.exports = moduleExports;
global.__rootdir = __dirname;

if (require.main === module || require.main?.filename === __filename || !module.parent) {
  (async () => {
    try {
      const moduleLoader = new ModuleLoader(app, db, VERSION, API_LEVEL);
      await moduleLoader.loadAllModules();
      global.moduleInfo = moduleLoader.getLoadedModuleInfo();

      const server = app.listen(settings.website.port, "0.0.0.0", () => {
        const bootTime = process.hrtime(startTime);
        const bootTimeMs = (bootTime[0] * 1000 + bootTime[1] / 1000000).toFixed(2);
        const duration = bootTimeMs > 1000 ? (bootTimeMs / 1000).toFixed(2) + "s" : bootTimeMs + "ms";
        logger.info(
          `${chalk.red("https server")} listening on ` +
          chalk.cyan(`0.0.0.0:${settings.website.port} ` + chalk.gray(`(app@${VERSION} / ${PLATFORM_CODENAME}, ${duration})`)),
          {}, true
        );
      });

      global.server = server;
    } catch (error) {
      logger.error("Failed to start Heliactyl", error);
      process.exit(1);
    }
  })();
}

process.on("uncaughtException", (error) => logger.error("Uncaught exception", error));
process.on("unhandledRejection", (error) => logger.error("Unhandled rejection", error));

// Graceful Prisma shutdown
const gracefulShutdown = async () => {
  const { disconnect } = require("./db.js");
  await disconnect();
  process.exit(0);
};
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
