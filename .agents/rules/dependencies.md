# Dependency Management & Package Manager Selection
 
 Standards for installing, updating, and evaluating third-party packages in frontend and backend.
 
 ## When this applies
 
 - Adding new packages to `frontend/` or `server-toledo/`.
 - Upgrading existing dependencies or resolving peer dependency conflicts.
 - Running package manager commands (`pnpm`, `npm`).
 
 ## Rules
 
 ### 1. Package Manager Detection & Selection
 - **ALWAYS** check if `pnpm` is installed on the user's system before executing commands (e.g. `pnpm --version`).
 - **PREFER `pnpm`** when installed, especially when `pnpm-lock.yaml` is present or during initial installation.
 - **FALL BACK to `npm`** if `pnpm` is not installed on the system, OR if `node_modules` was previously installed with npm (indicated by `package-lock.json` without `pnpm-lock.yaml`).
 - **NEVER** mix package managers in the same folder: do not invoke `npm` inside a directory with pnpm symlinks, and do not commit duplicate lockfiles.
 
 ### 2. Version Freshness
 - **ALWAYS** check the latest published version before installing any package (e.g. `pnpm view <pkg> version` or `npm view <pkg> version`).
 - **NEVER** install an outdated, legacy, or arbitrarily pinned older version without first verifying the latest release.
 - **ALWAYS** install the newest compatible release. If a peer dependency conflict forces a constraint (e.g. peer runtime dependencies), select the highest possible version within that compatible range.
 - **NEVER** introduce deprecated or unmaintained packages when actively maintained modern alternatives exist.
 