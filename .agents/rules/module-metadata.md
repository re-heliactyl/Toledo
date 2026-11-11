# Backend Module Metadata & Authorship
 
 When creating or registering modules in `server-toledo/modules/`, standard `HeliactylModule` manifest metadata must dynamically attribute authorship using the active GitHub / Git account.
 
 ## When this applies
 
 - Creating new modules, APIs, or route handlers in `server-toledo/modules/`.
 - Updating module manifests or metadata definitions.
 
 ## Rules
 
 - **ALWAYS** include a complete `HeliactylModule` manifest export with `name`, `version`, `api_level`, `target_platform`, `description`, `author`, and `tags`.
 
 ### 1. For New Modules
 - **ALWAYS check the active GitHub / Git account first** before generating a new manifest:
   - Read `git config user.name` and `git config user.email` (or active GitHub profile).
   - Populate `author.name` with the contributor's GitHub / Git name.
   - Populate `author.email` with their Git email (or `https://github.com/<username>` for `author.url`).
 - **FALL BACK** to the Toledo maintainer (`aachul123` / `ludo@overnode.fr`) only if no local Git/GitHub identity is configured or when authoring official core Toledo modules.
 
 ### 2. For Inherited Modules
 - Keep the original creator `Matt James` as `author`:
   ```javascript
   author: {
     name: "Matt James",
     email: "me@ether.pizza",
     url: "https://ether.pizza"
   }
   ```
 - When modified or extended, append the active contributor's GitHub identity into the `contributors` array:
   ```javascript
   contributors: [
     {
       name: "<git-user-name>",
       email: "<git-user-email>",
       url: "https://github.com/<username>"
     }
   ]
   ```
 