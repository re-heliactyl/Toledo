 # Database Parity: SQLite & MySQL
 
 Ensure strict dual-database parity and compatibility between SQLite and MySQL/MariaDB across all Prisma models and queries.
 
 ## When this applies
 
 - Modifying, adding, or deleting Prisma models or fields in `server-toledo/prisma/`.
 - Writing raw database queries, transactions, or aggregations in `server-toledo/`.
 - Running database migrations or schema validations.
 
 ## Rules
 
 - **ALWAYS** maintain 1:1 model, field, relation, and index parity between `server-toledo/prisma/schema.prisma` (SQLite) and `server-toledo/prisma/schema.mysql.prisma` (MySQL).
 - **NEVER** edit one `.prisma` file without applying the identical field definitions and constraints to the other.
 - **NEVER** use database-exclusive types or features (e.g. native MySQL `enum` types, database-specific JSON storage, or dialect-specific SQL functions) that break SQLite compatibility.
 - **ALWAYS** run both validation checks after any schema modification:
   - `npm run prisma:validate:sqlite`
   - `npm run prisma:validate:mysql`
 - **ALWAYS** regenerate both client bindings when updating models:
   - `npm run prisma:generate:sqlite`
   - `npm run prisma:generate:mysql`
 - **NEVER** write raw SQL queries (`$queryRaw`) that depend on dialect-specific syntax. Prefer standard Prisma ORM methods.
