/**
 * Zod validation middleware for API endpoints
 * Provides centralized input validation with clear error messages
 * 
 * Usage:
 *   const { validate, schemas } = require('../handlers/validate');
 *   router.post('/endpoint', validate(schemas.storeBuy), handler);
 */

const { z } = require('zod');
const net = require('net');

/**
 * Create validation middleware from Zod schema
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @param {'body'|'query'|'params'} target - Request property to validate
 * @returns {Function} Express middleware
 */
function validate(schema, target = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message,
          code: issue.code
        }))
      });
    }

    // Replace with parsed/coerced data
    req[target] = result.data;
    next();
  };
}

/**
 * Validate multiple targets at once
 * @param {Object} schemas - Object with target keys and schemas
 * @returns {Function} Express middleware
 */
function validateMultiple(schemas) {
  return (req, res, next) => {
    const errors = [];

    for (const [target, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[target]);
      if (!result.success) {
        errors.push(...result.error.issues.map(issue => ({
          target,
          field: issue.path.join('.'),
          message: issue.message,
          code: issue.code
        })));
      } else {
        req[target] = result.data;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    next();
  };
}

// ============================================
// Common Validation Schemas
// ============================================

const schemas = {
  // Store purchases
  storeBuy: z.object({
    resourceType: z.enum(['ram', 'disk', 'cpu', 'servers'], {
      errorMap: () => ({ message: 'Invalid resource type. Must be: ram, disk, cpu, or servers' })
    }),
    amount: z.number({ invalid_type_error: 'Amount must be a number' })
      .int('Amount must be a whole number')
      .min(1, 'Amount must be at least 1')
      .max(100, 'Amount cannot exceed 100')
  }),

  // Coin transfer
  coinTransfer: z.object({
    recipientEmail: z.string({ required_error: 'Recipient is required' })
      .min(1, 'Recipient cannot be empty')
      .trim(),
    amount: z.number({ invalid_type_error: 'Amount must be a number' })
      .int('Amount must be a whole number')
      .min(1, 'Amount must be at least 1')
  }),

  // Ticket creation
  ticketCreate: z.object({
    subject: z.string({ required_error: 'Subject is required' })
      .min(3, 'Subject must be at least 3 characters')
      .max(200, 'Subject cannot exceed 200 characters')
      .trim(),
    description: z.string({ required_error: 'Description is required' })
      .min(10, 'Description must be at least 10 characters')
      .max(5000, 'Description cannot exceed 5000 characters')
      .trim(),
    priority: z.enum(['low', 'medium', 'high', 'urgent'], {
      errorMap: () => ({ message: 'Priority must be: low, medium, high, or urgent' })
    }),
    category: z.enum(['technical', 'billing', 'general', 'abuse'], {
      errorMap: () => ({ message: 'Category must be: technical, billing, general, or abuse' })
    })
  }),

  // Ticket message
  ticketMessage: z.object({
    content: z.string({ required_error: 'Message content is required' })
      .min(1, 'Message cannot be empty')
      .max(10000, 'Message cannot exceed 10000 characters')
      .trim()
  }),

  // Server creation
  serverCreate: z.object({
    name: z.string({ required_error: 'Server name is required' })
      .min(1, 'Server name cannot be empty')
      .max(100, 'Server name cannot exceed 100 characters')
      .regex(/^[a-zA-Z0-9\s\-_]+$/, 'Server name can only contain letters, numbers, spaces, hyphens, and underscores')
      .trim(),
    egg: z.string({ required_error: 'Egg/server type is required' })
      .min(1, 'Egg cannot be empty')
      .trim(),
    nodeId: z.coerce.number({ invalid_type_error: 'Node ID must be a number' })
      .int('Node ID must be a whole number')
      .positive('Node ID must be positive'),
    ram: z.number({ invalid_type_error: 'RAM must be a number' })
      .int('RAM must be a whole number')
      .min(128, 'RAM must be at least 128MB'),
    disk: z.number({ invalid_type_error: 'Disk must be a number' })
      .int('Disk must be a whole number')
      .min(256, 'Disk must be at least 256MB'),
    cpu: z.number({ required_error: 'CPU must be a number' })
      .int('CPU must be a whole number')
      .min(1, 'CPU must be at least 1%')
  }),

  // Server resource modification
  serverModify: z.object({
    ram: z.coerce.number({ invalid_type_error: 'RAM must be a number' })
      .int('RAM must be a whole number')
      .refine(val => val === 0 || val >= 128, 'RAM must be at least 128MB'),
    disk: z.coerce.number({ invalid_type_error: 'Disk must be a number' })
      .int('Disk must be a whole number')
      .refine(val => val === 0 || val >= 256, 'Disk must be at least 256MB'),
    cpu: z.coerce.number({ invalid_type_error: 'CPU must be a number' })
      .int('CPU must be a whole number')
      .refine(val => val === 0 || val >= 1, 'CPU must be at least 1%')
  }),

  // Billing checkout
  billingCheckout: z.object({
    amount_usd: z.number({ invalid_type_error: 'Amount must be a number' })
      .min(1, 'Minimum amount is $1')
      .max(1000, 'Maximum amount is $1000')
  }),

  // User ID parameter
  userIdParam: z.object({
    id: z.string({ required_error: 'User ID is required' })
      .min(1, 'User ID cannot be empty')
  }),

  // Server ID parameter
  serverIdParam: z.object({
    id: z.string({ required_error: 'Server ID is required' })
      .min(1, 'Server ID cannot be empty')
  }),

  // Pagination query
  pagination: z.object({
    page: z.coerce.number()
      .int('Page must be a whole number')
      .min(1, 'Page must be at least 1')
      .default(1),
    perPage: z.coerce.number()
      .int('Items per page must be a whole number')
      .min(1, 'Items per page must be at least 1')
      .max(100, 'Items per page cannot exceed 100')
      .default(20)
  }),

  // Admin user actions
  adminSetCoins: z.object({
    coins: z.number({ invalid_type_error: 'Coins must be a number' })
      .int('Coins must be a whole number')
      .min(0, 'Coins cannot be negative')
      .max(999999999, 'Coins amount too high')
  }),

  adminSetPackage: z.object({
    package: z.string({ required_error: 'Package name is required' })
      .min(1, 'Package name cannot be empty')
  }),

  adminSetResources: z.object({
    ram: z.number({ invalid_type_error: 'RAM must be a number' })
      .int('RAM must be a whole number')
      .min(0, 'RAM cannot be negative')
      .max(999999999, 'RAM amount too high'),
    disk: z.number({ invalid_type_error: 'Disk must be a number' })
      .int('Disk must be a whole number')
      .min(0, 'Disk cannot be negative')
      .max(999999999, 'Disk amount too high'),
    cpu: z.number({ invalid_type_error: 'CPU must be a number' })
      .int('CPU must be a whole number')
      .min(0, 'CPU cannot be negative')
      .max(999999999, 'CPU amount too high'),
    servers: z.number({ invalid_type_error: 'Servers must be a number' })
      .int('Servers must be a whole number')
      .min(0, 'Servers cannot be negative')
      .max(999999999, 'Servers amount too high')
  }),

  // Dashboard config updates
  configName: z.object({
    name: z.string({ required_error: 'Name is required' })
      .min(1, 'Name cannot be empty')
      .max(100, 'Name cannot exceed 100 characters')
      .trim()
  }),

  configLogo: z.object({
    logo: z.string({ required_error: 'Logo URL is required' })
      .min(1, 'Logo URL cannot be empty')
      .max(500, 'Logo URL cannot exceed 500 characters')
      .regex(/^https?:\/\/.+/, 'Logo must be a valid URL starting with http:// or https://')
      .trim()
  }),

  adminAntiVpnAllowlistCreate: z.object({
    ipAddress: z.string({ required_error: 'IP address is required' })
      .trim()
      .refine((value) => net.isIP(value) !== 0, 'IP address must be a valid IPv4 or IPv6 address'),
    reason: z.string({ required_error: 'Reason is required' })
      .min(3, 'Reason must be at least 3 characters')
      .max(1000, 'Reason cannot exceed 1000 characters')
      .trim()
  }),

  configSftpMode: z.object({
    mode: z.enum(['node', 'allocation'], {
      errorMap: () => ({ message: 'SFTP mode must be: node or allocation' })
    })
  }),

  // Egg management (admin)
  eggUpdate: z.object({
    displayName: z.string().min(1).max(100).trim().optional(),
    description: z.string().max(5000).trim().optional(),
    category: z.string().min(1).max(50).trim().optional(),
    minimum: z.object({
      ram: z.number().int().min(0),
      disk: z.number().int().min(0),
      cpu: z.number().int().min(0)
    }).optional(),
    maximum: z.object({
      ram: z.number().int().min(0).nullable(),
      disk: z.number().int().min(0).nullable(),
      cpu: z.number().int().min(0).nullable()
    }).optional().nullable(),
    featureLimits: z.object({
      databases: z.number().int().min(0),
      backups: z.number().int().min(0)
    }).optional(),
    packages: z.array(z.string()).optional(),
    order: z.number().int().optional(),
    dockerImage: z.string().trim().optional(),
    startup: z.string().trim().optional(),
    environment: z.record(z.string()).optional(),
    enabled: z.boolean().optional()
  }),

  eggBatch: z.object({
    ids: z.array(z.string().trim()).min(1, 'At least one egg ID is required'),
    action: z.enum(['enable', 'disable', 'delete'], {
      errorMap: () => ({ message: 'Action must be: enable, disable, or delete' })
    })
  }),

  eggCategory: z.object({
    id: z.string().min(1).max(50).trim(),
    name: z.string().min(1).max(100).trim(),
    icon: z.string().max(50).trim().optional(),
    order: z.number().int().min(0).optional()
  }),

  eggCategoryUpdate: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    icon: z.string().max(50).trim().optional(),
    order: z.number().int().min(0).optional()
  }),

  locationConfigUpdate: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    description: z.string().max(500).trim().optional(),
    enabled: z.boolean().optional(),
    packages: z.array(z.string().trim()).optional(),
    full: z.boolean().optional(),
    flags: z.array(z.string().trim()).optional(),
    order: z.number().int().min(0).optional()
  }),

  nodeConfigUpdate: z.object({
    enabled: z.boolean().optional()
  }),

  // Boost management
  boostApply: z.object({
    serverId: z.string({ required_error: 'Server ID is required' }).min(1),
    boostType: z.enum(['performance', 'cpu', 'memory'], {
      errorMap: () => ({ message: 'Boost type must be: performance, cpu, or memory' })
    }),
    duration: z.enum(['1h', '3h', '6h', '12h', '24h'], {
      errorMap: () => ({ message: 'Duration must be: 1h, 3h, 6h, 12h, or 24h' })
    })
  }),

  boostServer: z.object({
    serverId: z.string({ required_error: 'Server ID is required' }).min(1)
  }),

  boostCancel: z.object({
    serverId: z.string({ required_error: 'Server ID is required' }).min(1),
    boostId: z.string({ required_error: 'Boost ID is required' }).min(1)
  }),

  boostExtend: z.object({
    serverId: z.string({ required_error: 'Server ID is required' }).min(1),
    boostId: z.string({ required_error: 'Boost ID is required' }).min(1),
    additionalDuration: z.enum(['1h', '3h', '6h', '12h', '24h'], {
      errorMap: () => ({ message: 'Duration must be: 1h, 3h, 6h, 12h, or 24h' })
    })
  }),

  boostSchedule: z.object({
    serverId: z.string({ required_error: 'Server ID is required' }).min(1),
    boostType: z.enum(['performance', 'cpu', 'memory'], {
      errorMap: () => ({ message: 'Boost type must be: performance, cpu, or memory' })
    }),
    duration: z.enum(['1h', '3h', '6h', '12h', '24h'], {
      errorMap: () => ({ message: 'Duration must be: 1h, 3h, 6h, 12h, or 24h' })
    }),
    startTime: z.number({ required_error: 'Start time is required' })
      .int('Start time must be a timestamp')
      .min(1, 'Start time must be a valid timestamp')
  }),

  boostCancelScheduled: z.object({
    scheduledBoostId: z.string({ required_error: 'Scheduled boost ID is required' }).min(1)
  }),

  // Authentication
  authRegister: z.object({
    username: z.string({ required_error: 'Username is required' })
      .min(3, 'Username must be at least 3 characters')
      .max(32, 'Username cannot exceed 32 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
      .trim(),
    email: z.string({ required_error: 'Email is required' })
      .email('Invalid email format')
      .max(255, 'Email cannot exceed 255 characters')
      .trim(),
    password: z.string({ required_error: 'Password is required' })
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password cannot exceed 128 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
    firstName: z.string().max(50).trim().optional(),
    lastName: z.string().max(50).trim().optional()
  }),

  authLogin: z.object({
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format').trim(),
    password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
    remember: z.boolean().optional()
  }),

  authResetRequest: z.object({
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format').trim()
  }),

  authResetPassword: z.object({
    token: z.string({ required_error: 'Token is required' }).min(1).trim(),
    password: z.string({ required_error: 'Password is required' })
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password cannot exceed 128 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character')
  }),

  authMagicLink: z.object({
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format').trim()
  }),

  // 2FA
  twoFactorSetup: z.object({
    method: z.enum(['totp', 'sms', 'email'], {
      errorMap: () => ({ message: 'Method must be: totp, sms, or email' })
    })
  }),

  twoFactorDisable: z.object({
    currentPassword: z.string({ required_error: 'Current password is required' }).min(1, 'Current password is required')
  }),

  // Password change (with current password)
  passwordChange: z.object({
    currentPassword: z.string({ required_error: 'Current password is required' }).min(1),
    newPassword: z.string({ required_error: 'New password is required' })
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password cannot exceed 128 characters')
  }),

  // Direct password change (no current password required - uses session)
  passwordChangeDirect: z.object({
    password: z.string({ required_error: 'Password is required' })
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password cannot exceed 128 characters'),
    confirmPassword: z.string({ required_error: 'Password confirmation is required' })
      .min(1, 'Password confirmation is required')
  }).refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  }),

  // Server management
  serverRename: z.object({
    name: z.string({ required_error: 'Server name is required' })
      .min(1, 'Server name cannot be empty')
      .max(100, 'Server name cannot exceed 100 characters')
      .trim()
  }),

  serverPower: z.object({
    signal: z.enum(['start', 'stop', 'restart', 'kill'], {
      errorMap: () => ({ message: 'Signal must be: start, stop, restart, or kill' })
    })
  }),

  serverCommand: z.object({
    command: z.string({ required_error: 'Command is required' })
      .min(1, 'Command cannot be empty')
      .max(1000, 'Command cannot exceed 1000 characters')
      .trim()
  }),

  // File management
  fileDelete: z.object({
    root: z.string().trim().optional(),
    files: z.array(z.string().trim()).min(1, 'At least one file path is required')
  }),

  fileCompress: z.object({
    root: z.string().trim().optional(),
    files: z.array(z.string().trim()).min(1, 'At least one file path is required')
  }),

  fileDecompress: z.object({
    root: z.string().trim().optional(),
    file: z.string({ required_error: 'File path is required' }).min(1).trim()
  }),

  fileWrite: z.object({
    file: z.string({ required_error: 'File path is required' }).min(1).trim(),
    content: z.string({ required_error: 'Content is required' })
  }),

  fileCreateFolder: z.object({
    root: z.string().trim().optional(),
    name: z.string({ required_error: 'Folder name is required' })
      .min(1, 'Folder name cannot be empty')
      .max(255, 'Folder name cannot exceed 255 characters')
      .regex(/^[^/\\]+$/, 'Folder name cannot contain / or \\')
      .trim()
  }),

  // Subuser management
  subuserCreate: z.object({
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format').trim(),
    permissions: z.array(z.string().trim()).min(1, 'At least one permission is required').optional()
  }),

  // Admin user management
  adminCreateUser: z.object({
    username: z.string({ required_error: 'Username is required' })
      .min(3, 'Username must be at least 3 characters')
      .max(32, 'Username cannot exceed 32 characters')
      .trim(),
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format').trim(),
    first_name: z.string().max(50).trim().optional(),
    last_name: z.string().max(50).trim().optional(),
    password: z.string().min(8, 'Password must be at least 8 characters').optional()
  }),

  adminUpdateUser: z.object({
    email: z.string().email('Invalid email format').trim().optional(),
    username: z.string().min(3).max(32).trim().optional(),
    first_name: z.string().max(50).trim().optional(),
    last_name: z.string().max(50).trim().optional(),
    password: z.string().min(8).optional()
  }),

  adminBanUser: z.object({
    reason: z.string({ required_error: 'Ban reason is required' })
      .min(3, 'Ban reason must be at least 3 characters')
      .max(2000, 'Ban reason cannot exceed 2000 characters')
      .trim()
  }),

  // Node management
  nodeCreate: z.object({
    name: z.string({ required_error: 'Node name is required' }).min(1).max(100).trim(),
    fqdn: z.string({ required_error: 'FQDN is required' }).min(1).max(255).trim(),
    port: z.number({ required_error: 'Port is required' }).int().min(1).max(65535),
    webhookUrl: z.string().max(500).trim().optional()
  }),

  nodeUpdate: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    fqdn: z.string().min(1).max(255).trim().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    webhookUrl: z.string().max(500).trim().optional()
  }),

  // 2FA verification
  twoFactorVerify: z.object({
    code: z.string({ required_error: 'Code is required' })
      .length(6, 'Code must be exactly 6 digits')
      .regex(/^\d+$/, 'Code must contain only digits'),
    secret: z.string({ required_error: 'Secret is required' }).min(1, 'Secret cannot be empty')
  }),

  // Bundle purchase
  bundlePurchase: z.object({
    bundle_id: z.enum(['starter', 'network', 'enterprise'], {
      errorMap: () => ({ message: 'Bundle must be: starter, network, or enterprise' })
    })
  }),

  // Subscription bundle purchase (Auto Renew / Upgraded Pack / God Pack)
  bundlePurchaseSub: z.object({
    type: z.enum(['auto_renew', 'upgraded_pack', 'god_pack'], {
      errorMap: () => ({ message: 'Bundle type must be: auto_renew, upgraded_pack, or god_pack' })
    })
  }),

  // Coin package purchase
  purchaseCoins: z.object({
    package_id: z.number({ invalid_type_error: 'Package ID must be a number' })
      .int('Package ID must be a whole number')
  }),

  // Ticket status update
  ticketStatus: z.object({
    status: z.enum(['open', 'closed'], {
      errorMap: () => ({ message: 'Status must be: open or closed' })
    })
  }),

  // Ticket priority update
  ticketPriority: z.object({
    priority: z.enum(['low', 'medium', 'high', 'urgent'], {
      errorMap: () => ({ message: 'Priority must be: low, medium, high, or urgent' })
    })
  }),

  // Staking
  stakingCreate: z.object({
    planId: z.string({ required_error: 'Plan ID is required' }).min(1, 'Plan ID cannot be empty').trim(),
    amount: z.number({ required_error: 'Amount is required', invalid_type_error: 'Amount must be a number' })
      .positive('Amount must be positive')
      .min(0.01, 'Amount must be at least 0.01')
  }),

  // Passkey registration
  passkeyRegistration: z.object({
    name: z.string({ required_error: 'Passkey name is required' })
      .min(1, 'Name cannot be empty')
      .max(100, 'Name cannot exceed 100 characters')
      .trim()
  }),

  // Server startup configuration
  serverStartup: z.object({
    startup: z.string().trim().optional(),
    environment: z.record(z.string()).optional(),
    egg: z.number().int().positive().optional(),
    image: z.string().trim().optional(),
    skip_scripts: z.boolean().optional()
  }),

  // Server variables
  serverVariable: z.object({
    key: z.string({ required_error: 'Variable key is required' }).min(1, 'Key cannot be empty').trim(),
    value: z.string({ required_error: 'Variable value is required' }).trim()
  }),

  // File rename
  fileRename: z.object({
    root: z.string().trim().optional(),
    files: z.array(z.object({
      from: z.string().min(1, 'Source path required').trim(),
      to: z.string().min(1, 'Destination path required').trim()
    })).min(1, 'At least one file to rename is required')
  }),

  // Daily rewards protection
  dailyProtection: z.object({
    level: z.enum(['bronze', 'silver', 'gold'], {
      errorMap: () => ({ message: 'Level must be: bronze, silver, or gold' })
    })
  }),

  // Auth 2FA verify (for login flow)
  auth2FAVerify: z.object({
    token: z.string({ required_error: 'Token is required' })
      .length(6, 'Token must be exactly 6 digits')
      .regex(/^\d+$/, 'Token must contain only digits')
  }),

  // Server allocations
  allocationCreate: z.object({
    ip: z.string({ required_error: 'IP is required' }).ip('Invalid IP address').trim(),
    port: z.number({ required_error: 'Port is required' }).int().min(1).max(65535)
  }),

  // Files copy
  filesCopy: z.object({
    location: z.string({ required_error: 'Location path is required' }).min(1).trim()
  }),

  // Plugin install
  pluginInstall: z.object({
    pluginId: z.string({ required_error: 'Plugin ID is required' }).min(1).trim(),
    platform: z.enum(['spigot', 'modrinth', 'hangar'], {
      errorMap: () => ({ message: 'Platform must be: spigot, modrinth, or hangar' })
    }).optional()
  }),

  // Plugin untrack
  pluginUntrack: z.object({
    pluginId: z.string({ required_error: 'Plugin ID is required' }).min(1).trim(),
    platform: z.string({ required_error: 'Platform is required' }).min(1).trim()
  }),

  // 2FA login verification (accepts TOTP or backup codes)
  auth2FALoginVerify: z.object({
    code: z.string({ required_error: 'Verification code is required' })
      .min(1, 'Code cannot be empty')
      .max(20, 'Code cannot exceed 20 characters')
      .trim()
  }),

  // Passkey registration (WebAuthn response)
  passkeyRegister: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional()
    }),
    type: z.literal('public-key'),
    clientExtensionResults: z.object({}).optional()
  }),

  // Passkey authentication verification (WebAuthn response)
  passkeyAuthVerify: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().optional()
    }),
    type: z.literal('public-key'),
    clientExtensionResults: z.object({}).optional()
  })
};

module.exports = {
  validate,
  validateMultiple,
  schemas,
  z
};
