"use strict";

/**
 * @fileoverview Heliactyl Next - © Matt James 2025
 */

const startTime = process.hrtime();
const { spawn } = require('child_process');
const fs = require("fs").promises;
const fsSync = require("fs");
const express = require("express");
const session = require("express-session");
const nocache = require('nocache');
const cookieParser = require('cookie-parser');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const chalk = require("chalk");

const app = express();

// Use the updated Rust-like logging system
const createLogger = require("./handlers/console.js");
const logger = createLogger();

// Version information
const VERSION = "10.0.0";
const PLATFORM_CODENAME = "Toledo";
const API_LEVEL = 4;

// Apply request logging middleware first
app.use(logger.requestLogger());

// Replace console.log with logger
//logger.info(`Heliactyl Next ${VERSION} (${PLATFORM_CODENAME})`);

const loadConfig = require("./handlers/config");
const Database = require("./db.js");
const ModuleLoader = require("./handlers/modules.js");

const settings = loadConfig("./config.toml");

// Database
const db = new Database(settings.database);

// Set up Express
app.set('view engine', 'ejs');
const wsInstance = require("express-ws")(app);

// Apply websocket logging
wsInstance.getWss().on('connection', logger.wsRequestLogger.bind(logger));

// Configure middleware
app.use(cookieParser());
app.use(express.text());
app.use(nocache());
app.use(express.json({
  limit: "500kb"
}));

const sessionConfig = {
  secret: settings.website.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  },
  proxy: true
};

app.use(session(sessionConfig));
app.use((req, res, next) => {
  if (!req.session) {
    logger.error('Session store error occurred');
    return req.session.regenerate((err) => {
      if (err) {
        logger.error('Failed to regenerate session', err);
        return res.status(500).send('Internal Server Error');
      }
      next();
    });
  }
  next();
});

// Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader("X-Powered-By", `10th Gen Heliactyl Next (${PLATFORM_CODENAME})`);
  res.setHeader("X-Heliactyl", `Heliactyl Next v${VERSION} - "${PLATFORM_CODENAME}"`);
  next();
});

// Set up static assets BEFORE module loading
// This ensures the assets route takes precedence
app.use('/assets', express.static(path.join(__dirname, 'public')));

// Export for modules
const moduleExports = {
  app,
  db,
  VERSION,
  PLATFORM_CODENAME,
  API_LEVEL
};

module.exports = moduleExports;

global.__rootdir = __dirname;

(async () => {
  try {
    // Initialize module loader
    const moduleLoader = new ModuleLoader(app, db, VERSION, API_LEVEL);

    // Load all modules
    const loadedModules = await moduleLoader.loadAllModules();
    //logger.info(`Successfully loaded ${loadedModules.size} modules`);

    // Store module information globally for admin panel
    global.moduleInfo = moduleLoader.getLoadedModuleInfo();

    // URL redirect for app paths - Keep this AFTER the static assets middleware
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/')) return next();
      if (req.path.startsWith('/assets/')) return next();
      const appPath = '/' + req.path;
      const fullPath = appPath + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');

      res.redirect(301, fullPath);
    });

    // Start server
    const server = app.listen(settings.website.port, "0.0.0.0", () => {
      const bootTime = process.hrtime(startTime);
      const bootTimeMs = (bootTime[0] * 1000 + bootTime[1] / 1000000).toFixed(2);
      logger.info(`${chalk.red('https server')} listening on ` + chalk.cyan(`0.0.0.0:${settings.website.port} ` + chalk.gray(`(app@${VERSION} / ${PLATFORM_CODENAME}, ${bootTimeMs > 1000 ? (bootTimeMs / 1000).toFixed(2) + 's' : bootTimeMs + 'ms'})`)), {}, true);
      //logger.info(`Systems operational - booted in ${bootTimeMs > 1000 ? (bootTimeMs/1000).toFixed(2) + 's' : bootTimeMs + 'ms'}`);
    });

    // Store server instance globally for access during reboot
    global.server = server;
  } catch (error) {
    logger.error('Failed to start Heliactyl', error);
    process.exit(1);
  }
})();

// Error handling - logger will automatically filter Bun errors
process.on('uncaughtException', (error) => logger.error('Uncaught exception', error));
process.on('unhandledRejection', (error) => logger.error('Unhandled rejection', error));