 # Project Scope & Genericity
 
 Toledo (Heliactyl Next) is a universal, public Pterodactyl dashboard for the broader community, not exclusively for Overnode.
 
 ## When this applies
 
 - Designing, developing, or refactoring features in `frontend/` or `server-toledo/`.
 - Writing API endpoints, configuration schemas, default values, and documentation.
 - Managing branding, third-party integrations, and ecosystem clients.
 
 ## Rules
 
 - **ALWAYS** keep all backend logic, frontend components, and API routes generic and fully configurable for any game hosting provider.
 - **ALWAYS** acknowledge that Overnode is the primary user and reference deployment, but not the exclusive audience.
 - **NEVER** hardcode Overnode-specific branding, URLs, business constraints, or external service dependencies without making them optional or configurable via `config.toml` or environment variables.
 - **ALWAYS** allow self-hosters and third-party panel owners to rebrand, customize, or disable optional integrations.
