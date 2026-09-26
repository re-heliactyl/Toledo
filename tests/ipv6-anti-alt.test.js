const assert = require('assert');
const {
  normalizeIp,
  expandIpv6,
  isSpecialIpv6,
  getIpv6Subnet64,
  areIpsEquivalent,
  getClientIp,
  isUserAllowlisted
} = require('../handlers/antiVpnAllowlist');
const createIpCheck = require('../handlers/ipCheck');

console.log('--- 1. Testing normalizeIp ---');
assert.strictEqual(normalizeIp('192.168.1.1'), '192.168.1.1');
assert.strictEqual(normalizeIp('192.168.1.1:8080'), '192.168.1.1');
assert.strictEqual(normalizeIp('::ffff:192.168.1.1'), '192.168.1.1');
assert.strictEqual(normalizeIp('::ffff:192.168.1.1:8080'), '192.168.1.1');
assert.strictEqual(normalizeIp('[::ffff:192.168.1.1]'), '192.168.1.1');
assert.strictEqual(normalizeIp('[::ffff:192.168.1.1]:8080'), '192.168.1.1');
assert.strictEqual(normalizeIp('2001:DB8::1'), '2001:db8::1');
assert.strictEqual(normalizeIp('[2001:db8::1]'), '2001:db8::1');
assert.strictEqual(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
assert.strictEqual(normalizeIp('::1'), '::1');
assert.strictEqual(normalizeIp('invalid_ip'), null);
assert.strictEqual(normalizeIp(''), null);
assert.strictEqual(normalizeIp(null), null);
console.log('✔ normalizeIp passed');

console.log('--- 2. Testing getClientIp ---');
// When behind trusted proxy (req.app.get('trust proxy') is enabled)
const trustedApp = { get: (key) => key === 'trust proxy' ? 1 : undefined };
assert.strictEqual(getClientIp({ app: trustedApp, headers: { 'cf-connecting-ip': '2001:db8::1' } }), '2001:db8::1');
assert.strictEqual(getClientIp({ app: trustedApp, headers: { 'x-real-ip': '10.0.0.1' } }), '10.0.0.1');
assert.strictEqual(getClientIp({ app: trustedApp, headers: { 'x-forwarded-for': '172.16.0.1, 10.0.0.1' } }), '10.0.0.1');
assert.strictEqual(getClientIp({ socket: { remoteAddress: '::ffff:192.168.0.5' } }), '192.168.0.5');

// When NOT behind trusted proxy: untrusted forwarded headers must be ignored!
assert.strictEqual(getClientIp({
  headers: { 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' },
  socket: { remoteAddress: '192.168.0.5' }
}), '192.168.0.5', 'Untrusted proxy headers must be ignored when trust proxy is not configured');
console.log('✔ getClientIp passed');

console.log('--- 3. Testing areIpsEquivalent ---');
assert.strictEqual(areIpsEquivalent('192.168.1.1', '192.168.1.1'), true);
assert.strictEqual(areIpsEquivalent('192.168.1.1', '192.168.1.2'), false);
assert.strictEqual(areIpsEquivalent('2001:db8:1234:5678:1::1', '2001:db8:1234:5678:2::2'), true);
assert.strictEqual(areIpsEquivalent('2001:db8:1234:5678::1', '2001:db8:1234:9999::1'), false);
assert.strictEqual(areIpsEquivalent('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0002'), true);
assert.strictEqual(areIpsEquivalent('::1', '::1'), true);
assert.strictEqual(areIpsEquivalent('::1', '::2'), false, 'Special loopback addresses must not be grouped by /64');
assert.strictEqual(areIpsEquivalent('::1', '2001:db8::1'), false);
// Link-local range fe80::/10 (fe80 through febf)
assert.strictEqual(isSpecialIpv6('fe80::1'), true, 'fe80 is link-local');
assert.strictEqual(isSpecialIpv6('fe81::1'), true, 'fe81 is link-local');
assert.strictEqual(isSpecialIpv6('fe9a::1'), true, 'fe9a is link-local');
assert.strictEqual(isSpecialIpv6('febf::1'), true, 'febf is link-local');
assert.strictEqual(isSpecialIpv6('fec0::1'), false, 'fec0 is not in fe80::/10');
assert.strictEqual(areIpsEquivalent('fe80::1', 'fe80::2'), false, 'fe80 link-local addresses must not be grouped by /64');
assert.strictEqual(areIpsEquivalent('fe81::1', 'fe81::2'), false, 'fe81 link-local addresses must not be grouped by /64');
assert.strictEqual(areIpsEquivalent('febf::1', 'febf::2'), false, 'febf link-local addresses must not be grouped by /64');
assert.strictEqual(areIpsEquivalent('fe80::1', 'fe80::1'), true);
assert.strictEqual(areIpsEquivalent('fe81::1', 'fe81::1'), true);
// Canonicalization of special addresses across compressed and expanded forms
assert.strictEqual(areIpsEquivalent('::1', '0000:0000:0000:0000:0000:0000:0000:0001'), true, '::1 must equal expanded loopback');
assert.strictEqual(areIpsEquivalent('fe80::1', 'fe80:0000:0000:0000:0000:0000:0000:0001'), true, 'fe80::1 must equal expanded link-local');
console.log('✔ areIpsEquivalent passed');

console.log('--- 4. Testing createIpCheck with Mock DB ---');
(async () => {
  const ipHistoryRecords = [];
  const bannedUsers = {};
  const allowlistRecords = [];

  const mockDb = {
    antiVpnAllowlist: {
      findFirst: async ({ where }) => {
        return allowlistRecords.find(r => r.ipAddress === where.ipAddress && r.userId === where.users?.some?.userId) || null;
      },
      findMany: async ({ where }) => {
        return allowlistRecords.filter(r => r.userId === where.users?.some?.userId);
      }
    },
    ipHistory: {
      findFirst: async ({ where }) => {
        return ipHistoryRecords.find(record => {
          if (where.NOT?.discordId && record.discordId === where.NOT.discordId) {
            return false;
          }
          if (where.ipAddress) {
            return record.ipAddress === where.ipAddress;
          }
          if (where.OR) {
            return where.OR.some(cond => {
              if (cond.ipAddress?.startsWith) {
                return record.ipAddress.startsWith(cond.ipAddress.startsWith);
              }
              if (typeof cond.ipAddress === 'string') {
                return record.ipAddress === cond.ipAddress;
              }
              return false;
            });
          }
          return false;
        }) || null;
      },
      findMany: async ({ where }) => {
        return ipHistoryRecords.filter(record => {
          if (where.NOT?.discordId && record.discordId === where.NOT.discordId) {
            return false;
          }
          if (where.ipAddress?.contains && !record.ipAddress.includes(where.ipAddress.contains)) {
            return false;
          }
          return true;
        });
      },
      upsert: async ({ where, create, update }) => {
        const existingIdx = ipHistoryRecords.findIndex(
          r => r.ipAddress === where.ipAddress_discordId.ipAddress && r.discordId === where.ipAddress_discordId.discordId
        );
        if (existingIdx >= 0) {
          ipHistoryRecords[existingIdx].userId = update.userId;
          return ipHistoryRecords[existingIdx];
        } else {
          ipHistoryRecords.push({ ...create });
          return create;
        }
      }
    },
    user: {
      update: async ({ where, data }) => {
        bannedUsers[where.id] = data;
        return { id: where.id, ...data };
      }
    }
  };

  const ipCheck = createIpCheck(mockDb);

  // Test 4.1: IPv4 legitimate login
  const r1 = await ipCheck.checkAndRecordIp('1.2.3.4', 'discord-user-1', 'user-1');
  assert.strictEqual(r1.allowed, true, 'User 1 IPv4 first login should be allowed');

  // Test 4.2: IPv4 alt account login from same IP -> Auto Ban!
  const r2 = await ipCheck.checkAndRecordIp('1.2.3.4', 'discord-user-2', 'user-2');
  assert.strictEqual(r2.allowed, false, 'User 2 IPv4 alt login must be banned');
  assert.strictEqual(bannedUsers['user-2']?.isBanned, true, 'User 2 must be marked as banned');
  console.log('✔ IPv4 anti-alt detection verified');

  // Test 4.3: IPv6 legitimate user login
  const ipv6UserA = '2a01:cb08:834:100:1111:2222:3333:4444';
  const r3 = await ipCheck.checkAndRecordIp(ipv6UserA, 'discord-user-3', 'user-3');
  assert.strictEqual(r3.allowed, true, 'User 3 IPv6 first login should be allowed');

  // Test 4.4: IPv6 legitimate user rotates privacy address within same /64 -> Allowed!
  const ipv6UserARotated = '2a01:cb08:834:100:5555:6666:7777:8888';
  const r4 = await ipCheck.checkAndRecordIp(ipv6UserARotated, 'discord-user-3', 'user-3');
  assert.strictEqual(r4.allowed, true, 'User 3 IPv6 rotated address must be allowed (same Discord ID)');

  // Test 4.5: IPv6 ALT ACCOUNT login from same /64 subnet -> Auto Ban!
  const ipv6AltAccount = '2a01:cb08:834:100:9999:aaaa:bbbb:cccc';
  const r5 = await ipCheck.checkAndRecordIp(ipv6AltAccount, 'discord-user-4', 'user-4');
  assert.strictEqual(r5.allowed, false, 'User 4 IPv6 alt login from same /64 must be banned');
  assert.strictEqual(bannedUsers['user-4']?.isBanned, true, 'User 4 must be marked as banned');
  console.log('✔ IPv6 /64 subnet anti-alt detection verified');

  // Test 4.6: IPv6 DIFFERENT household /64 login -> Allowed!
  const ipv6DifferentUser = '2a01:cb08:999:200:1111:2222:3333:4444';
  const r6 = await ipCheck.checkAndRecordIp(ipv6DifferentUser, 'discord-user-5', 'user-5');
  assert.strictEqual(r6.allowed, true, 'User 5 from different IPv6 subnet should be allowed');
  console.log('✔ IPv6 different subnet login verified');

  // Test 4.7: IPv6 legacy compressed record matching
  ipHistoryRecords.push({ ipAddress: '2001:db8::1', discordId: 'discord-user-legacy', userId: 'user-legacy' });
  const rLegacyAlt = await ipCheck.checkAndRecordIp('2001:db8::2', 'discord-user-legacy-alt', 'user-legacy-alt');
  assert.strictEqual(rLegacyAlt.allowed, false, 'Alt login from same /64 with compressed legacy record must be detected');
  console.log('✔ IPv6 compressed legacy record anti-alt detection verified');

  // Test 4.8: IPv6 allowlisted user bypass
  allowlistRecords.push({ ipAddress: '2a01:cb08:834:100:0000:0000:0000:0001', userId: 'user-6' });
  const r7 = await ipCheck.checkAndRecordIp('2a01:cb08:834:100:ffff:eeee:dddd:cccc', 'discord-user-6', 'user-6');
  assert.strictEqual(r7.allowed, true, 'Allowlisted IPv6 user should bypass check');
  assert.strictEqual(r7.allowlistBypassed, true);
  console.log('✔ IPv6 allowlist bypass verified');

  console.log('ALL TESTS PASSED SUCCESSFULLY!');
})();

console.log('--- 5. Testing areIpsEquivalent in session scenarios ---');
// Session IP check: rotating IPv6 temporary host address within same /64
const sessionIp1 = '2a01:cb08:834:100:aaaa:bbbb:cccc:dddd';
const rotatedSessionIp1 = '2a01:cb08:834:100:1111:2222:3333:4444';
const differentSubnetSessionIp = '2a01:cb08:999:200:aaaa:bbbb:cccc:dddd';

assert.strictEqual(areIpsEquivalent(sessionIp1, rotatedSessionIp1), true, 'Same /64 must be equivalent in session');
assert.strictEqual(areIpsEquivalent(sessionIp1, differentSubnetSessionIp), false, 'Different /64 must NOT be equivalent in session');
console.log('✔ Session IP equivalent logic verified');


console.log('--- 6. Testing schemas.billingCheckout validation ---');
const { schemas } = require('../handlers/validate');
assert.doesNotThrow(() => schemas.billingCheckout.parse({ amount_eur: 10 }), 'EUR amount only should pass');
assert.doesNotThrow(() => schemas.billingCheckout.parse({ amount_usd: 10 }), 'USD amount only should pass');
assert.throws(() => schemas.billingCheckout.parse({ amount_eur: 10, amount_usd: 10 }), /Specify exactly one amount currency/, 'Both EUR and USD should be rejected');
assert.throws(() => schemas.billingCheckout.parse({}), /Specify exactly one amount currency/, 'Empty object should be rejected');
console.log('✔ schemas.billingCheckout validation verified');
