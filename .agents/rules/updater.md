# System Updates & Maintenance

Ensure reliable repository, database, and process upgrades across Toledo installations.

## When this applies

- Modifying `update.sh` or `server-toledo/modules/updater.js`.
- Adding new persistent state files, database migrations, or build steps that must survive updates.
- Performing manual or automated updates on production or local installations.

## Rules

### 1. Exclusion of persistent state
- **NEVER** overwrite database files, environment credentials, local configs, or backup directories during updates.
- `SERVER_EXCLUDE` must always include:
  - `config.toml`
  - `heliactyl.db`, `heliactyl.db-shm`, `heliactyl.db-wal`
  - `sessions.db`
  - `node_modules`, `logs`, `backups`, `public`, `.git`
- `FRONTEND_EXCLUDE` must always include: `node_modules`, `dist`, `.git`.

### 2. Full pipeline execution on update
- Every update (automated or via `update.sh`) must execute the complete update chain:
  1. Pull Git updates (fast-forward only).
  2. Install backend dependencies (`pnpm` preferred, fallback to `npm`).
  3. Run Prisma client generation (`npm run prisma:generate`) and schema push (`prisma:push:sqlite` or `prisma:push:mysql`).
  4. Build frontend production assets (`pnpm build` in `frontend/`).
  5. Gracefully reload application processes via PM2 or system runner.

### 3. Fail-safe & Rollback safety
- **ALWAYS** back up existing application directories before applying files from new releases.
- If dependency installation or build fails, automatically roll back to the previous backup state.
- Keep the number of retained backups bounded by `maxBackups` to avoid filling disk storage.

### 4. Tag sanitization & command safety
- **CRITICAL**: Never pass unsanitized Git tag strings directly into shell commands.
- Only permit alphanumeric characters, dots, hyphens, underscores, and `v` prefixes (`^[a-zA-Z0-9._\-v]+$`).
