"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const backupDir = path.join(__dirname, "..", "prisma_backup");
const prismaDir = path.join(__dirname, "..", "prisma");

if (fs.existsSync(backupDir)) {
  try {
    const files = fs.readdirSync(backupDir);
    for (const file of files) {
      if (file.endsWith(".prisma")) {
        fs.copyFileSync(path.join(backupDir, file), path.join(prismaDir, file));
      }
    }
  } catch (err) {
    console.error("[PRISMA] Failed to restore schemas from backup:", err.message);
  }
}

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const rawArgs = process.argv.slice(2);

let provider = (process.env.DB_PROVIDER || "sqlite").toLowerCase();
const prismaArgs = [];

for (const arg of rawArgs) {
  if (arg.startsWith("--provider=")) {
    provider = arg.split("=")[1].toLowerCase();
    continue;
  }

  prismaArgs.push(arg);
}

if (!prismaArgs.length) {
  console.error("Usage: node scripts/prisma-runner.js <prisma args> [--provider=sqlite|mysql]");
  process.exit(1);
}

const schemaPath = provider === "mysql"
  ? path.join("prisma", "schema.mysql.prisma")
  : path.join("prisma", "schema.prisma");

const env = { ...process.env };
if (provider === "mysql" && env.MYSQL_DATABASE_URL && (!env.DATABASE_URL || env.DATABASE_URL.trim() === "")) {
  env.DATABASE_URL = env.MYSQL_DATABASE_URL;
}

if (provider === "sqlite" && env.SQLITE_DATABASE_URL && (!env.DATABASE_URL || env.DATABASE_URL.trim() === "")) {
  env.DATABASE_URL = env.SQLITE_DATABASE_URL;
}

function adjustDatabaseUrl(url) {
  if (!url) return url;
  if (url.startsWith("file:")) return url;

  try {
    const lastAtIndex = url.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      const credentialsPart = url.substring(0, lastAtIndex);
      const hostPathPart = url.substring(lastAtIndex + 1);
      
      const protocolSeparatorIndex = credentialsPart.indexOf("://");
      if (protocolSeparatorIndex !== -1) {
        const protocol = credentialsPart.substring(0, protocolSeparatorIndex);
        const userPass = credentialsPart.substring(protocolSeparatorIndex + 3);
        
        const colonIndex = userPass.indexOf(":");
        if (colonIndex !== -1) {
          const user = userPass.substring(0, colonIndex);
          const password = userPass.substring(colonIndex + 1);
          
          const decodedPassword = decodeURIComponent(password);
          const encodedPassword = encodeURIComponent(decodedPassword);
          
          let adjustedHostPath = hostPathPart;
          if (env.IS_DOCKER === "true") {
            adjustedHostPath = hostPathPart
              .replace(/^127\.0\.0\.1/, "host.docker.internal")
              .replace(/^localhost/, "host.docker.internal");
          }
          
          return `${protocol}://${user}:${encodedPassword}@${adjustedHostPath}`;
        }
      }
    }
  } catch (e) {}

  if (env.IS_DOCKER === "true") {
    return url
      .replace(/@127\.0\.0\.1/, "@host.docker.internal")
      .replace(/@localhost/, "@host.docker.internal");
  }
  return url;
}

if (env.DATABASE_URL) {
  env.DATABASE_URL = adjustDatabaseUrl(env.DATABASE_URL);
}

const executable = process.platform === "win32" ? "npx prisma" : "npx";
const result = spawnSync(executable, process.platform === "win32" ? [...prismaArgs, "--schema", schemaPath] : ["prisma", ...prismaArgs, "--schema", schemaPath], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
