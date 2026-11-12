# Heliactyl Next (Toledo) Backend — server-toledo
 
 Node.js, Express, and Prisma backend service for Heliactyl Next (Toledo).
 Provides the core REST API, WebSockets, OpenAPI 3.1 documentation, database models, and Pterodactyl panel proxying.
 
 ## Tech Stack
 
 - **Runtime**: Node.js v18+ (or Bun v1.1.42+)
 - **Framework**: Express 5
 - **Database**: Prisma ORM with SQLite or MySQL/MariaDB dual compatibility
 - **Validation & Contract**: Zod schemas + OpenAPI 3.1 generator
 - **Auth**: Session-based (express-session) + optional Discord OAuth & Passkeys (WebAuthn)
 
 ## Commands
 
 - `[dev]` - `pnpm start`
 - `[prisma push sqlite]` - `npm run prisma:push:sqlite`
 - `[prisma push mysql]` - `npm run prisma:push:mysql`
 - `[validate sqlite]` - `npm run prisma:validate:sqlite`
 - `[validate mysql]` - `npm run prisma:validate:mysql`
 - `[generate openapi]` - `npm run openapi:generate`
 
 ## Rules
 
 The detailed rules live in `.agents/rules/`. Read the relevant file before acting:
 
 - **Backend Architecture** - [.agents/rules/backend-architecture.md](.agents/rules/backend-architecture.md) - Strict TypeScript, zero 'any' policy, Zod validation, and multi-client contract sync
 - **API Contracts** - [.agents/rules/api-contracts.md](.agents/rules/api-contracts.md) - Mandatory Zod validation and continuous OpenAPI 3.1 sync
 - **Database Parity** - [.agents/rules/database-parity.md](.agents/rules/database-parity.md) - Dual SQLite & MySQL schema parity and validation
 - **Dependencies** - [.agents/rules/dependencies.md](.agents/rules/dependencies.md) - Always inspect and install the latest compatible package versions
 - **Versioning & Releases** - [.agents/rules/versioning.md](.agents/rules/versioning.md) - Active release progression (SemVer), file versions, and platform level updates
 - **System Updates** - [.agents/rules/updater.md](.agents/rules/updater.md) - Safe pipeline execution, exclusions, and rollback rules for updates
 - **Module Metadata** - [.agents/rules/module-metadata.md](.agents/rules/module-metadata.md) - Attribute module authorship to aachul123 (or Overnode)
 - **Dead Code** - [.agents/rules/dead-code.md](.agents/rules/dead-code.md) - Delete unused functions and dead code immediately
 - **Language Standards** - [.agents/rules/code-language.md](.agents/rules/code-language.md) - All code, comments, error messages, and rules must be in English
 - **Project Scope** - [.agents/rules/project-scope.md](.agents/rules/project-scope.md) - Universal design: Toledo is for everyone, Overnode is the primary user
 
 ## Universal Rules
 
 - Prefer `pnpm` when available; fall back to `npm` if pnpm is missing or if node_modules was already installed via npm. Never mix lockfiles
 - Never add backend routes without Zod validation and OpenAPI registration
- Never use the any type in TypeScript: always use explicit interfaces, types, or unknown with type narrowing
 - Always keep SQLite and MySQL schemas in strict parity when modifying Prisma models
 - Never expose internal tokens or server version signatures in public response headers
 - All agent rules, AGENTS.md, and code documentation must strictly be written in English
 - Ship active SemVer releases regularly instead of staying indefinitely on a frozen version (e.g. 10.0.0)
 