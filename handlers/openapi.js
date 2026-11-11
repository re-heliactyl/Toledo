const path = require('path');
 const { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } = require('@asteasolutions/zod-to-openapi');
 const { z, schemas } = require('./validate');
 
 // Extend Zod with OpenAPI features
 extendZodWithOpenApi(z);
 
 const registry = new OpenAPIRegistry();
 
 // Register Security Schemes
 registry.registerComponent('securitySchemes', 'sessionAuth', {
   type: 'apiKey',
   in: 'cookie',
   name: 'connect.sid',
   description: 'Session cookie authentication'
 });
 
 registry.registerComponent('securitySchemes', 'apiKeyAuth', {
   type: 'apiKey',
   in: 'header',
   name: 'Authorization',
   description: 'API Bearer Token authentication for API v5'
 });
 
 // Register Component Schemas
 for (const [name, schema] of Object.entries(schemas)) {
   try {
     registry.register(name, schema);
   } catch (e) {
     // Ignore already registered or non-object schemas
   }
 }
 
 // Endpoints Registry Map
 const endpoints = [
   // --- Authentication & 2FA ---
   { method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Authenticate user with credentials', body: schemas.authLogin },
   { method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Register a new user account', body: schemas.authRegister },
   { method: 'post', path: '/auth/reset/request', tag: 'Auth', summary: 'Request password reset token', body: schemas.authResetRequest },
   { method: 'post', path: '/auth/reset', tag: 'Auth', summary: 'Reset password with token', body: schemas.authResetPassword },
   { method: 'get', path: '/auth/magic-login', tag: 'Auth', summary: 'Authenticate with magic link token', query: schemas.magicTokenQuery },
   { method: 'post', path: '/api/user/logout', tag: 'Auth', summary: 'Logout and terminate active session', security: 'sessionAuth' },
   { method: 'delete', path: '/api/user/account', tag: 'Auth', summary: 'Delete user account', security: 'sessionAuth' },
   { method: 'get', path: '/api/2fa/status', tag: '2FA', summary: 'Get current 2FA status', security: 'sessionAuth' },
   { method: 'post', path: '/api/2fa/setup', tag: '2FA', summary: 'Initiate TOTP 2FA setup with QR code', security: 'sessionAuth' },
   { method: 'post', path: '/api/2fa/verify', tag: '2FA', summary: 'Verify TOTP code during setup', body: schemas.twoFactorVerify, security: 'sessionAuth' },
   { method: 'post', path: '/api/2fa/disable', tag: '2FA', summary: 'Disable 2FA authentication', body: schemas.twoFactorDisable, security: 'sessionAuth' },
   { method: 'post', path: '/api/2fa/backup-codes', tag: '2FA', summary: 'Generate backup codes', security: 'sessionAuth' },
   { method: 'post', path: '/auth/2fa/verify', tag: '2FA', summary: 'Verify 2FA token during login flow', body: schemas.auth2FALoginVerify },
   { method: 'get', path: '/api/passkey/status', tag: 'Passkeys', summary: 'Get passkeys status', security: 'sessionAuth' },
   { method: 'get', path: '/auth/passkey/options', tag: 'Passkeys', summary: 'Get WebAuthn passkey challenge options' },
   { method: 'post', path: '/api/passkey/register', tag: 'Passkeys', summary: 'Complete passkey registration', body: schemas.passkeyRegister, security: 'sessionAuth' },
   { method: 'post', path: '/auth/passkey/verify', tag: 'Passkeys', summary: 'Verify WebAuthn passkey login', body: schemas.passkeyAuthVerify },
   { method: 'delete', path: '/api/passkey/{id}', tag: 'Passkeys', summary: 'Delete registered passkey', params: schemas.idParam, security: 'sessionAuth' },
 
   // --- Servers ---
   { method: 'get', path: '/api/servers', tag: 'Servers', summary: 'List user servers', security: 'sessionAuth' },
   { method: 'post', path: '/api/servers/create', tag: 'Servers', summary: 'Create a new game server', body: schemas.serverCreate, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}', tag: 'Servers', summary: 'Get server details', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/power', tag: 'Servers', summary: 'Send power action signal to server', params: schemas.serverIdParam, body: schemas.serverPower, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/command', tag: 'Servers', summary: 'Send command to server console', params: schemas.serverIdParam, body: schemas.serverCommand, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/rename', tag: 'Servers', summary: 'Rename server', params: schemas.serverIdParam, body: schemas.serverRename, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/reinstall', tag: 'Servers', summary: 'Reinstall server OS/files', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/modify', tag: 'Servers', summary: 'Modify allocated server resources', params: schemas.serverIdParam, body: schemas.serverModify, security: 'sessionAuth' },
   { method: 'delete', path: '/api/servers/{idOrIdentifier}', tag: 'Servers', summary: 'Delete game server', params: schemas.stringIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/minecraft-status', tag: 'Servers', summary: 'Check live Minecraft server status', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/logs', tag: 'Servers', summary: 'Get server activity logs', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/websocket', tag: 'Servers', summary: 'Get WebSocket console token', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/renewal/status', tag: 'Renewals', summary: 'Get server renewal countdown status', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/renewal/renew', tag: 'Renewals', summary: 'Renew server for another period', params: schemas.serverIdParam, security: 'sessionAuth' },
 
   // --- Server Files ---
   { method: 'get', path: '/api/server/{id}/files/list', tag: 'Files', summary: 'List files in remote server directory', params: schemas.serverIdParam, query: schemas.directoryQuery, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/files/contents', tag: 'Files', summary: 'Get file content from server', params: schemas.serverIdParam, query: schemas.filePathQuery, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/files/write', tag: 'Files', summary: 'Write or save content to remote file', params: schemas.serverIdParam, body: schemas.fileWrite, security: 'sessionAuth' },
   { method: 'delete', path: '/api/server/{id}/files/delete', tag: 'Files', summary: 'Delete files on remote server', params: schemas.serverIdParam, body: schemas.fileDelete, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/files/compress', tag: 'Files', summary: 'Compress files into archive', params: schemas.serverIdParam, body: schemas.fileCompress, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/files/decompress', tag: 'Files', summary: 'Decompress archive file', params: schemas.serverIdParam, body: schemas.fileDecompress, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/files/create-folder', tag: 'Files', summary: 'Create folder on remote server', params: schemas.serverIdParam, body: schemas.fileCreateFolder, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/files/rename', tag: 'Files', summary: 'Rename or move file on remote server', params: schemas.serverIdParam, body: schemas.fileRename, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/files/copy', tag: 'Files', summary: 'Copy file on remote server', params: schemas.serverIdParam, body: schemas.filesCopy, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/files/download', tag: 'Files', summary: 'Generate download URL for file', params: schemas.serverIdParam, query: schemas.filePathQuery, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/files/upload', tag: 'Files', summary: 'Generate signed file upload URL', params: schemas.serverIdParam, security: 'sessionAuth' },
 
   // --- Network & Allocations ---
   { method: 'get', path: '/api/server/{id}/allocations', tag: 'Network', summary: 'Get assigned server allocations', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/allocations', tag: 'Network', summary: 'Add allocation to server', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'delete', path: '/api/server/{id}/allocations/{allocationId}', tag: 'Network', summary: 'Remove allocation from server', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/allocations/{allocationId}/set-primary', tag: 'Network', summary: 'Set primary allocation', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/allocations/{allocationId}/alias', tag: 'Network', summary: 'Update allocation alias notes', params: schemas.serverIdParam, body: schemas.allocationAlias, security: 'sessionAuth' },
   { method: 'get', path: '/api/subdomains/domains', tag: 'Subdomains', summary: 'List allowed parent domains for subdomains', security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/subdomains', tag: 'Subdomains', summary: 'List subdomains for server', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/subdomains', tag: 'Subdomains', summary: 'Create custom DNS subdomain for server', params: schemas.serverIdParam, body: schemas.subdomainCreate, security: 'sessionAuth' },
   { method: 'delete', path: '/api/server/{id}/subdomains/{subdomainId}', tag: 'Subdomains', summary: 'Delete custom DNS subdomain', params: schemas.subdomainIdParam, security: 'sessionAuth' },
 
   // --- Backups ---
   { method: 'get', path: '/api/server/{id}/backups', tag: 'Backups', summary: 'List server backups', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/server/{id}/backups', tag: 'Backups', summary: 'Create a new backup', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/server/{id}/backups/{backupId}/download', tag: 'Backups', summary: 'Download backup archive', params: schemas.backupDownloadParam, security: 'sessionAuth' },
   { method: 'delete', path: '/api/server/{id}/backups/{backupId}', tag: 'Backups', summary: 'Delete backup archive', params: schemas.backupDownloadParam, security: 'sessionAuth' },
 
   // --- Plugins ---
   { method: 'get', path: '/api/plugins/platforms', tag: 'Plugins', summary: 'List supported plugin platforms (Spigot, Modrinth, Hangar)', security: 'sessionAuth' },
   { method: 'get', path: '/api/plugins/categories', tag: 'Plugins', summary: 'List plugin categories', security: 'sessionAuth' },
   { method: 'get', path: '/api/plugins/list', tag: 'Plugins', summary: 'List popular plugins', query: schemas.pluginSearchQuery, security: 'sessionAuth' },
   { method: 'get', path: '/api/plugins/search', tag: 'Plugins', summary: 'Search plugins with filters', query: schemas.pluginSearchQuery, security: 'sessionAuth' },
   { method: 'get', path: '/api/plugins/details/{pluginId}', tag: 'Plugins', summary: 'Get plugin details and versions', params: schemas.pluginIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/plugins/installed/{serverId}', tag: 'Plugins', summary: 'List tracked installed plugins on server', params: schemas.serverIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/plugins/install/{serverId}', tag: 'Plugins', summary: 'Install plugin on server', params: schemas.serverIdParam, body: schemas.pluginInstall, security: 'sessionAuth' },
   { method: 'post', path: '/api/plugins/untrack/{serverId}', tag: 'Plugins', summary: 'Untrack plugin from server', params: schemas.serverIdParam, body: schemas.pluginUntrack, security: 'sessionAuth' },
 
   // --- Store & Billing ---
   { method: 'get', path: '/api/store/resources', tag: 'Store', summary: 'Get current user resources and costs', security: 'sessionAuth' },
   { method: 'post', path: '/api/store/buy', tag: 'Store', summary: 'Purchase extra server resources with coins', body: schemas.storeBuy, security: 'sessionAuth' },
   { method: 'post', path: '/api/coins/transfer', tag: 'Store', summary: 'Transfer coins to another user', body: schemas.coinTransfer, security: 'sessionAuth' },
   { method: 'post', path: '/api/bundles/create-checkout', tag: 'Billing', summary: 'Create Stripe checkout session for bundle or VIP pack', body: schemas.bundleCheckout, security: 'sessionAuth' },
   { method: 'get', path: '/api/billing/transactions', tag: 'Billing', summary: 'Get billing payment history', security: 'sessionAuth' },
   { method: 'get', path: '/api/billing/invoices', tag: 'Billing', summary: 'List generated PDF invoices', security: 'sessionAuth' },
   { method: 'get', path: '/api/billing/invoices/{transactionId}/download', tag: 'Billing', summary: 'Download invoice PDF', params: schemas.transactionIdParam, security: 'sessionAuth' },
 
   // --- Notifications & Sessions ---
   { method: 'get', path: '/api/v5/notifications', tag: 'Notifications', summary: 'Get user notifications with pagination', query: schemas.pagination, security: 'sessionAuth' },
   { method: 'post', path: '/api/v5/notifications/{id}/read', tag: 'Notifications', summary: 'Mark single notification as read', params: schemas.stringIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/v5/notifications/read-all', tag: 'Notifications', summary: 'Mark all notifications as read', security: 'sessionAuth' },
   { method: 'delete', path: '/api/v5/notifications/{id}', tag: 'Notifications', summary: 'Delete notification', params: schemas.stringIdParam, security: 'sessionAuth' },
   { method: 'get', path: '/api/user/sessions', tag: 'Sessions', summary: 'List active user sessions with IP and location', security: 'sessionAuth' },
   { method: 'delete', path: '/api/user/sessions/{sid}', tag: 'Sessions', summary: 'Revoke and disconnect session by SID', params: schemas.stringIdParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/user/sessions/revoke-others', tag: 'Sessions', summary: 'Disconnect all other sessions', security: 'sessionAuth' },
 
   // --- Support Tickets ---
   { method: 'get', path: '/api/tickets', tag: 'Support', summary: 'List tickets for current user', security: 'sessionAuth' },
   { method: 'post', path: '/api/tickets/create', tag: 'Support', summary: 'Create new support ticket', body: schemas.ticketCreate, security: 'sessionAuth' },
   { method: 'get', path: '/api/tickets/{id}', tag: 'Support', summary: 'Get ticket thread and messages', params: schemas.idParam, security: 'sessionAuth' },
   { method: 'post', path: '/api/tickets/{id}/reply', tag: 'Support', summary: 'Reply to support ticket', params: schemas.idParam, body: schemas.ticketMessage, security: 'sessionAuth' },
   { method: 'post', path: '/api/tickets/{id}/archive', tag: 'Support', summary: 'Archive support ticket', params: schemas.idParam, security: 'sessionAuth' },
 
   // --- External API v5 (Desktop App & Remote Clients) ---
   { method: 'post', path: '/api/v5/user/info', tag: 'API v5', summary: 'Get user profile by ID, username or email', body: schemas.apiV5UserInfo, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/user/coins', tag: 'API v5', summary: 'Add, remove or set coins for user', body: schemas.apiV5UserCoins, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/user/resources', tag: 'API v5', summary: 'Add, remove or set resources for user', body: schemas.apiV5UserResources, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/user/ban', tag: 'API v5', summary: 'Ban user account', body: schemas.apiV5UserBan, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/user/unban', tag: 'API v5', summary: 'Unban user account', body: schemas.apiV5UserUnban, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/server/list', tag: 'API v5', summary: 'List servers owned by user', body: schemas.apiV5ServerList, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/server/info', tag: 'API v5', summary: 'Get detailed server status and resources', body: schemas.apiV5ServerInfo, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/server/control', tag: 'API v5', summary: 'Send power command to server', body: schemas.apiV5ServerControl, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/server/allocation/add', tag: 'API v5', summary: 'Allocate additional IP/port to server', body: schemas.apiV5ServerInfo, security: 'apiKeyAuth' },
   { method: 'post', path: '/api/v5/server/delete', tag: 'API v5', summary: 'Delete server through API', body: schemas.apiV5ServerInfo, security: 'apiKeyAuth' },
   { method: 'get', path: '/api/v5/state', tag: 'API v5', summary: 'Get Toledo platform state and health' },
   { method: 'get', path: '/api/v5/app/latest', tag: 'API v5', summary: 'Get latest desktop app release info' }
 ];
 
 // Register each endpoint with OpenAPI 3.1
 for (const ep of endpoints) {
   const requestDef = {};
 
   if (ep.params) {
     requestDef.params = ep.params;
   }
   if (ep.query) {
     requestDef.query = ep.query;
   }
   if (ep.body) {
     requestDef.body = {
       content: {
         'application/json': {
           schema: ep.body
         }
       }
     };
   }
 
   const securityRequirement = ep.security === 'apiKeyAuth'
     ? [{ apiKeyAuth: [] }]
     : (ep.security === 'sessionAuth' ? [{ sessionAuth: [] }] : undefined);
 
   registry.registerPath({
     method: ep.method,
     path: ep.path,
     summary: ep.summary,
     tags: [ep.tag],
     security: securityRequirement,
     request: Object.keys(requestDef).length > 0 ? requestDef : undefined,
     responses: {
       200: {
         description: 'Successful operation',
         content: {
           'application/json': {
             schema: z.object({ success: z.boolean().optional() }).passthrough()
           }
         }
       },
       400: {
         description: 'Validation failed or bad request'
       },
       401: {
         description: 'Unauthorized - invalid session or missing API token'
       },
       403: {
         description: 'Forbidden - insufficient permissions'
       },
       404: {
         description: 'Resource not found'
       },
       500: {
         description: 'Internal server error'
       }
     }
   });
 }
 
 function generateOpenApiSpec(providedConfig) {
  let settings = providedConfig;
  if (!settings) {
    try {
      const loadConfig = require('./config');
      const configPath = path.resolve(__dirname, '..', 'config.toml');
      settings = loadConfig(configPath) || {};
    } catch (e) {
      settings = {};
    }
  }
  const rawName = settings.website?.name?.trim() || 'Toledo';
  const appName = rawName.toLowerCase() === 'heliactyl' ? 'Heliactyl Next' : (rawName.charAt(0).toUpperCase() + rawName.slice(1));
   const generator = new OpenApiGeneratorV31(registry.definitions);
   return generator.generateDocument({
     openapi: '3.1.0',
     info: {
       title: appName + ' API',
       version: settings.version || '10.1.0',
       description: 'Official API specification for ' + appName + ' (Toledo).',
       contact: {
         name: appName,
         url: settings.website?.domain || ''
       }
     },
     servers: [
       { url: '/', description: 'Current Toledo Server' }
     ]
   });
 }
 
 module.exports = {
   registry,
   generateOpenApiSpec
 };
