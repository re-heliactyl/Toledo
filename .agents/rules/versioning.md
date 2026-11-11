# File & Platform Versioning

Maintain consistent file versions, platform build levels, and release dates across updates.

## When this applies

- Editing any module containing a `HeliactylModule` manifest or an explicit `version` field.
- Preparing commits or delivering feature updates, bug fixes, or refactors.
- Updating configuration files (`server-toledo/config.toml`, `example_config.toml`).

## Rules

### 1. Module-level version bump
- Whenever a module in `server-toledo/modules/` (or any file with an explicit `version` property) is modified:
  - **Patch bump (`+0.0.1`)**: for bug fixes, performance optimizations, refactoring, or dead code cleanup (e.g. `1.0.0` → `1.0.1`).
  - **Minor bump (`+0.1.0`)**: for new features, new API routes, or schema extensions (e.g. `1.0.1` → `1.1.0`).
- Always keep the version string in valid SemVer format (`major.minor.patch`).

### 2. Platform level and date in config.toml
- On each code change or commit touching project functionality, update `server-toledo/config.toml`:
  - Increment `platform_level` by `1` (e.g. `platform_level = 335` → `platform_level = 336`).
  - Update the inline comment date with the current date formatted as `DD-MM-YYYY`:
    ```toml
    platform_level = 336 # channel: development - 09-10-2026 (Toledo)
    ```
- Keep `example_config.toml` synchronized when global configuration structure or release defaults change.

### 3. Application version consistency
- If the global platform version changes, keep `server-toledo/config.toml`, `server-toledo/app.js` (`VERSION`), and `package.json` aligned.

### 4. Active Releases & SemVer Progression
- **NEVER** keep the platform version indefinitely frozen on a static release (such as 10.0.0).
- **ALWAYS** bump the platform version when delivering milestones:
  - **Minor release (10.x.0)**: Whenever completing architecture overhauls (e.g. 100% Zod validation, OpenAPI 3.1 contracts, TypeScript transitions), adding major modules, or shipping cross-platform SDKs.
  - **Patch release (10.x.y)**: For regular production bug fixes, security hardening, or route enhancements.
- Keep VERSION in server-toledo/app.js, server-toledo/package.json, server-toledo/config.toml, example_config.toml, and openapi.json strictly synchronized on every release.
- Prepare release notes and tags systematically instead of accumulating unversioned changes on main.

### 5. Automated GitHub Release Pipeline
- Whenever `package.json` has its `version` bumped and pushed to `main`:
  - GitHub Actions automatically parses the new SemVer version.
  - Automatically creates and pushes the Git tag `vX.Y.Z`.
  - Automatically creates the GitHub Release with generated changelog notes.
  - Automatically attaches `openapi.json` as a release asset for client apps (Swift, C#, Web).
