# Dead Code & Unused Functions

Functions, methods, and variables that are no longer used or needed must be completely deleted rather than kept as stubs or comments.

## When this applies

- Modifying, refactoring, or deprecating code in `frontend/` and `server-toledo/`.
- Removing features, replacing legacy logic, or eliminating obsolete callbacks and helpers.

## Rules

- **ALWAYS** delete unused functions, methods, parameters, and variables entirely.
- **NEVER** leave empty stub functions, no-ops with explanatory comments, or commented-out code blocks when a function's logic is removed.
- **ALWAYS** remove all call sites, imports, and references across the codebase when deleting a function.
- **NEVER** retain orphaned helper functions whose callers were refactored or deleted.
