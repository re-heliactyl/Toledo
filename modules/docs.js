 /* --------------------------------------------- */
 /* API Documentation (OpenAPI 3.1 / Swagger UI)   */
 /* --------------------------------------------- */
 
 const swaggerUi = require('swagger-ui-express');
const loadConfig = require('../handlers/config');
 const { generateOpenApiSpec } = require('../handlers/openapi');
 
 const HeliactylModule = {
   name: "API Documentation",
   version: "1.0.0",
   api_level: 4,
   target_platform: "10.0.0",
   description: "Interactive OpenAPI 3.1 & Swagger UI documentation",
   author: {
     name: "aachul123",
     email: "ludo@overnode.fr",
     url: "https://achul123.pages.dev/"
   },
   dependencies: [],
   permissions: [],
   routes: [
     { path: "/api/docs", method: "GET" },
     { path: "/api/docs/openapi.json", method: "GET" }
   ],
   config: {},
   hooks: [],
   tags: ["core", "docs", "api"],
   license: "MIT"
 };
 
 module.exports.HeliactylModule = HeliactylModule;
 
 module.exports.load = async function (app, db) {
   let cachedSpec = null;
 
   function getSpec() {
     if (!cachedSpec) {
       cachedSpec = generateOpenApiSpec();
     }
     return cachedSpec;
   }
 
   // Raw OpenAPI 3.1 JSON Specification
   app.get('/api/docs/openapi.json', (req, res) => {
     res.json(getSpec());
   });
 
   // Interactive Swagger UI
   app.use('/api/docs', swaggerUi.serve, (req, res, next) => {
     swaggerUi.setup(getSpec(), {
       customSiteTitle: (function() { try { const cfg = loadConfig('./config.toml'); const rawName = cfg.website?.name?.trim() || 'Toledo';
      const appName = rawName.toLowerCase() === 'heliactyl' ? 'Heliactyl Next' : (rawName.charAt(0).toUpperCase() + rawName.slice(1));
      return appName + ' API Documentation'; } catch (e) { return 'Toledo API Documentation'; } })(),
       customCss: ".swagger-ui .topbar { display: none }",
       swaggerOptions: {
         persistAuthorization: true
       }
     })(req, res, next);
   });
 };
