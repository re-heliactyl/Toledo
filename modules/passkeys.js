const crypto = require('crypto');
const axios = require('axios');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const { validate, schemas } = require('../handlers/validate');
const createAuthz = require('../handlers/authz');
const { getClientIp } = require('../handlers/antiVpnAllowlist');

const HeliactylModule = {
  "name": "Passkeys",
  "version": "1.1.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "contributors": [
    {
      "name": "aachul123",
      "email": "ludo@overnode.fr",
      "url": "https://achul123.pages.dev/"
    }
  ],
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

// Import SimpleWebAuthn
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
// Setup routes for Passkey authentication
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);

  // Constants
  const rpName = 'Heliactyl';
  const rpID = new URL(settings.website.domain).hostname;
  const expectedOrigin = settings.website.domain;

  // Get passkey status
  app.get('/api/passkey/status', authz.requireSession, async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { passkeysEnabled: true }
      });
      const passkeys = await db.passkey.findMany({
        where: { userId },
        select: { id: true, name: true, createdAt: true }
      });

      res.json({
        enabled: user?.passkeysEnabled || false,
        passkeys: passkeys || []
      });
    } catch (error) {
      console.error('Error fetching passkey status:', error);
      res.status(500).json({ error: 'Failed to fetch passkey status' });
    }
  });

  // Initialize passkey registration
  app.post('/api/passkey/registration-options', authz.requireSession, validate(schemas.passkeyRegistration), async (req, res) => {
    try {
      const sessionUser = authz.getSessionUser(req);
      const userId = sessionUser.id;
      const { name } = req.body;

      // Get existing passkeys for this user
      const existingPasskeys = await db.passkey.findMany({
        where: { userId }
      });

      // Create user ID for WebAuthn - must be a Buffer now, not a string
      const userIdBuffer = Buffer.from(`user-${userId}`, 'utf8');

      // Get existing authenticator IDs
      const excludeCredentials = existingPasskeys.map(passkey => ({
        id: passkey.credentialID,
        transports: passkey.transports ? JSON.parse(passkey.transports) : ['internal']
      }));

      // Generate registration options
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: userIdBuffer,
        userName: sessionUser.username,
        userDisplayName: sessionUser.global_name || sessionUser.username,
        excludeCredentials,
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'discouraged'
        },
        supportedAlgorithmIDs: [-7, -257] // ES256 and RS256
      });

      // Store challenge for verification
      req.session.passkeyRegistrationChallenge = {
        challenge: options.challenge,
        name,
        userId // Add userId to the session data to ensure it's available during verification
      };

      res.json(options);
    } catch (error) {
      console.error('Error generating passkey registration options:', error);
      res.status(500).json({ error: 'Failed to generate registration options' });
    }
  });

  // Verify passkey registration
  app.post('/api/passkey/register', authz.requireSession, validate(schemas.passkeyRegister), async (req, res) => {
    try {
      // Verify we have a registration in progress
      if (!req.session.passkeyRegistrationChallenge) {
        return res.status(400).json({ error: 'No passkey registration in progress' });
      }

      const { challenge, name, userId } = req.session.passkeyRegistrationChallenge;

      // Make sure we're using the same userId from the registration process
      const registrationUserId = userId || authz.getSessionUser(req).id;

      // Update verification parameters to match our registration options
      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Passkey registration failed' });
      }

      // Get the important information from the verification (v10+ API)
      const { credential } = verification.registrationInfo;

      // credential.id is already a Base64URLString in v10+
      const credentialIdBase64 = credential.id;
      // credential.publicKey is a Uint8Array
      const credentialKeyBase64 = Buffer.from(credential.publicKey).toString('base64url');

      // Reject if this credential is already registered
      const existing = await db.passkey.findUnique({ where: { credentialID: credentialIdBase64 } });
      if (existing) {
        return res.status(409).json({ error: 'This passkey is already registered' });
      }

      await db.passkey.create({
        data: {
          userId: registrationUserId,
          name: name,
          credentialID: credentialIdBase64,
          credentialPublicKey: credentialKeyBase64,
          counter: credential.counter,
          transports: JSON.stringify(credential.transports || ['internal'])
        }
      });

      // Enable passkeys for user
      await db.user.update({
        where: { id: registrationUserId },
        data: { passkeysEnabled: true }
      });

      // Clean up session
      delete req.session.passkeyRegistrationChallenge;

      await db.notification.create({ data: { userId: registrationUserId, action: "security:passkey", name: `Passkey "${name}" registered` } });

      const passkeys = await db.passkey.findMany({
        where: { userId: registrationUserId },
        select: { id: true, name: true, createdAt: true }
      });

      res.json({
        success: true,
        passkeys
      });
    } catch (error) {
      console.error('Error verifying passkey registration:', error);
      res.status(500).json({ error: 'Failed to verify passkey registration: ' + error.message });
    }
  });

  // Remove a passkey
  app.delete('/api/passkey/:id', authz.requireSession, async (req, res) => {
    try {
      const userId = authz.getSessionUser(req).id;
      const passkeyId = req.params.id;

      const passkey = await db.passkey.findUnique({
        where: { id: passkeyId }
      });

      if (!passkey || passkey.userId !== userId) {
        return res.status(404).json({ error: 'Passkey not found' });
      }

      // Delete the passkey
      await db.passkey.delete({
        where: { id: passkeyId }
      });

      // Check if any passkeys left
      const remainingCount = await db.passkey.count({
        where: { userId }
      });

      if (remainingCount === 0) {
        await db.user.update({
          where: { id: userId },
          data: { passkeysEnabled: false }
        });
      }

      await db.notification.create({ data: { userId, action: "security:passkey", name: `Passkey "${passkey.name}" removed` } });

      const passkeys = await db.passkey.findMany({
        where: { userId },
        select: { id: true, name: true, createdAt: true }
      });

      res.json({
        success: true,
        passkeys
      });
    } catch (error) {
      console.error('Error removing passkey:', error);
      res.status(500).json({ error: 'Failed to remove passkey' });
    }
  });

  // Generate authentication options (for login)
  app.get('/auth/passkey/options', async (req, res) => {
    try {
      // Generate authentication options with relaxed verification requirements
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'discouraged',
        allowCredentials: [] // Allow any passkey (for discoverable credentials)
      });

      // Store challenge for verification
      req.session.passkeyAuthenticationChallenge = options.challenge;

      res.json(options);
    } catch (error) {
      console.error('Error generating passkey authentication options:', error);
      res.status(500).json({ error: 'Failed to generate authentication options' });
    }
  });

  // Verify passkey authentication (for login)
  app.post('/auth/passkey/verify', validate(schemas.passkeyAuthVerify), async (req, res) => {
    try {
      // Verify we have an authentication challenge
      if (!req.session.passkeyAuthenticationChallenge) {
        return res.status(400).json({ error: 'No passkey authentication in progress' });
      }

      // Extract credential ID from base64url
      const credentialIDBuffer = Buffer.from(req.body.rawId, 'base64url');
      const credentialID = credentialIDBuffer.toString('base64url');

      // Search for a passkey with this credentialID
      const passkey = await db.passkey.findUnique({
        where: { credentialID: credentialID },
        include: { user: true }
      });

      if (!passkey || !passkey.user) {
        return res.status(400).json({ error: 'Passkey not found or not registered' });
      }

      const user = passkey.user;

      // Verify the authentication response (v10+ API uses 'credential' not 'authenticator')
      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: req.session.passkeyAuthenticationChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: passkey.credentialID,
          publicKey: Buffer.from(passkey.credentialPublicKey, 'base64url'),
          counter: passkey.counter,
          transports: passkey.transports ? JSON.parse(passkey.transports) : ['internal']
        }
      });

      if (!verification.verified) {
        return res.status(400).json({ error: 'Passkey verification failed' });
      }

      // Update counter
      await db.passkey.update({
        where: { id: passkey.id },
        data: { counter: verification.authenticationInfo.newCounter }
      });

      // Clean up session
      delete req.session.passkeyAuthenticationChallenge;

      // Set session
      req.session.userinfo = {
        id: user.id,
        username: user.username,
        email: user.email,
        global_name: user.username // User model doesn't have global_name, using username
      };
      req.session.sessionIp = getClientIp(req);

      const banRecord = await authz.getFreshSessionUserRecord(req);
      if (authz.isUserBanned(banRecord)) {
        return authz.denyBannedRequest(req, res, banRecord, { forceJson: true });
      }

      // Fetch Pterodactyl data
      const pteroId = user.pterodactylId;
      if (pteroId) {
        try {
          const pteroResponse = await pteroApi.get(`/api/application/users/${pteroId}?include=servers`);
          req.session.pterodactyl = pteroResponse.data.attributes;
        } catch (error) {
          console.error('Error fetching Pterodactyl data:', error);
          // Continue with login even if we can't get Pterodactyl data
        }
      }

      await db.notification.create({ data: { userId: user.id, action: "security:passkey", name: `Logged in using passkey "${passkey.name}"` } });

      res.json({ success: true });
    } catch (error) {
      console.error('Error verifying passkey authentication:', error);
      res.status(500).json({ error: 'Failed to verify passkey authentication: ' + error.message });
    }
  });
};
