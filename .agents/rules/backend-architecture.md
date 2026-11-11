 # Backend Architecture & Multi-Platform Contracts
 
 Architectural standards for backend development and cross-platform client synchronization (Web, Desktop, Mobile).
 
 ## When this applies
 
 - Modifying, refactoring, or extending backend code in `server-toledo/`.
 - Designing API endpoints, data models, or client-server communication.
 - Integrating cross-platform clients (Web, Windows, macOS, Linux, Android, iOS).
 
 ## Rules
 
 - **ALWAYS** use TypeScript with strict typing (`strict: true`) for all new backend modules and refactored services.
 - **ALWAYS** validate API inputs and outputs with Zod schemas to ensure runtime safety and compile-time contract generation.
 - **ALWAYS** maintain OpenAPI 3.1 specification parity for all public and internal API endpoints so client SDKs can be auto-generated.
 - **NEVER** write untyped route handlers or rely on implicit `any` request bodies.
 - **ALWAYS** centralize client-consumed types and API clients into a shared SDK (`@toledo/sdk` or OpenAPI-generated client) instead of re-implementing API models independently per platform.
 - **NEVER** introduce platform-specific API endpoints unless strictly required by mobile/desktop OS push notifications or native auth requirements.
