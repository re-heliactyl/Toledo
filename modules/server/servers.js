const express = require('express');
const rateLimit = require('express-rate-limit');
const loadConfig = require('../../handlers/config');
const settings = loadConfig('./config.toml');
const axios = require('axios');
const getPteroUser = require('../../handlers/getPteroUser');
const log = require('../../handlers/log');
const cache = require('../../handlers/cache');
const { validate, schemas } = require('../../handlers/validate');
const createAuthz = require('../../handlers/authz');
const { ownsServer, isServerOwner, checkIsServerOwner, invalidateOwnershipCache } = require('./core');
const { initializeServerRenewal, removeServerRenewal } = require('./renewals.js');
const { removeServerSubdomains } = require('./subdomains.js');
const { applySftpIpMode, getSftpIpMode } = require('../../handlers/sftp');
const { triggerAchievement } = require('../achievements');

// Dynamic eggs helper - will be initialized in load()
let getEggsFromDB = null;
let getLocationsFromDB = null;
let getNodesFromDB = null;
let syncLocationsAndNodes = null;

// Ensure Pterodactyl domain is properly formatted
if (settings.pterodactyl?.domain?.slice(-1) === '/') {
    settings.pterodactyl.domain = settings.pterodactyl.domain.slice(0, -1);
}

// Pterodactyl API helper (Application API)
const pteroApi = axios.create({
    baseURL: settings.pterodactyl.domain,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${settings.pterodactyl.key}`
    }
});

// Pterodactyl Client API helper (for /api/client/ endpoints)
const pteroClientApi = axios.create({
    baseURL: settings.pterodactyl.domain,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${settings.pterodactyl.client_key}`
    }
});

/* --------------------------------------------- */
/* Heliactyl Next Module                                  */
/* --------------------------------------------- */
const HeliactylModule = {
    "name": "Servers",
    "version": "1.0.0",
    "api_level": 4,
    "target_platform": "10.0.0",
    "description": "Core module",
    "author": {
        "name": "Matt James",
        "email": "me@ether.pizza",
        "url": "https://ether.pizza"
    },
    "dependencies": [],
    "permissions": [],
    "routes": [],
    "config": {},
    "hooks": [],
    "tags": ['core'],
    "license": "MIT"
};

module.exports.HeliactylModule = HeliactylModule;

// Rate limiters
const createServerLimiter = rateLimit({
    windowMs: 3000, // 3 seconds
    max: 1,
    message: { error: 'Too many server creation requests. Please wait 3 seconds.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Helper functions
async function checkUserResources(userId, db, additionalResources = { ram: 0, disk: 0, cpu: 0 }) {
    const userRecord = await db.user.findUnique({ where: { id: userId }, select: { packageName: true, extraRam: true, extraDisk: true, extraCpu: true, extraServers: true } });
    const packageName = userRecord?.packageName;
    const packageConfig = settings.api.client.packages.list[packageName || settings.api.client.packages.default];
    const extra = userRecord ? { ram: userRecord.extraRam, disk: userRecord.extraDisk, cpu: userRecord.extraCpu, servers: userRecord.extraServers } : { ram: 0, disk: 0, cpu: 0, servers: 0 };

    // Use cache for Pterodactyl user data (15 seconds TTL)
    const userServers = await cache.getOrSet(
        `ptero:user:${userId}:servers`,
        () => getPteroUser(userId, db),
        15
    );
    if (!userServers) throw new Error('Failed to fetch user servers');

    const usage = userServers.attributes.relationships.servers.data.reduce((acc, server) => ({
        ram: acc.ram + server.attributes.limits.memory,
        disk: acc.disk + server.attributes.limits.disk,
        cpu: acc.cpu + server.attributes.limits.cpu,
        servers: acc.servers + 1
    }), { ram: 0, disk: 0, cpu: 0, servers: 0 });

    return {
        allowed: {
            ram: packageConfig.ram + extra.ram,
            disk: packageConfig.disk + extra.disk,
            cpu: packageConfig.cpu + extra.cpu,
            servers: packageConfig.servers + extra.servers
        },
        used: usage,
        remaining: {
            ram: (packageConfig.ram + extra.ram) - (usage.ram + additionalResources.ram),
            disk: (packageConfig.disk + extra.disk) - (usage.disk + additionalResources.disk),
            cpu: (packageConfig.cpu + extra.cpu) - (usage.cpu + additionalResources.cpu),
            servers: (packageConfig.servers + extra.servers) - usage.servers
        }
    };
}

async function getAvailableNodeAllocation(nodeId) {
    const response = await pteroApi.get(`/api/application/nodes/${nodeId}/allocations`, {
        params: {
            per_page: 10000
        }
    });

    const allocations = Array.isArray(response.data?.data) ? response.data.data : [];
    return allocations.find((allocation) => allocation?.attributes?.assigned === false) || null;
}

// Main module export
module.exports.load = async function (app, db) {
    const router = express.Router();
    const authz = createAuthz(db);

    // Initialize dynamic eggs helper
    try {
        const eggsModule = require('../eggs.js');
        getEggsFromDB = eggsModule.getEggsFromDB;
    } catch (e) {
        console.log('[EGGS] Dynamic eggs module not loaded');
    }

    try {
        const locationsNodesModule = require('../locations-nodes.js');
        getLocationsFromDB = locationsNodesModule.getLocationsFromDB;
        getNodesFromDB = locationsNodesModule.getNodesFromDB;
        syncLocationsAndNodes = locationsNodesModule.syncLocationsAndNodes;
    } catch (e) {
        console.log('[LOCATIONS_NODES] Dynamic locations/nodes module not loaded');
    }

    // Middleware to check authentication
    router.use(authz.requirePterodactylSession);

    router.get('/eggs', async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);
            // Get package name for restriction checking (with cache)
            const userRecord = await db.user.findUnique({ where: { id: sessionUser.id }, select: { packageName: true } });
            const packageName = userRecord?.packageName;
            const userPackage = settings.api.client.packages.list[packageName || settings.api.client.packages.default];

            // Try dynamic eggs from database first
            if (getEggsFromDB) {
                try {
                    const dbEggs = await getEggsFromDB(db);

                    if (dbEggs && Object.keys(dbEggs).length > 0) {
                        // Filter and format eggs from database
                        const eggs = Object.entries(dbEggs)
                            .filter(([_, egg]) => egg.enabled)
                            .filter(([_, egg]) => {
                                // Check package restrictions
                                if (egg.packages && egg.packages.length > 0) {
                                    return egg.packages.includes(packageName || settings.api.client.packages.default);
                                }
                                return true;
                            })
                            .map(([id, egg]) => ({
                                id,
                                name: egg.displayName || egg.originalName,
                                description: egg.description || '',
                                category: egg.category || 'other',
                                minimum: {
                                    ram: egg.minimum?.ram || 0,
                                    disk: egg.minimum?.disk || 0,
                                    cpu: egg.minimum?.cpu || 0
                                },
                                maximum: egg.maximum || null,
                                info: egg.info || {},
                                startup: egg.startup || '',
                                image: egg.dockerImage || '',
                                requirements: {
                                    ram: Math.max(egg.minimum?.ram || 0, 1),
                                    disk: Math.max(egg.minimum?.disk || 0, 1),
                                    cpu: Math.max(egg.minimum?.cpu || 0, 1)
                                }
                            }));

                        return res.json(eggs);
                    }
                } catch (dbError) {
                    console.log('[EGGS] DB eggs fetch failed:', dbError.message);
                }
            }

            res.json([]);
        } catch (error) {
            console.error('Error fetching eggs:', error);
            res.status(500).json({ error: 'Failed to fetch eggs' });
        }
    });

    // GET /api/locations - List all available locations
    router.get('/locations', async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);
            const userRecord = await db.user.findUnique({ where: { id: sessionUser.id }, select: { packageName: true } });
            const packageName = userRecord?.packageName;
            const activePackage = packageName || settings.api.client.packages.default;

            if (!getLocationsFromDB || !getNodesFromDB) {
                return res.json([]);
            }

            let [locations, nodes] = await Promise.all([
                getLocationsFromDB(db),
                getNodesFromDB(db)
            ]);

            if (locations.length === 0 && syncLocationsAndNodes) {
                await syncLocationsAndNodes(db);
                [locations, nodes] = await Promise.all([
                    getLocationsFromDB(db),
                    getNodesFromDB(db)
                ]);
            }

            const enabledNodeLocationIds = new Set(
                nodes
                    .filter((node) => node.enabled)
                    .map((node) => node.locationId?.toString())
            );

            const filteredLocations = locations.filter((location) => {
                if (!location.enabled) {
                    return false;
                }

                if (Array.isArray(location.packages) && location.packages.length > 0) {
                    return location.packages.includes(activePackage) && enabledNodeLocationIds.has(location.id.toString());
                }

                return enabledNodeLocationIds.has(location.id.toString());
            }).map((location) => ({
                id: location.id,
                name: location.name || location.id,
                description: location.description,
                full: location.full || false,
                flags: location.flags || []
            }));

            res.json(filteredLocations);
        } catch (error) {
            console.error('Error fetching locations:', error);
            res.status(500).json({ error: 'Failed to fetch locations' });
        }
    });

    // GET /api/v5/nodes - List all available nodes
    router.get('/nodes', async (req, res) => {
        try {
            if (!getNodesFromDB) {
                return res.json([]);
            }

            let nodes = await getNodesFromDB(db);

            if (nodes.length === 0 && syncLocationsAndNodes) {
                await syncLocationsAndNodes(db);
                nodes = await getNodesFromDB(db);
            }

            nodes = nodes
                .filter((node) => node.enabled)
                .map((node) => ({
                    id: node.id,
                    name: node.name,
                    locationId: node.locationId,
                    fqdn: node.fqdn,
                    memory: node.memory,
                    disk: node.disk,
                    allocated_resources: node.allocated_resources
                }));

            res.json(nodes);
        } catch (error) {
            console.error('Error fetching nodes:', error);
            res.status(500).json({ error: 'Failed to fetch nodes' });
        }
    });

    // GET /api/resources - Get user's resource usage and limits
    router.get('/resources', async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);
            // Get package information (with cache)
            const userRecord = await db.user.findUnique({ where: { id: sessionUser.id }, select: { packageName: true, extraRam: true, extraDisk: true, extraCpu: true, extraServers: true } });
            const packageName = userRecord?.packageName;
            const packageConfig = settings.api.client.packages.list[packageName || settings.api.client.packages.default];

            // Get extra resources (with cache)
            const extra = userRecord ? {
                ram: userRecord.extraRam,
                disk: userRecord.extraDisk,
                cpu: userRecord.extraCpu,
                servers: userRecord.extraServers
            } : {
                ram: 0,
                disk: 0,
                cpu: 0,
                servers: 0
            };
            // Get current resource usage
            const resources = await checkUserResources(sessionUser.id, db);

            // Calculate percentages
            const percentages = {
                ram: (resources.used.ram / (packageConfig.ram + extra.ram)) * 100,
                disk: (resources.used.disk / (packageConfig.disk + extra.disk)) * 100,
                cpu: (resources.used.cpu / (packageConfig.cpu + extra.cpu)) * 100,
                servers: (resources.used.servers / (packageConfig.servers + extra.servers)) * 100
            };

            res.json({
                package: {
                    name: packageName || settings.api.client.packages.default,
                    ...packageConfig
                },
                extra,
                current: {
                    ...resources.used,
                    percentages
                },
                limits: {
                    ...resources.allowed
                },
                remaining: {
                    ...resources.remaining
                }
            });
        } catch (error) {
            if (error.message.includes('not linked')) {
                return res.status(400).json({ error: 'Pterodactyl account not linked' });
            }
            if (error.message.includes('authentication failed')) {
                return res.status(500).json({ error: 'Pterodactyl API authentication failed' });
            }
            res.status(500).json({ error: 'Failed to fetch resource information' });
        }
    });

    // GET /api/servers - List all servers
    router.get('/servers', async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);
            const user = await cache.getOrSet(
                `ptero:user:${sessionUser.id}:servers`,
                () => getPteroUser(sessionUser.id, db),
                15
            );
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json(user.attributes.relationships.servers.data);
        } catch (error) {
            if (error.message.includes('not linked')) {
                return res.status(400).json({ error: 'Pterodactyl account not linked' });
            }
            if (error.message.includes('authentication failed')) {
                return res.status(500).json({ error: 'Pterodactyl API authentication failed' });
            }
            res.status(500).json({ error: 'Failed to fetch servers' });
        }
    });

    // GET /api/v5/server/:id - Get specific server
    
    router.get('/server/:id', ownsServer, async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);
            const pteroUser = authz.getPterodactylUser(req);
            const user = await cache.getOrSet(
                `ptero:user:${sessionUser.id}:servers`,
                () => getPteroUser(sessionUser.id, db),
                300
            );
            const server = user.attributes.relationships.servers.data.find(
                s => s.attributes.id === req.params.id || s.attributes.identifier === req.params.id
            );
            const serverIdentifier = server?.attributes?.identifier || req.params.id;

            // Ownership check via 60s Application API cache (consistent with isServerOwner middleware)
            let isOwner = false;
            try {
                isOwner = await checkIsServerOwner(pteroUser, req.params.id);
            } catch (error) {
                console.error('Error checking server ownership:', error);
            }

            const [serverDetailsResponse, sftpMode] = await Promise.all([
                pteroClientApi.get(`/api/client/servers/${serverIdentifier}`, {
                    params: {
                        include: 'allocations'
                    }
                }),
                getSftpIpMode(db)
            ]);

            const serverDetails = serverDetailsResponse.data;
            const detailedAttributes = serverDetails?.attributes || {};

            res.json({
                ...serverDetails,
                attributes: applySftpIpMode(detailedAttributes, sftpMode),
                meta: {
                    ...(serverDetails.meta || {}),
                    isOwner
                }
            });
        } catch (error) {
            console.error('Error fetching server:', error);
            res.status(500).json({ error: 'Failed to fetch server' });
        }
    });

    // POST /api/v5/servers - Create new server
    router.post('/servers', validate(schemas.serverCreate), async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);

            const { name, egg, nodeId, ram, disk, cpu } = req.body;

            // Get user's current resource usage and limits (fresh, no cache for resource check)
            const user = await getPteroUser(sessionUser.id, db);
            const userRecord = await db.user.findUnique({ where: { id: sessionUser.id }, select: { packageName: true, extraRam: true, extraDisk: true, extraCpu: true, extraServers: true, pterodactylId: true } });
            const packageName = userRecord?.packageName;
            const packageConfig = settings.api.client.packages.list[packageName || settings.api.client.packages.default];
            const extra = userRecord ? {
                ram: userRecord.extraRam,
                disk: userRecord.extraDisk,
                cpu: userRecord.extraCpu,
                servers: userRecord.extraServers
            } : {
                ram: 0,
                disk: 0,
                cpu: 0,
                servers: 0
            };

            // Calculate current usage
            const usage = user.attributes.relationships.servers.data.reduce((acc, server) => ({
                ram: acc.ram + server.attributes.limits.memory,
                disk: acc.disk + server.attributes.limits.disk,
                cpu: acc.cpu + server.attributes.limits.cpu,
                servers: acc.servers + 1
            }), { ram: 0, disk: 0, cpu: 0, servers: 0 });

            // Check resource limits
            if (usage.servers >= packageConfig.servers + extra.servers) {
                return res.status(400).json({ error: 'Server limit reached' });
            }
            if (usage.ram + ram > packageConfig.ram + extra.ram) {
                return res.status(400).json({ error: 'Insufficient RAM available' });
            }
            if (usage.disk + disk > packageConfig.disk + extra.disk) {
                return res.status(400).json({ error: 'Insufficient disk space available' });
            }
            if (usage.cpu + cpu > packageConfig.cpu + extra.cpu) {
                return res.status(400).json({ error: 'Insufficient CPU available' });
            }

            // Get egg configuration - try dynamic DB first, then fallback to config
            let eggInfo = null;
            let pterodactylEggId = null;

            if (getEggsFromDB) {
                try {
                    const dbEggs = await getEggsFromDB(db);
                    if (dbEggs && dbEggs[egg]) {
                        const dbEgg = dbEggs[egg];
                        if (!dbEgg.enabled) {
                            return res.status(400).json({ error: 'This egg is not available' });
                        }
                        eggInfo = {
                            minimum: dbEgg.minimum,
                            maximum: dbEgg.maximum,
                            info: {
                                egg: dbEgg.pterodactylEggId,
                                docker_image: dbEgg.dockerImage,
                                startup: dbEgg.startup,
                                environment: dbEgg.environment || {},
                                feature_limits: dbEgg.featureLimits || { databases: 0, backups: 0 }
                            }
                        };
                        pterodactylEggId = dbEgg.pterodactylEggId;
                    }
                } catch (dbError) {
                    console.log('[EGGS] DB egg fetch failed:', dbError.message);
                }
            }

            if (!eggInfo) {
                return res.status(400).json({ error: 'Invalid egg specified' });
            }

            let availableAllocationId = null;

            if (getLocationsFromDB && getNodesFromDB) {
                let [locations, nodes] = await Promise.all([
                    getLocationsFromDB(db),
                    getNodesFromDB(db)
                ]);

                if (locations.length === 0 && syncLocationsAndNodes) {
                    await syncLocationsAndNodes(db);
                    [locations, nodes] = await Promise.all([
                        getLocationsFromDB(db),
                        getNodesFromDB(db)
                    ]);
                }

                const selectedNode = nodes.find((entry) => entry.id.toString() === nodeId.toString());

                if (!selectedNode || !selectedNode.enabled) {
                    return res.status(400).json({ error: 'This node is not available' });
                }

                const selectedLocation = locations.find((entry) => entry.id.toString() === selectedNode.locationId?.toString());

                if (!selectedLocation || !selectedLocation.enabled) {
                    return res.status(400).json({ error: 'This node location is not available' });
                }

                if (Array.isArray(selectedLocation.packages) && selectedLocation.packages.length > 0) {
                    const activePackage = packageName || settings.api.client.packages.default;
                    if (!selectedLocation.packages.includes(activePackage)) {
                        return res.status(400).json({ error: 'This node is not available for your package' });
                    }
                }

                const availableAllocation = await getAvailableNodeAllocation(selectedNode.pterodactylNodeId || Number(selectedNode.id));

                if (!availableAllocation) {
                    return res.status(400).json({ error: 'No allocation is available on this node' });
                }

                availableAllocationId = availableAllocation.attributes.id;
            }

            // Validate against egg minimums
            if (eggInfo.minimum) {
                if (ram < eggInfo.minimum.ram) {
                    return res.status(400).json({ error: `Minimum RAM required is ${eggInfo.minimum.ram}MB` });
                }
                if (disk < eggInfo.minimum.disk) {
                    return res.status(400).json({ error: `Minimum disk required is ${eggInfo.minimum.disk}MB` });
                }
                if (cpu < eggInfo.minimum.cpu) {
                    return res.status(400).json({ error: `Minimum CPU required is ${eggInfo.minimum.cpu}%` });
                }
            }

            // Validate against egg maximums
            if (eggInfo.maximum) {
                if (eggInfo.maximum.ram && ram > eggInfo.maximum.ram) {
                    return res.status(400).json({ error: `Maximum RAM allowed is ${eggInfo.maximum.ram}MB` });
                }
                if (eggInfo.maximum.disk && disk > eggInfo.maximum.disk) {
                    return res.status(400).json({ error: `Maximum disk allowed is ${eggInfo.maximum.disk}MB` });
                }
                if (eggInfo.maximum.cpu && cpu > eggInfo.maximum.cpu) {
                    return res.status(400).json({ error: `Maximum CPU allowed is ${eggInfo.maximum.cpu}%` });
                }
            }

            // Create server specification
            const serverSpec = {
                name: name,
                user: userRecord?.pterodactylId,
                egg: eggInfo.info.egg,
                docker_image: eggInfo.info.docker_image,
                startup: eggInfo.info.startup,
                environment: eggInfo.info.environment,
                limits: {
                    memory: ram,
                    swap: -1,
                    disk: disk,
                    io: 500,
                    cpu: cpu
                },
                feature_limits: {
                    databases: eggInfo.info.feature_limits.databases || 0,
                    backups: eggInfo.info.feature_limits.backups || 0,
                    allocations: eggInfo.info.feature_limits.allocations || 0
                },
                allocation: {
                    default: availableAllocationId
                }
            };

            // Create server on Pterodactyl
            const response = await pteroApi.post('/api/application/servers', serverSpec);

            try {
                await initializeServerRenewal(
                    db,
                    response.data.attributes,
                    sessionUser.id
                );
            } catch (renewalError) {
                console.error('Failed to initialize server renewal:', renewalError);
            }

            // Log server creation
            log('server_created',
                `User ${sessionUser.username} created server "${name}" ` +
                `(RAM: ${ram}MB, CPU: ${cpu}%, Disk: ${disk}MB)`
            );

            // Trigger achievement
            try {
                await triggerAchievement(db, sessionUser.id, 'create_server');
            } catch (achError) {
                console.error('Failed to trigger achievement:', achError);
            }

            // Update user servers cache with the new server details to prevent reload race conditions
            try {
                const cachedUser = await cache.get(`ptero:user:${sessionUser.id}:servers`);
                if (cachedUser && cachedUser.attributes?.relationships?.servers?.data) {
                    cachedUser.attributes.relationships.servers.data.push(response.data);
                    await cache.set(`ptero:user:${sessionUser.id}:servers`, cachedUser, 15);
                } else {
                    await cache.del(`ptero:user:${sessionUser.id}:servers`);
                }
            } catch (cacheError) {
                await cache.del(`ptero:user:${sessionUser.id}:servers`);
            }

            // Invalidate ownership cache
            invalidateOwnershipCache(sessionUser.id);

            res.status(201).json(response.data);
        } catch (error) {
            if (error.response) {
                console.error('Pterodactyl API Error:', error.response.data);
                return res.status(400).json(error.response.data);
            }
            console.error('Error creating server:', error);
            res.status(500).json({ error: 'Failed to create server' });
        }
    });

    // PATCH /api/v5/servers/:idOrIdentifier - Modify server
    router.patch('/servers/:idOrIdentifier', validate(schemas.serverModify), async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);

            const { ram, disk, cpu } = req.body;
            const idOrIdentifier = req.params.idOrIdentifier;

            // Get user's current resources and limits (fresh, no cache for resource check)
            const user = await getPteroUser(sessionUser.id, db);
            const userRecord = await db.user.findUnique({ where: { id: sessionUser.id }, select: { packageName: true, extraRam: true, extraDisk: true, extraCpu: true, extraServers: true } });
            const packageName = userRecord?.packageName;
            const packageConfig = settings.api.client.packages.list[packageName || settings.api.client.packages.default];
            const extra = userRecord ? {
                ram: userRecord.extraRam,
                disk: userRecord.extraDisk,
                cpu: userRecord.extraCpu,
                servers: userRecord.extraServers
            } : {
                ram: 0,
                disk: 0,
                cpu: 0,
                servers: 0
            };

            // Find server by ID or identifier
            let server;
            let serverId;

            // Try to find the server in user's servers
            server = user.attributes.relationships.servers.data.find(
                s => s.attributes.id.toString() === idOrIdentifier || s.attributes.identifier === idOrIdentifier
            );

            // If not found, fetch server list from Pterodactyl API to find by identifier
            if (!server && !/^\d+$/.test(idOrIdentifier)) {
                // Fetch servers from Pterodactyl API
                const response = await pteroApi.get('/api/application/servers?per_page=100000');
                const allServers = response.data;

                // Find server with matching identifier
                const matchingServer = allServers.data.find(s => s.attributes.identifier === idOrIdentifier);

                if (matchingServer) {
                    // Check if this server belongs to the user
                    server = user.attributes.relationships.servers.data.find(
                        s => s.attributes.id.toString() === matchingServer.attributes.id.toString()
                    );

                    if (server) {
                        serverId = matchingServer.attributes.id;
                    }
                }
            } else if (server) {
                serverId = server.attributes.id;
            }

            if (!server || !serverId) {
                return res.status(404).json({ error: 'Server not found or not owned by you' });
            }

            // Calculate current usage excluding the server being modified
            const usage = user.attributes.relationships.servers.data.reduce((acc, s) => {
                if (s.attributes.id.toString() !== serverId.toString()) {
                    return {
                        ram: acc.ram + s.attributes.limits.memory,
                        disk: acc.disk + s.attributes.limits.disk,
                        cpu: acc.cpu + s.attributes.limits.cpu
                    };
                }
                return acc;
            }, { ram: 0, disk: 0, cpu: 0 });

            // Prevent setting resources to 0 (unlimited) if they weren't already 0 (unlimited)
            if (ram === 0 && server.attributes.limits.memory !== 0) {
                return res.status(400).json({ error: 'RAM cannot be set to 0 (unlimited)' });
            }
            if (disk === 0 && server.attributes.limits.disk !== 0) {
                return res.status(400).json({ error: 'Disk space cannot be set to 0 (unlimited)' });
            }
            if (cpu === 0 && server.attributes.limits.cpu !== 0) {
                return res.status(400).json({ error: 'CPU limit cannot be set to 0 (unlimited)' });
            }

            // Check resource limits with new values
            if (usage.ram + ram > packageConfig.ram + extra.ram) {
                return res.status(400).json({
                    error: `Insufficient RAM. Maximum available is ${packageConfig.ram + extra.ram - usage.ram}MB`
                });
            }
            if (usage.disk + disk > packageConfig.disk + extra.disk) {
                return res.status(400).json({
                    error: `Insufficient disk space. Maximum available is ${packageConfig.disk + extra.disk - usage.disk}MB`
                });
            }
            if (usage.cpu + cpu > packageConfig.cpu + extra.cpu) {
                return res.status(400).json({
                    error: `Insufficient CPU. Maximum available is ${packageConfig.cpu + extra.cpu - usage.cpu}%`
                });
            }

            // Get egg configuration to check minimums - try dynamic DB first
            let eggInfo = null;

            if (getEggsFromDB) {
                try {
                    const dbEggs = await getEggsFromDB(db);
                    if (dbEggs) {
                        for (const [_, dbEgg] of Object.entries(dbEggs)) {
                            if (dbEgg.pterodactylEggId === server.attributes.egg) {
                                eggInfo = { minimum: dbEgg.minimum, maximum: dbEgg.maximum };
                                break;
                            }
                        }
                    }
                } catch (dbError) {
                    console.log('[EGGS] DB egg lookup failed:', dbError.message);
                }
            }

            if (eggInfo?.minimum) {
                if (ram > 0 && ram < eggInfo.minimum.ram) {
                    return res.status(400).json({ error: `Minimum RAM required is ${eggInfo.minimum.ram}MB` });
                }
                if (disk > 0 && disk < eggInfo.minimum.disk) {
                    return res.status(400).json({ error: `Minimum disk required is ${eggInfo.minimum.disk}MB` });
                }
                if (cpu > 0 && cpu < eggInfo.minimum.cpu) {
                    return res.status(400).json({ error: `Minimum CPU required is ${eggInfo.minimum.cpu}%` });
                }
            }

            // Validate against egg maximums
            if (eggInfo?.maximum) {
                if (eggInfo.maximum.ram && ram > eggInfo.maximum.ram) {
                    return res.status(400).json({ error: `Maximum RAM allowed is ${eggInfo.maximum.ram}MB` });
                }
                if (eggInfo.maximum.disk && disk > eggInfo.maximum.disk) {
                    return res.status(400).json({ error: `Maximum disk allowed is ${eggInfo.maximum.disk}MB` });
                }
                if (eggInfo.maximum.cpu && cpu > eggInfo.maximum.cpu) {
                    return res.status(400).json({ error: `Maximum CPU allowed is ${eggInfo.maximum.cpu}%` });
                }
            }

            // Send update request to Pterodactyl
            const patchResponse = await pteroApi.patch(`/api/application/servers/${serverId}/build`, {
                allocation: server.attributes.allocation,
                memory: ram,
                swap: server.attributes.limits.swap,
                disk: disk,
                io: server.attributes.limits.io,
                cpu: cpu,
                feature_limits: server.attributes.feature_limits
            });

            // Log the modification
            log('server_modified',
                `User ${sessionUser.username} modified server "${server.attributes.name}" ` +
                `(RAM: ${ram}MB, CPU: ${cpu}%, Disk: ${disk}MB)`
            );

            res.json(patchResponse.data);
        } catch (error) {
            if (error.response) {
                return res.status(400).json(error.response.data);
            }
            console.error('Error modifying server:', error);
            res.status(500).json({ error: 'Failed to modify server' });
        }
    });

    // DELETE /api/v5/servers/:idOrIdentifier - Delete server
    router.delete('/servers/:idOrIdentifier', isServerOwner, async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);

            const idOrIdentifier = req.params.idOrIdentifier;

            // Get user's current resources and servers (fresh)
            const user = await getPteroUser(sessionUser.id, db);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Find server by ID or identifier
            let server;
            let serverId;

            // Try to find the server in user's servers
            server = user.attributes.relationships.servers.data.find(
                s => s.attributes.id.toString() === idOrIdentifier || s.attributes.identifier === idOrIdentifier
            );

            // If not found by user's servers and it's not a numeric ID, fetch all servers to find by identifier
            if (!server && !/^\d+$/.test(idOrIdentifier)) {
                // Fetch servers from Pterodactyl API
                const response = await pteroApi.get('/api/application/servers?per_page=100000');
                const allServers = response.data;

                // Find server with matching identifier
                const matchingServer = allServers.data.find(s => s.attributes.identifier === idOrIdentifier);

                if (matchingServer) {
                    // Check if this server belongs to the user
                    server = user.attributes.relationships.servers.data.find(
                        s => s.attributes.id.toString() === matchingServer.attributes.id.toString()
                    );

                    if (server) {
                        serverId = matchingServer.attributes.id;
                    }
                }
            } else if (server) {
                serverId = server.attributes.id;
            }

            if (!server || !serverId) {
                return res.status(404).json({ error: 'Server not found' });
            }

            // Check if server is suspended
            const serverInfoResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
            const serverData = serverInfoResponse.data;
            if (serverData.attributes.suspended) {
                return res.status(400).json({ error: 'Cannot delete suspended server' });
            }

            // Send delete request to Pterodactyl
            await pteroApi.delete(`/api/application/servers/${serverId}/force`);

            try {
                await removeServerSubdomains(db, server.attributes.identifier);
            } catch (subdomainError) {
                console.error('Failed to remove server subdomains:', subdomainError);
            }

            try {
                await removeServerRenewal(db, {
                    identifier: server.attributes.identifier,
                    panelId: serverId
                });
            } catch (renewalError) {
                console.error('Failed to remove server renewal:', renewalError);
            }

            try {
                await db.subuserServer.deleteMany({
                    where: { serverId: server.attributes.identifier }
                });
            } catch (subuserError) {
                console.error('Failed to remove server subusers:', subuserError);
            }

            // Log the deletion
            log('server_deleted',
                `User ${sessionUser.username} deleted server "${server.attributes.name}"`
            );

            // Invalidate user servers caches
            await cache.del(`ptero:user:${sessionUser.id}:servers`);
            invalidateOwnershipCache(sessionUser.id);

            res.status(204).send();
        } catch (error) {
            if (error.response) {
                return res.status(400).json(error.response.data);
            }
            console.error('Error deleting server:', error);
            res.status(500).json({ error: 'Failed to delete server' });
        }
    });

    // Proxy endpoint for Minecraft server status API (avoids CORS issues)
    router.get('/server/:id/minecraft-status', async (req, res) => {
        try {
            const serverId = req.params.id;
            const sessionUser = authz.getSessionUser(req);

            // Verify user owns this server (with cache)
            const user = await cache.getOrSet(
                `ptero:user:${sessionUser.id}:servers`,
                () => getPteroUser(sessionUser.id, db),
                300
            );
            const server = user.attributes.relationships.servers.data.find(
                s => s.attributes.id === serverId || s.attributes.identifier === serverId
            );

            if (!server) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Get server info from Pterodactyl using Client API
            const serverResponse = await pteroClientApi.get(`/api/client/servers/${serverId}`);

            // Handle different possible response structures
            const serverData = serverResponse.data?.data || serverResponse.data;
            const attributes = serverData?.attributes || serverData;
            const relationships = attributes?.relationships || {};
            const allocations = relationships?.allocations?.data || [];

            const allocation = allocations[0];
            if (!allocation) {
                return res.status(404).json({ error: 'No allocation found for server' });
            }

            const allocAttrs = allocation.attributes || allocation;
            const ip = allocAttrs.ip_alias || allocAttrs.ip;
            const port = allocAttrs.port;

            // Query mcsrvstat.us API from server-side (no CORS issues)
            const statusResponse = await axios.get(`https://api.mcsrvstat.us/3/${ip}:${port}`, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Heliactyl/10.0.0'
                }
            });

            res.json(statusResponse.data);
        } catch (error) {
            console.error('Error fetching Minecraft status:', error.message);
            res.status(500).json({
                error: 'Failed to fetch Minecraft server status',
                online: false
            });
        }
    });

    // Mount the router
    app.use('/api/v5/', router);
};
