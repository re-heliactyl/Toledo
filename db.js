"use strict";

const dbProvider = (process.env.DB_PROVIDER || "sqlite").toLowerCase();
const { PrismaClient } = dbProvider === "mysql"
  ? require("./generated/mysql-client")
  : require("./generated/sqlite-client");

/**
 * Prisma singleton — every module receives this same instance via `load(app, db)`.
 *
 * Usage in modules:
 *   const user = await db.user.findUnique({ where: { id } });
 *   await db.transaction.create({ data: { ... } });
 *   await db.$transaction([...]);   // atomic batches
 */

let prisma;

function adjustUrlForDocker(url) {
  if (!url) return url;
  if (url.startsWith("file:")) return url;

  try {
    // Find the last '@' symbol which separates credentials from host/port
    const lastAtIndex = url.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      const credentialsPart = url.substring(0, lastAtIndex); // e.g. "mysql://user:pass"
      const hostPathPart = url.substring(lastAtIndex + 1); // e.g. "127.0.0.1:3306/db"
      
      // Parse credentialsPart
      const protocolSeparatorIndex = credentialsPart.indexOf("://");
      if (protocolSeparatorIndex !== -1) {
        const protocol = credentialsPart.substring(0, protocolSeparatorIndex);
        const userPass = credentialsPart.substring(protocolSeparatorIndex + 3);
        
        const colonIndex = userPass.indexOf(":");
        if (colonIndex !== -1) {
          const user = userPass.substring(0, colonIndex);
          const password = userPass.substring(colonIndex + 1);
          
          // Decode and re-encode password to prevent double encoding
          const decodedPassword = decodeURIComponent(password);
          const encodedPassword = encodeURIComponent(decodedPassword);
          
          // Adjust host inside Docker
          let adjustedHostPath = hostPathPart;
          if (process.env.IS_DOCKER === "true" || process.env.IS_DOCKER === true) {
            adjustedHostPath = hostPathPart
              .replace(/^127\.0\.0\.1/, "host.docker.internal")
              .replace(/^localhost/, "host.docker.internal");
          }
          
          return `${protocol}://${user}:${encodedPassword}@${adjustedHostPath}`;
        }
      }
    }
  } catch (e) {
    // Fallback on error
  }

  // Fallback simple replace
  if (process.env.IS_DOCKER === "true" || process.env.IS_DOCKER === true) {
    return url
      .replace(/@127\.0\.0\.1/, "@host.docker.internal")
      .replace(/@localhost/, "@host.docker.internal");
  }
  return url;
}

function createAdapter(provider, rawDatabaseUrl) {
  if (provider === "mysql") {
    const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
    const connectionUrl = adjustUrlForDocker(rawDatabaseUrl);
    return new PrismaMariaDb({ url: connectionUrl });
  }

  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  const sqliteUrl = rawDatabaseUrl || "file:./prisma/heliactyl.db";
  return new PrismaBetterSqlite3({ url: sqliteUrl });
}

function getClient() {
  if (!prisma) {
    const rawDatabaseUrl = dbProvider === "mysql"
      ? (process.env.MYSQL_DATABASE_URL || process.env.DATABASE_URL)
      : (process.env.SQLITE_DATABASE_URL || process.env.DATABASE_URL);

    const adapter = createAdapter(dbProvider, rawDatabaseUrl);

    prisma = new PrismaClient({
      adapter,
      log:
        process.env.NODE_ENV === "development"
          ? ["warn", "error"]
          : ["error"],
    });
  }
  return prisma;
}

const db = getClient();

/**
 * Graceful shutdown — call from process exit handlers.
 */
async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

module.exports = db;
module.exports.disconnect = disconnect;
