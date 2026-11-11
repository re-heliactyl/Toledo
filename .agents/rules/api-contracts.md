 # API Contracts & OpenAPI Parity
 
 Enforce continuous contract-first synchronization between backend Express routes, Zod schemas, and the OpenAPI 3.1 specification.
 
 ## When this applies
 
 - Creating, modifying, or refactoring HTTP endpoints in `server-toledo/modules/`.
 - Defining or editing request schemas in `server-toledo/handlers/validate.js`.
 - Updating the API contract registry in `server-toledo/handlers/openapi.js`.
 
 ## Rules
 
 - **ALWAYS** validate every route input (request body, route params, or query strings) with explicit Zod schemas using `validate(schema, target)`.
 - **NEVER** write or commit route handlers that access unvalidated `req.body`, `req.params`, or `req.query`.
 - **ALWAYS** register any new or modified endpoint in `server-toledo/handlers/openapi.js` with its path (using `{param}` notation), method, tags, summary, security, and schema mappings.
 - **ALWAYS** execute `npm run openapi:generate` whenever routes or schemas change to keep both `server-toledo/openapi.json` and root `openapi.json` updated.
 - **NEVER** rename or remove existing response keys without backward compatibility aliases, protecting compiled native client apps (Swift on macOS/iOS, C# on Windows).
