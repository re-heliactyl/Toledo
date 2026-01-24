const express = require('express');
const rateLimit = require('express-rate-limit');
const loadConfig = require('../handlers/config');
const settings = loadConfig('./config.toml');
const axios = require('axios');
const getPteroUser = require('../handlers/getPteroUser');
const log = require('../handlers/log');

// Ensure Pterodactyl domain is properly formatted
if (settings.pterodactyl?.domain?.slice(-1) === '/') {
    settings.pterodactyl.domain = settings.pterodactyl.domain.slice(0, -1);
}

// Pterodactyl API helper
const pteroApi = axios.create({
    baseURL: settings.pterodactyl.domain,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${settings.pterodactyl.key}`
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
    const packageName = await db.get(`package-${userId}`);
    const package = settings.api.client.packages.list[packageName || settings.api.client.packages.default];
    const extra = await db.get(`extra-${userId}`) || { ram: 0, disk: 0, cpu: 0, servers: 0 };

    const userServers = await getPteroUser(userId, db);
    if (!userServers) throw new Error('Failed to fetch user servers');

    const usage = userServers.attributes.relationships.servers.data.reduce((acc, server) => ({
        ram: acc.ram + server.attributes.limits.memory,
        disk: acc.disk + server.attributes.limits.disk,
        cpu: acc.cpu + server.attributes.limits.cpu,
        servers: acc.servers + 1
    }), { ram: 0, disk: 0, cpu: 0, servers: 0 });

    return {
        allowed: {
            ram: package.ram + extra.ram,
            disk: package.disk + extra.disk,
            cpu: package.cpu + extra.cpu,
            servers: package.servers + extra.servers
        },
        used: usage,
        remaining: {
            ram: (package.ram + extra.ram) - (usage.ram + additionalResources.ram),
            disk: (package.disk + extra.disk) - (usage.disk + additionalResources.disk),
            cpu: (package.cpu + extra.cpu) - (usage.cpu + additionalResources.cpu),
            servers: (package.servers + extra.servers) - usage.servers
        }
    };
}

// Main module export
module.exports.load = async function (app, db) {
    const router = express.Router();

    // Middleware to check authentication
    router.use((req, res, next) => {
        if (!req.session.pterodactyl) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });

    router.get('/eggs', async (req, res) => {
        try {
            // Get package name for restriction checking
            const packageName = await db.get(`package-${req.session.userinfo.id}`);
            const userPackage = settings.api.client.packages.list[packageName || settings.api.client.packages.default];

            // Filter and format eggs
            const eggs = Object.entries(settings.api.client.eggs).map(([id, egg]) => {
                // Check if egg is restricted to specific packages
                if (egg.package && !egg.package.includes(packageName || settings.api.client.packages.default)) {
                    return null;
                }

                return {
                    id,
                    name: egg.display || id,
                    description: egg.description,
                    minimum: {
                        ram: egg.minimum?.ram || 0,
                        disk: egg.minimum?.disk || 0,
                        cpu: egg.minimum?.cpu || 0
                    },
                    maximum: egg.maximum || null,
                    info: egg.info || {},
                    startup: egg.info?.startup || '',
                    image: egg.info?.image || '',
                    requirements: {
                        ram: Math.max(egg.minimum?.ram || 0, 1),
                        disk: Math.max(egg.minimum?.disk || 0, 1),
                        cpu: Math.max(egg.minimum?.cpu || 0, 1)
                    }
                };
            }).filter(Boolean);

            res.json(eggs);
        } catch (error) {
            console.error('Error fetching eggs:', error);
            res.status(500).json({ error: 'Failed to fetch eggs' });
        }
    });

    // GET /api/locations - List all available locations
    router.get('/locations', async (req, res) => {
        try {
            // Get package name for restriction checking
            const packageName = await db.get(`package-${req.session.userinfo.id}`);
            const userPackage = settings.api.client.packages.list[packageName || settings.api.client.packages.default];

            // Filter and format locations
            const locations = Object.entries(settings.api.client.locations).map(([id, location]) => {
                // Check if location is restricted to specific packages
                if (location.package && !location.package.includes(packageName || settings.api.client.packages.default)) {
                    return null;
                }

                return {
                    id,
                    name: location.name || id,
                    description: location.description,
                    full: location.full || false,
                    flags: location.flags || []
                };
            }).filter(Boolean);

            res.json(locations);
        } catch (error) {
            console.error('Error fetching locations:', error);
            res.status(500).json({ error: 'Failed to fetch locations' });
        }
    });

    // GET /api/resources - Get user's resource usage and limits
    router.get('/resources', async (req, res) => {
        try {
            // Get package information
            const packageName = await db.get(`package-${req.session.userinfo.id}`);
            const package = settings.api.client.packages.list[packageName || settings.api.client.packages.default];

            // Get extra resources
            const extra = await db.get(`extra-${req.session.userinfo.id}`) || {
                ram: 0,
                disk: 0,
                cpu: 0,
                servers: 0
            };

            // Get current resource usage
            const resources = await checkUserResources(req.session.userinfo.id, db);

            // Calculate percentages
            const percentages = {
                ram: (resources.used.ram / (package.ram + extra.ram)) * 100,
                disk: (resources.used.disk / (package.disk + extra.disk)) * 100,
                cpu: (resources.used.cpu / (package.cpu + extra.cpu)) * 100,
                servers: (resources.used.servers / (package.servers + extra.servers)) * 100
            };

            res.json({
                package: {
                    name: packageName || settings.api.client.packages.default,
                    ...package
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
            console.error('Error fetching resources:', error);
            res.status(500).json({ error: 'Failed to fetch resource information' });
        }
    });

    // GET /api/servers - List all servers
    router.get('/servers', async (req, res) => {
        try {
            const user = await getPteroUser(req.session.userinfo.id, db);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json(user.attributes.relationships.servers.data);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch servers' });
        }
    });

    // GET /api/servers/:id - Get specific server
    router.get('/server/:id', async (req, res) => {
        try {
            const user = await getPteroUser(req.session.userinfo.id, db);
            const server = user.attributes.relationships.servers.data.find(
                s => s.attributes.id === req.params.id
            );

            if (!server) {
                return res.status(404).json({ error: 'Server not found' });
            }

            res.json(server);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch server' });
        }
    });

    // POST /api/v5/servers - Create new server
    router.post('/servers', async (req, res) => {
        try {
            if (!req.session.pterodactyl) return res.status(401).json({ error: 'Unauthorized' });

            const { name, egg, location, ram, disk, cpu } = req.body;

            // Validate required fields
            if (!name?.trim()) return res.status(400).json({ error: 'Server name is required' });
            if (!egg) return res.status(400).json({ error: 'Server type is required' });
            if (!location) return res.status(400).json({ error: 'Location is required' });
            if (!ram || !disk || !cpu) return res.status(400).json({ error: 'Resource values are required' });

            // Get user's current resource usage and limits
            const user = await getPteroUser(req.session.userinfo.id, db);
            const packageName = await db.get(`package-${req.session.userinfo.id}`);
            const package = settings.api.client.packages.list[packageName || settings.api.client.packages.default];
            const extra = await db.get(`extra-${req.session.userinfo.id}`) || {
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
            if (usage.servers >= package.servers + extra.servers) {
                return res.status(400).json({ error: 'Server limit reached' });
            }
            if (usage.ram + ram > package.ram + extra.ram) {
                return res.status(400).json({ error: 'Insufficient RAM available' });
            }
            if (usage.disk + disk > package.disk + extra.disk) {
                return res.status(400).json({ error: 'Insufficient disk space available' });
            }
            if (usage.cpu + cpu > package.cpu + extra.cpu) {
                return res.status(400).json({ error: 'Insufficient CPU available' });
            }

            // Get egg configuration
            const eggInfo = settings.api.client.eggs[egg];
            if (!eggInfo) {
                return res.status(400).json({ error: 'Invalid egg specified' });
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

            // Create server specification
            const serverSpec = {
                name: name.trim(),
                user: await db.get(`users-${req.session.userinfo.id}`),
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
                    databases: 4,
                    backups: 4,
                    allocations: 10
                },
                deploy: {
                    locations: [location],
                    dedicated_ip: false,
                    port_range: []
                }
            };

            // Create server on Pterodactyl
            const response = await pteroApi.post('/api/application/servers', serverSpec);

            // Log server creation
            log('server_created',
                `User ${req.session.userinfo.username} created server "${name}" ` +
                `(RAM: ${ram}MB, CPU: ${cpu}%, Disk: ${disk}MB)`
            );

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
    router.patch('/servers/:idOrIdentifier', async (req, res) => {
        try {
            if (!req.session.pterodactyl) return res.status(401).json({ error: 'Unauthorized' });

            const { ram, disk, cpu } = req.body;
            const idOrIdentifier = req.params.idOrIdentifier;

            // Validate input
            if (!ram || !disk || !cpu) {
                return res.status(400).json({ error: 'Missing required resource values' });
            }

            // Get user's current resources and limits
            const user = await getPteroUser(req.session.userinfo.id, db);
            const packageName = await db.get(`package-${req.session.userinfo.id}`);
            const package = settings.api.client.packages.list[packageName || settings.api.client.packages.default];
            const extra = await db.get(`extra-${req.session.userinfo.id}`) || {
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

            // Check resource limits with new values
            if (usage.ram + ram > package.ram + extra.ram) {
                return res.status(400).json({
                    error: `Insufficient RAM. Maximum available is ${package.ram + extra.ram - usage.ram}MB`
                });
            }
            if (usage.disk + disk > package.disk + extra.disk) {
                return res.status(400).json({
                    error: `Insufficient disk space. Maximum available is ${package.disk + extra.disk - usage.disk}MB`
                });
            }
            if (usage.cpu + cpu > package.cpu + extra.cpu) {
                return res.status(400).json({
                    error: `Insufficient CPU. Maximum available is ${package.cpu + extra.cpu - usage.cpu}%`
                });
            }

            // Get egg configuration to check minimums
            let eggInfo = null;
            for (const [_, egg] of Object.entries(settings.api.client.eggs)) {
                if (egg.info.egg === server.attributes.egg) {
                    eggInfo = egg;
                    break;
                }
            }

            if (eggInfo?.minimum) {
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
                `User ${req.session.userinfo.username} modified server "${server.attributes.name}" ` +
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
    router.delete('/servers/:idOrIdentifier', async (req, res) => {
        try {
            if (!req.session.pterodactyl) return res.status(401).json({ error: 'Unauthorized' });

            const idOrIdentifier = req.params.idOrIdentifier;

            // Get user's current resources and servers
            const user = await getPteroUser(req.session.userinfo.id, db);
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
                return res.status(404).json({ error: 'Server not found or not owned by you' });
            }

            // Check if server is suspended
            const serverInfoResponse = await pteroApi.get(`/api/application/servers/${serverId}`);
            const serverData = serverInfoResponse.data;
            if (serverData.attributes.suspended) {
                return res.status(400).json({ error: 'Cannot delete suspended server' });
            }

            // Send delete request to Pterodactyl
            await pteroApi.delete(`/api/application/servers/${serverId}/force`);

            // Log the deletion
            log('server_deleted',
                `User ${req.session.userinfo.username} deleted server "${server.attributes.name}"`
            );

            res.status(204).send();
        } catch (error) {
            if (error.response) {
                return res.status(400).json(error.response.data);
            }
            console.error('Error deleting server:', error);
            res.status(500).json({ error: 'Failed to delete server' });
        }
    });

    // Mount the router
    app.use('/api/v5/', router);
};
