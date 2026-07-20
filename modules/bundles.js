const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const log = require("../handlers/log.js");
const createAuthz = require('../handlers/authz');
const axios = require('axios');
const Stripe = require('stripe');

const HeliactylModule = {
  "name": "Bundles",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Bundle subscriptions (Auto Renew, Upgraded Pack, God Pack)",
  "author": { "name": "Overnode", "email": "contact@overnode.fr", "url": "https://overnode.fr" },
  "dependencies": [], "permissions": [], "routes": [], "config": {}, "hooks": [],
  "tags": ['core'], "license": "MIT"
};
module.exports.HeliactylModule = HeliactylModule;

const SUBSCRIPTION_DAYS = settings?.api?.client?.bundles?.subscription_days || 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Pterodactyl API
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${settings.pterodactyl.key}` }
});

let stripeKey = settings?.api?.client?.stripe?.secret_key;
let stripeInstance = new Stripe(stripeKey || 'sk_test_mock_key');
function getStripe() {
  const k = settings?.api?.client?.stripe?.secret_key;
  if (k !== stripeKey) { stripeKey = k; stripeInstance = new Stripe(k || 'sk_test_mock_key'); }
  return stripeInstance;
}

function getBundleConfig() {
  const b = settings?.api?.client?.bundles || {};
  return {
    autoRenewPrice: parseFloat(b.auto_renew_price) || 4.99,
    upgradedPackPrice: parseFloat(b.upgraded_pack_price) || 9.99,
    godPackPrice: parseFloat(b.god_pack_price) || 19.99,
    godPackRoleId: String(b.god_pack_role_id || "000000000000000000"),
    subscriptionDays: parseInt(b.subscription_days, 10) || 30,
    mantleBundleCard: b.mantle_bundle_card !== false
  };
}

const BUNDLE_PRODUCTS = {
  auto_renew: { name: 'Auto Renew', description: 'Automatic server renewal for 30 days' },
  upgraded_pack: { name: 'Upgraded Pack', description: '1.5x AFK coins and resource limits for 30 days' },
  god_pack: { name: 'God Pack', description: 'Everything in Auto Renew + Upgraded Pack + Discord role + priority support' }
};

class BundleError extends Error {
  constructor(msg, code) { super(msg); this.name = 'BundleError'; this.code = code; }
}

class BundleManager {
  constructor(db) {
    this.db = db;
    this.stripePrices = {};
    this.productsInitialized = false;
    this.initializeExpiryChecker();
  }

  async ensureStripeProducts() {
    if (this.productsInitialized) return;
    try {
      const cfg = getBundleConfig();
      const pm = { auto_renew: null, upgraded_pack: null, god_pack: null };
      const existing = await getStripe().products.list({ active: true, limit: 100 });
      for (const [key, info] of Object.entries(BUNDLE_PRODUCTS)) {
        const match = existing.data.find(p => p.name === info.name);
        let pid;
        if (match) { const pr = await getStripe().prices.list({ product: match.id, active: true, limit: 10 }); pid = pr.data[0]?.id; }
        if (!pid) {
          const prod = await getStripe().products.create({ name: info.name, description: info.description });
          const pk = key === 'auto_renew' ? 'autoRenewPrice' : key === 'upgraded_pack' ? 'upgradedPackPrice' : 'godPackPrice';
          const pr = await getStripe().prices.create({ product: prod.id, unit_amount: Math.round(cfg[pk] * 100), currency: 'usd', recurring: { interval: 'month' } });
          pid = pr.id;
        }
        pm[key] = pid;
      }
      this.stripePrices = pm;
      this.productsInitialized = true;
      console.log('[BUNDLES] Stripe products ready');
    } catch (e) { console.error('[BUNDLES] Stripe setup error:', e.message); }
  }

  getPrices() {
    const c = getBundleConfig();
    return { auto_renew: c.autoRenewPrice, upgraded_pack: c.upgradedPackPrice, god_pack: c.godPackPrice };
  }

  async hasActivePack(uid, type) {
    return !!(await this.db.userPack.findFirst({ where: { userId: uid, type, status: 'active', expiresAt: { gt: new Date() } } }));
  }

  async hasAutoRenew(uid) { return this.hasActivePack(uid, 'auto_renew') || this.hasActivePack(uid, 'god_pack'); }
  async hasUpgradedPack(uid) { return this.hasActivePack(uid, 'upgraded_pack') || this.hasActivePack(uid, 'god_pack'); }

  async getUserPacks(uid) {
    return this.db.userPack.findMany({ where: { userId: uid, status: 'active', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
  }

  async getUserPackHistory(uid) {
    return this.db.userPack.findMany({ where: { userId: uid }, orderBy: { createdAt: 'desc' } });
  }

  async activatePack(uid, type, subId = null, custId = null) {
    const cfg = getBundleConfig();
    const prices = this.getPrices();
    const price = prices[type] || 0;
    const exp = new Date(Date.now() + cfg.subscriptionDays * DAY_MS);

    await this.db.$transaction(async (tx) => {
      if (type === 'god_pack') {
        // Only the main god_pack record gets stripeSubscriptionId (unique constraint).
        // Subsidiary entries use null so they don't conflict.
        await tx.userPack.createMany({ data: [
          { userId: uid, type: 'god_pack', status: 'active', expiresAt: exp, stripeSubscriptionId: subId, stripeCustomerId: custId },
          { userId: uid, type: 'auto_renew', status: 'active', expiresAt: exp, stripeSubscriptionId: null, stripeCustomerId: custId },
          { userId: uid, type: 'upgraded_pack', status: 'active', expiresAt: exp, stripeSubscriptionId: null, stripeCustomerId: custId }
        ]});
      } else {
        await tx.userPack.create({ data: { userId: uid, type, status: 'active', expiresAt: exp, stripeSubscriptionId: subId, stripeCustomerId: custId } });
      }

      // Create transaction for wallet activity + invoice
      await tx.transaction.create({
        data: {
          userId: uid,
          type: 'purchase',
          amount: Math.round(price * 100),
          description: `Bundle: ${type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
          details: JSON.stringify({
            bundle_type: type,
            bundle: type,
            price_usd: price,
            payment_method: subId ? 'Stripe Subscription' : 'Wallet Credit',
            item_type: 'subscription',
            quantity: 1,
            unit_price: price,
            subscription_days: cfg.subscriptionDays
          })
        }
      });
    });

    if (type === 'god_pack') { try { await this.assignDiscordRole(uid); } catch {} }
    log('payment_success', `User ${uid} activated ${type} via Stripe`);
    return { type, expiresAt: exp.toISOString() };
  }

  async createCheckoutSession(uid, type, email) {
    const prices = this.getPrices();
    const price = prices[type];
    if (!price) throw new BundleError('Invalid type', 'INVALID_TYPE');
    if (type === 'auto_renew' && await this.hasAutoRenew(uid)) throw new BundleError('Already active', 'ALREADY_ACTIVE');
    if (type === 'upgraded_pack' && await this.hasUpgradedPack(uid)) throw new BundleError('Already active', 'ALREADY_ACTIVE');
    if (type === 'god_pack') {
      if (await this.hasActivePack(uid, 'god_pack')) throw new BundleError('God Pack already active', 'ALREADY_ACTIVE');
      if (await this.hasActivePack(uid, 'auto_renew')) throw new BundleError('Cannot buy God Pack while Auto Renew is active', 'CONFLICT');
      if (await this.hasActivePack(uid, 'upgraded_pack')) throw new BundleError('Cannot buy God Pack while Upgraded Pack is active', 'CONFLICT');
    }

    await this.ensureStripeProducts();
    const priceId = this.stripePrices[type];
    if (!priceId) throw new BundleError('Stripe config error', 'STRIPE_CONFIG_ERROR');

    const user = await this.db.user.findUnique({ where: { id: uid }, select: { creditUsd: true } });
    const hasCredit = (user?.creditUsd || 0) >= price;

    const params = {
      mode: 'subscription', customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId: uid, bundleType: type, usedWalletCredit: hasCredit ? 'true' : 'false' },
      success_url: `${settings.website.domain}/billing/subscription-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${settings.website.domain}/coins/store`
    };

    if (hasCredit) {
      params.subscription_data = { trial_period_days: SUBSCRIPTION_DAYS, metadata: { userId: uid, bundleType: type, walletCreditUsed: 'true' } };
      await this.db.user.update({ where: { id: uid }, data: { creditUsd: { decrement: price } } });
      await this.db.transaction.create({
        data: {
          userId: uid, type: 'purchase', amount: Math.round(price * 100),
          description: `Bundle: ${type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
          details: JSON.stringify({
            bundle_type: type, bundle: type, price_usd: price,
            payment_method: 'Wallet Credit (Stripe Trial)',
            item_type: 'subscription', quantity: 1, unit_price: price,
            subscription_days: SUBSCRIPTION_DAYS
          })
        }
      });
    } else {
      params.subscription_data = { metadata: { userId: uid, bundleType: type, walletCreditUsed: 'false' } };
    }

    const session = await getStripe().checkout.sessions.create(params);
    return { url: session.url, sessionId: session.id };
  }

  async verifyCheckoutSession(sessionId) {
    const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    if (session.mode !== 'subscription') throw new BundleError('Not a subscription', 'INVALID_SESSION');
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') throw new BundleError('Payment not completed', 'PAYMENT_NOT_COMPLETE');
    return this.activatePack(session.metadata.userId, session.metadata.bundleType, session.subscription?.id || null, session.customer?.toString() || null);
  }

  async handleWebhookEvent(event) {
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (!subId) break;

        // Find the user pack linked to this subscription
        const pack = await this.db.userPack.findFirst({
          where: { stripeSubscriptionId: subId, status: 'active' }
        });
        if (!pack) break;

        const c = getBundleConfig();
        const prices = this.getPrices();
        const price = prices[pack.type] || 0;

        // Extend expiration
        await this.db.userPack.updateMany({
          where: { stripeSubscriptionId: subId, status: 'active' },
          data: { expiresAt: new Date(Date.now() + c.subscriptionDays * DAY_MS) }
        });

        // Create wallet transaction for the renewal
        const chargedAmount = invoice.amount_paid ? invoice.amount_paid / 100 : price;
        await this.db.transaction.create({
          data: {
            userId: pack.userId,
            type: 'purchase',
            amount: Math.round(chargedAmount * 100),
            description: `Renewal: ${pack.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`,
            details: JSON.stringify({
              bundle_type: pack.type,
              bundle: pack.type,
              price_usd: chargedAmount,
              payment_method: 'Stripe Subscription',
              item_type: 'subscription_renewal',
              quantity: 1,
              unit_price: chargedAmount,
              stripe_invoice_id: invoice.id,
              renewal: true
            })
          }
        });

        console.log(`[BUNDLES] Renewal invoice ${invoice.id} for ${pack.userId}: $${chargedAmount}`);
        break;
      }
      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const s = event.data.object;
        if (['canceled', 'incomplete_expired', 'unpaid'].includes(s.status)) {
          const pack = await this.db.userPack.findFirst({
            where: { stripeSubscriptionId: s.id, status: 'active' }
          });
          if (pack) {
            await this.cancelSubscriptionPacks(s.id, pack.userId, pack.type === 'god_pack', pack.type === 'upgraded_pack' || pack.type === 'god_pack');
          }
        }
        break;
      }
    }
  }

  async assignDiscordRole(uid) {
    const c = getBundleConfig();
    if (c.godPackRoleId === "000000000000000000") return;
    const u = await this.db.user.findUnique({ where: { id: uid }, select: { discordId: true } });
    if (!u?.discordId) return;
    const bt = settings?.api?.client?.discord?.bot_token, sid = settings?.api?.client?.discord?.server_id;
    if (!bt || !sid) return;
    try { await axios.put(`https://discord.com/api/guilds/${sid}/members/${u.discordId}/roles/${c.godPackRoleId}`, {}, { headers: { Authorization: `Bot ${bt}`, 'Content-Type': 'application/json' } }); } catch (e) { console.error(`[BUNDLES] Failed assign role:`, e.response?.data || e.message); }
  }

  async removeDiscordRole(uid) {
    const c = getBundleConfig();
    if (c.godPackRoleId === "000000000000000000") return;
    const u = await this.db.user.findUnique({ where: { id: uid }, select: { discordId: true } });
    if (!u?.discordId) return;
    const bt = settings?.api?.client?.discord?.bot_token, sid = settings?.api?.client?.discord?.server_id;
    if (!bt || !sid) return;
    try { await axios.delete(`https://discord.com/api/guilds/${sid}/members/${u.discordId}/roles/${c.godPackRoleId}`, { headers: { Authorization: `Bot ${bt}`, 'Content-Type': 'application/json' } }); } catch (e) { if (e.response?.status !== 404) console.error(`[BUNDLES] Failed remove role:`, e.response?.data || e.message); }
  }

  /**
   * Cancel all packs for a user linked to a Stripe subscription.
   * For god_pack, also cleans up subsidiary auto_renew/upgraded_pack entries.
   */
  async cancelSubscriptionPacks(stripeSubscriptionId, userId, isGodPack, hadResourceBoost = false) {
    // Cancel the main pack(s) with this subscription ID
    await this.db.userPack.updateMany({
      where: { stripeSubscriptionId, status: 'active' },
      data: { status: 'cancelled' }
    });

    if (isGodPack) {
      // Also cancel subsidiary entries (auto_renew, upgraded_pack) that have no sub ID
      await this.db.userPack.updateMany({
        where: { userId, status: 'active', type: { in: ['auto_renew', 'upgraded_pack'] }, stripeSubscriptionId: null },
        data: { status: 'cancelled' }
      });
      try { await this.removeDiscordRole(userId); } catch {}
    }

    // Downgrade server resources if user had resource boost (upgraded_pack or god_pack)
    if (hadResourceBoost || isGodPack) {
      try { await this.downgradeUserServerResources(userId); } catch {}
    }

    // Force server renewal re-check for auto-renew capability
    try { await this.forceUserRenewalCheck(userId); } catch {}
  }

  /**
   * When Upgraded Pack / God Pack expires, cap server resources
   * back to the egg's configured maximum limits.
   */
  async downgradeUserServerResources(userId) {
    try {
      const user = await this.db.user.findUnique({
        where: { id: userId },
        select: { pterodactylId: true, packageName: true }
      });
      if (!user?.pterodactylId) return;

      const response = await pteroApi.get(`/api/application/users/${user.pterodactylId}?include=servers`);
      const servers = response.data?.attributes?.relationships?.servers?.data || [];

      for (const server of servers) {
        const attr = server.attributes;
        const limits = attr.limits;
        if (!limits) continue;

        // Get the standard egg maximum from the DB
        const eggConfig = await this.db.eggConfig.findFirst({
          where: { pterodactylEggId: attr.egg }
        });

        let maxRam, maxDisk;

        if (eggConfig?.maximum) {
          try {
            const max = typeof eggConfig.maximum === 'string' ? JSON.parse(eggConfig.maximum) : eggConfig.maximum;
            maxRam = max.ram;
            maxDisk = max.disk;
          } catch {}
        }

        // Fallback: use package limits as the cap
        if (!maxRam && !maxDisk) {
          const pkg = settings?.api?.client?.packages?.list?.[user.packageName || settings?.api?.client?.packages?.default];
          if (pkg) {
            maxRam = pkg.ram || 0;
            maxDisk = pkg.disk || 0;
          }
        }

        // If no reference limit found, skip this server
        if (!maxRam && !maxDisk) continue;

        // Only reduce if current exceeds the standard limit
        const newRam = maxRam && limits.memory > maxRam ? maxRam : limits.memory;
        const newDisk = maxDisk && limits.disk > maxDisk ? maxDisk : limits.disk;
        const newCpu = limits.cpu; // CPU never changes

        if (newRam === limits.memory && newDisk === limits.disk) continue;

        try {
          await pteroApi.patch(`/api/application/servers/${attr.id}/build`, {
            allocation: attr.allocation,
            memory: newRam,
            swap: limits.swap || 0,
            disk: newDisk,
            io: limits.io || 500,
            cpu: newCpu,
            threads: limits.threads || null,
            feature_limits: {
              databases: attr.feature_limits?.databases || 0,
              allocations: attr.feature_limits?.allocations || 0,
              backups: attr.feature_limits?.backups || 0
            }
          });
          console.log(`[BUNDLES] Capped server ${attr.identifier}: RAM ${limits.memory}->${newRam}, Disk ${limits.disk}->${newDisk}`);
        } catch (err) {
          console.error(`[BUNDLES] Failed to cap server ${attr.identifier}:`, err.message);
        }
      }
    } catch (e) {
      console.error('[BUNDLES] Downgrade resources error:', e);
    }
  }

  /**
   * When auto-renew subscription ends, reset server renewal records
   * so the maintenance cycle re-evaluates them immediately.
   */
  async forceUserRenewalCheck(userId) {
    try {
      const prefix = 'server-renewal:';
      const rows = await this.db.heliactyl.findMany({
        where: { key: { startsWith: prefix } }
      });

      for (const row of rows) {
        try {
          const record = JSON.parse(row.value);
          if (record.userId === userId) {
            // Set nextRenewalAt to the past so the maintenance cycle picks it up
            record.nextRenewalAt = new Date(0).toISOString();
            record.updatedAt = new Date().toISOString();
            await this.db.heliactyl.update({
              where: { key: row.key },
              data: { value: JSON.stringify(record) }
            });
          }
        } catch {}
      }
    } catch (e) {
      console.error('[BUNDLES] Force renewal check error:', e);
    }
  }

  async checkExpiredPacks() {
    try {
      const expired = await this.db.userPack.findMany({ where: { status: 'active', expiresAt: { lte: new Date() } } });
      for (const p of expired) {
        const needsDowngrade = p.type === 'upgraded_pack' || p.type === 'god_pack';
        const isAuto = p.type === 'auto_renew' || p.type === 'god_pack';
        const isGod = p.type === 'god_pack';

        if (isGod) {
          try { await this.removeDiscordRole(p.userId); } catch {}
          await this.db.userPack.updateMany({
            where: { userId: p.userId, status: 'active', type: { in: ['auto_renew', 'upgraded_pack'] }, expiresAt: { lte: new Date() } },
            data: { status: 'expired' }
          });
        }

        await this.db.userPack.update({ where: { id: p.id }, data: { status: 'expired' } });

        if (needsDowngrade) { try { await this.downgradeUserServerResources(p.userId); } catch {} }
        if (isAuto) { try { await this.forceUserRenewalCheck(p.userId); } catch {} }
      }
    } catch (e) { console.error('[BUNDLES] Expiry check error:', e); }
  }

  /**
   * Verify with Stripe that all active subscriptions are still valid
   */
  async verifyStripeSubscriptions() {
    try {
      const activePacks = await this.db.userPack.findMany({
        where: { status: 'active', stripeSubscriptionId: { not: null } },
        select: { id: true, userId: true, type: true, stripeSubscriptionId: true }
      });

      // Deduplicate by subscription ID
      const seen = new Set();
      const unique = activePacks.filter(p => {
        if (seen.has(p.stripeSubscriptionId)) return false;
        seen.add(p.stripeSubscriptionId);
        return true;
      });

      for (const pack of unique) {
        try {
          const sub = await getStripe().subscriptions.retrieve(pack.stripeSubscriptionId);
          const status = sub.status;

          if (['canceled', 'incomplete_expired', 'unpaid'].includes(status)) {
            await this.cancelSubscriptionPacks(pack.stripeSubscriptionId, pack.userId, pack.type === 'god_pack', pack.type === 'upgraded_pack' || pack.type === 'god_pack');
            console.log(`[BUNDLES] Stripe verification: sub ${pack.stripeSubscriptionId} (${status})`);
          }
        } catch (err) {
          if (err.response?.status === 404) {
            await this.cancelSubscriptionPacks(pack.stripeSubscriptionId, pack.userId, pack.type === 'god_pack', pack.type === 'upgraded_pack' || pack.type === 'god_pack');
            console.log(`[BUNDLES] Stripe verification: sub ${pack.stripeSubscriptionId} not found (deleted)`);
          } else {
            console.error(`[BUNDLES] Stripe verification error for ${pack.stripeSubscriptionId}:`, err.message);
          }
        }
      }
    } catch (e) { console.error('[BUNDLES] Stripe verification error:', e); }
  }

  initializeExpiryChecker() {
    // Check expired packs every 5 minutes
    setInterval(() => { this.checkExpiredPacks().catch(() => {}); }, 5 * 60 * 1000);
    setTimeout(() => { this.checkExpiredPacks().catch(() => {}); }, 15_000);

    // Verify Stripe subscriptions every 30 minutes
    setInterval(() => { this.verifyStripeSubscriptions().catch(() => {}); }, 30 * 60 * 1000);
    setTimeout(() => { this.verifyStripeSubscriptions().catch(() => {}); }, 60_000);
  }
}

module.exports.load = function (app, db) {
  const mgr = new BundleManager(db);
  const authz = createAuthz(db);
  app.bundleManager = mgr;

  app.get('/api/bundles/status', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const uid = authz.getSessionUser(req).id;
      const active = await mgr.getUserPacks(uid);
      const pk = {};
      for (const p of active) pk[p.type] = { id: p.id, type: p.type, status: p.status, startedAt: p.startedAt.toISOString(), expiresAt: p.expiresAt.toISOString(), daysRemaining: Math.max(0, Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / DAY_MS)) };
      const cfg = getBundleConfig();
      res.json({ prices: mgr.getPrices(), activePacks: pk, hasAutoRenew: !!pk.auto_renew || !!pk.god_pack, hasUpgradedPack: !!pk.upgraded_pack || !!pk.god_pack, hasGodPack: !!pk.god_pack, mantleBundleCard: cfg.mantleBundleCard !== false });
    } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
  });

  app.post('/api/bundles/create-checkout', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const su = authz.getSessionUser(req);
      const { type } = req.body;
      if (!['auto_renew', 'upgraded_pack', 'god_pack'].includes(type)) return res.status(400).json({ error: 'Invalid type', code: 'INVALID_TYPE' });
      const r = await mgr.createCheckoutSession(su.id, type, su.email);
      res.json({ url: r.url, sessionId: r.sessionId });
    } catch (e) {
      if (e.name === 'BundleError') return res.status(400).json({ error: e.message, code: e.code });
      console.error('[BUNDLES] Checkout error:', e);
      res.status(500).json({ error: 'Failed to create checkout' });
    }
  });

  app.get('/api/bundles/verify-checkout', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
      const r = await mgr.verifyCheckoutSession(session_id);
      res.json({ success: true, type: r.type, expiresAt: r.expiresAt });
    } catch (e) {
      if (e.name === 'BundleError') return res.status(400).json({ error: e.message, code: e.code });
      console.error('[BUNDLES] Verify error:', e);
      res.status(500).json({ error: 'Failed to verify checkout' });
    }
  });

  // GET /api/bundles/portal - Stripe Customer Portal for managing subscriptions
  app.get('/api/bundles/portal', async (req, res) => {
    try {
      if (!authz.hasUserSession(req)) return res.status(401).json({ error: 'Unauthorized' });

      const userId = authz.getSessionUser(req).id;
      const activePack = await db.userPack.findFirst({
        where: { userId, status: 'active', stripeCustomerId: { not: null } },
        orderBy: { createdAt: 'desc' }
      });

      if (!activePack?.stripeCustomerId) {
        return res.status(404).json({ error: 'No active subscription found', code: 'NO_SUBSCRIPTION' });
      }

      const session = await getStripe().billingPortal.sessions.create({
        customer: activePack.stripeCustomerId,
        return_url: `${settings.website.domain}/wallet`
      });

      res.json({ url: session.url });
    } catch (error) {
      console.error('[BUNDLES] Portal error:', error);
      res.status(500).json({ error: 'Failed to create portal session' });
    }
  });

  app.post('/api/bundles/stripe-webhook', async (req, res) => {
    try {
      const whSecret = settings?.api?.client?.stripe?.webhook_secret;
      const event = whSecret ? getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], whSecret) : req.body;
      await mgr.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (e) { console.error('[BUNDLES] Webhook error:', e.message); res.status(400).json({ error: e.message }); }
  });
};
