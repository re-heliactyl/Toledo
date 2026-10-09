const express = require('express');
const axios = require('axios');
const loadConfig = require('../../handlers/config');
const createAuthz = require('../../handlers/authz');
const { ownsServer } = require('./core');
const { recordServerActivity } = require('../../handlers/activityLog');

const settings = loadConfig('./config.toml');

const CF_API_URL = 'https://api.cloudflare.com/client/v4';

const pteroClientApi = axios.create({
    baseURL: settings.pterodactyl.domain,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${settings.pterodactyl.client_key}`
    }
});

const HeliactylModule = {
    name: "Server -> Subdomains",
    version: "1.0.1",
    api_level: 4,
    target_platform: "10.0.0",
    description: "Cloudflare DNS subdomain management for game servers",
    author: {
    name: "aachul123",
    email: "ludo@overnode.fr",
    url: "https://achul123.pages.dev/"
  },
    dependencies: [],
    permissions: [],
    routes: [],
    config: {},
    hooks: [],
    tags: ["core"],
    license: "MIT"
};

module.exports.HeliactylModule = HeliactylModule;

async function createCloudflareRecord(zoneId, recordData) {
    const response = await axios.post(
        `${CF_API_URL}/zones/${zoneId}/dns_records`,
        recordData,
        {
            headers: {
                'Authorization': `Bearer ${settings.cloudflare?.api_token}`,
                'Content-Type': 'application/json'
            }
        }
    );
    return response.data;
}

async function deleteCloudflareRecord(zoneId, recordId) {
    await axios.delete(
        `${CF_API_URL}/zones/${zoneId}/dns_records/${recordId}`,
        {
            headers: {
                'Authorization': `Bearer ${settings.cloudflare?.api_token}`,
                'Content-Type': 'application/json'
            }
        }
    );
}

async function getServerAllocation(serverId) {
    const response = await pteroClientApi.get(`/api/client/servers/${serverId}?include=allocations`);
    const serverData = response.data?.data || response.data;
    const attributes = serverData?.attributes || serverData;
    const relationships = attributes?.relationships || {};
    const allocations = relationships?.allocations?.data || [];

    if (allocations.length === 0) {
        throw new Error('No allocation found for server');
    }

    const allocation = allocations[0];
    const allocAttrs = allocation.attributes || allocation;

    return {
        ip: allocAttrs.ip_alias || allocAttrs.ip,
        port: allocAttrs.port
    };
}

function isValidSubdomainName(name) {
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

module.exports.removeServerSubdomains = async function (db, serverId) {
    const serverIds = Array.isArray(serverId) ? serverId.map(String) : [String(serverId)];
    const subdomains = await db.serverSubdomain.findMany({
        where: { serverId: { in: serverIds } }
    });

    for (const subdomain of subdomains) {
        try {
            await deleteCloudflareRecord(subdomain.zoneId, subdomain.recordId);
        } catch (error) {
            console.error(`Failed to delete Cloudflare record ${subdomain.recordId}:`, error.message);
        }
    }

    await db.serverSubdomain.deleteMany({
        where: { serverId: { in: serverIds } }
    });
};

module.exports.load = async function (app, db) {
    const router = express.Router();
    const authz = createAuthz(db);

    router.get('/subdomains/domains', async (req, res) => {
        try {
            const domains = (settings.cloudflare?.domains || [])
                .filter(d => d.enabled)
                .map(d => ({
                    name: d.name,
                    domain: d.domain,
                    isDefault: d.is_default || false
                }));

            res.json(domains);
        } catch (error) {
            console.error('Error fetching domains:', error);
            res.status(500).json({ error: 'Failed to fetch domains' });
        }
    });

    router.get('/server/:id/subdomains', authz.requirePterodactylSession, ownsServer, async (req, res) => {
        try {
            const subdomains = await db.serverSubdomain.findMany({
                where: { serverId: req.params.id }
            });

            res.json(subdomains);
        } catch (error) {
            console.error('Error fetching subdomains:', error);
            res.status(500).json({ error: 'Failed to fetch subdomains' });
        }
    });

    router.post('/server/:id/subdomains', authz.requirePterodactylSession, ownsServer, async (req, res) => {
        try {
            const sessionUser = authz.getSessionUser(req);
            const serverId = req.params.id;
            const { subdomain, domainName } = req.body;

            if (!subdomain) {
                return res.status(400).json({ error: 'Subdomain name is required' });
            }

            if (!isValidSubdomainName(subdomain)) {
                return res.status(400).json({
                    error: 'Invalid subdomain format. Must be 1-63 characters, lowercase alphanumeric, cannot start or end with hyphen'
                });
            }

            const maxSubdomains = settings.cloudflare?.max_subdomains_per_server || 2;
            const existingCount = await db.serverSubdomain.count({
                where: { serverId }
            });

            if (existingCount >= maxSubdomains) {
                return res.status(400).json({
                    error: `Maximum number of subdomains (${maxSubdomains}) reached for this server`
                });
            }

            const availableDomains = (settings.cloudflare?.domains || []).filter(d => d.enabled);
            let selectedDomain = availableDomains.find(d => d.domain === domainName);

            if (!selectedDomain && domainName) {
                return res.status(400).json({ error: 'Invalid domain specified' });
            }

            if (!selectedDomain) {
                selectedDomain = availableDomains.find(d => d.is_default) || availableDomains[0];
            }

            if (!selectedDomain) {
                return res.status(400).json({ error: 'No available domains configured' });
            }

            const existingSubdomain = await db.serverSubdomain.findFirst({
                where: {
                    name: subdomain,
                    domain: selectedDomain.domain
                }
            });

            if (existingSubdomain) {
                return res.status(400).json({ error: 'This subdomain already exists' });
            }

            const allocation = await getServerAllocation(serverId);

            const zoneId = selectedDomain.zone_id;
            const recordName = `_minecraft._tcp.${subdomain}.${selectedDomain.domain}`;

            const cfRecord = await createCloudflareRecord(zoneId, {
                type: 'SRV',
                name: recordName,
                ttl: 1,
                proxied: false,
                data: {
                    service: '_minecraft',
                    proto: '_tcp',
                    name: subdomain,
                    priority: 0,
                    weight: 5,
                    port: allocation.port,
                    target: allocation.ip
                },
                comment: `Heliactyl - Server ${serverId}`
            });

            if (!cfRecord?.success) {
                return res.status(400).json({
                    error: 'Failed to create DNS record',
                    details: cfRecord?.errors
                });
            }

            const recordId = cfRecord.result?.id;

            const newSubdomain = await db.serverSubdomain.create({
                data: {
                    serverId,
                    userId: sessionUser.id,
                    name: subdomain,
                    domain: selectedDomain.domain,
                    zoneId,
                    recordId
                }
            });

            await recordServerActivity(db, req, serverId, 'subdomain_created', {
                subdomain: `${subdomain}.${selectedDomain.domain}`,
                domain: selectedDomain.domain
            });

            res.status(201).json(newSubdomain);
        } catch (error) {
            console.error('Error creating subdomain:', error);
            if (error.response) {
                return res.status(400).json({
                    error: 'Failed to create subdomain',
                    details: error.response.data
                });
            }
            res.status(500).json({ error: 'Failed to create subdomain' });
        }
    });

    router.delete('/server/:id/subdomains/:subdomainId', authz.requirePterodactylSession, ownsServer, async (req, res) => {
        try {
            const serverId = req.params.id;
            const subdomainId = req.params.subdomainId;

            const subdomain = await db.serverSubdomain.findFirst({
                where: {
                    id: subdomainId,
                    serverId
                }
            });

            if (!subdomain) {
                return res.status(404).json({ error: 'Subdomain not found' });
            }

            try {
                await deleteCloudflareRecord(subdomain.zoneId, subdomain.recordId);
            } catch (cfError) {
                console.error('Failed to delete Cloudflare record:', cfError.message);
            }

            await db.serverSubdomain.delete({
                where: { id: subdomainId }
            });

            await recordServerActivity(db, req, serverId, 'subdomain_deleted', {
                subdomain: `${subdomain.name}.${subdomain.domain}`,
                domain: subdomain.domain
            });

            res.status(204).send();
        } catch (error) {
            console.error('Error deleting subdomain:', error);
            res.status(500).json({ error: 'Failed to delete subdomain' });
        }
    });

    app.use('/api/v5/', router);
};
