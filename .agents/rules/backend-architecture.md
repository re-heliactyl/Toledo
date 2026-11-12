# Backend Architecture & Multi-Platform Contracts
 
 Architectural standards for backend development, TypeScript strictness, and cross-platform client synchronization (Web, Desktop, Mobile).
 
 ## When this applies
 
 - Modifying, refactoring, or extending backend code in `server-toledo/`.
 - Writing or editing any TypeScript files (`*.ts`, `*.tsx`).
 - Designing API endpoints, data models, or client-server communication.
 - Integrating cross-platform clients (Web, Windows, macOS, Linux, Android, iOS).
 
 ## Rules
 
 ### 1. Strict Typing & No Any Policy
 - **NEVER use the `any` type under any circumstances (`no-explicit-any`).** Using `any` defeats the entire purpose of migrating to TypeScript, bypasses compiler checks, and breaks client SDK generation for native platforms.
 - **ALWAYS use explicit interfaces, type aliases, or generics.**
 - **FOR UNKNOWN INPUTS:** Use `unknown` combined with type narrowing, type guards, or Zod schema validation instead of `any`.
 - **ALWAYS maintain `tsc --noEmit` with zero type errors.**
 
 ### 2. API Validation & Multi-Platform Contracts
 - **ALWAYS** validate API inputs and outputs with Zod schemas to ensure runtime safety and compile-time contract generation.
 - **ALWAYS** maintain OpenAPI 3.1 specification parity for all public and internal API endpoints so client SDKs can be auto-generated.
 - **NEVER** write untyped route handlers or rely on unvalidated request bodies.
 - **ALWAYS** centralize client-consumed types and API clients into a shared SDK (`@toledo/sdk` or OpenAPI-generated client) instead of re-implementing API models independently per platform.
 - **NEVER** introduce platform-specific API endpoints unless strictly required by mobile/desktop OS push notifications or native auth requirements.
 