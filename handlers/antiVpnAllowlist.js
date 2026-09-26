const net = require('net');

/**
 * Expand an IPv6 address to its full 8 4-digit hexadecimal groups (39 chars).
 * Example: '2001:db8::1' -> '2001:0db8:0000:0000:0000:0000:0000:0001'
 */
function expandIpv6(ip) {
  if (!ip || net.isIP(ip) !== 6) return null;
  // If IPv4-mapped, do not expand as pure IPv6
  if (ip.includes('.')) return null;

  const lower = ip.toLowerCase();
  let full;
  if (lower.includes('::')) {
    const [left, right] = lower.split('::');
    const leftParts = left ? left.split(':').filter(Boolean) : [];
    const rightParts = right ? right.split(':').filter(Boolean) : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    const zeros = Array(missing).fill('0000');
    full = [...leftParts, ...zeros, ...rightParts];
  } else {
    full = lower.split(':');
  }
  return full.map(p => p.padStart(4, '0')).join(':');
}

/**
 * Check if an IPv6 address is a special address that should not be grouped by /64
 * (e.g. loopback ::1, unspecified ::, or link-local fe80::)
 */
function isSpecialIpv6(ip) {
  const norm = normalizeIp(ip);
  if (!norm || net.isIP(norm) !== 6) return false;
  const exp = expandIpv6(norm);
  if (!exp) return false;
  // ::1 loopback
  if (exp === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // :: unspecified
  if (exp === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  // fe80::/10 link-local (covers fe80:: through febf::)
  const firstWord = parseInt(exp.split(':')[0], 16);
  if ((firstWord & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * Clean and normalize any IP address (IPv4 or IPv6).
 * Handles:
 * - Arrays or comma-separated proxy headers (takes client IP)
 * - Quotes and whitespace
 * - IPv4-mapped IPv6 (::ffff:192.168.1.1)
 * - Bracketed IPv6 ([2001:db8::1] or [2001:db8::1]:443, [::ffff:192.168.1.1])
 * - IPv4 with port (1.2.3.4:8080)
 */
function normalizeIp(ipAddress) {
  if (!ipAddress) return null;

  let str = String(ipAddress).split(',')[0].trim().replace(/^["']+|["']+$/g, '');

  // Strip brackets from bracketed IPv6 (with or without port, including IPv4-mapped)
  const bracketMatch = str.match(/^\[([a-fA-F0-9:.]+)\](?::\d+)?$/);
  if (bracketMatch) {
    str = bracketMatch[1];
  }

  // Handle IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1)
  if (str.toLowerCase().startsWith('::ffff:')) {
    str = str.slice(7);
  }

  // Strip port from IPv4 if present (e.g. 192.168.1.1:8080)
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(str)) {
    str = str.split(':')[0];
  }

  const version = net.isIP(str);
  if (version === 4) {
    return str;
  }
  if (version === 6) {
    return str.toLowerCase();
  }

  return null;
}

/**
 * Extract the /64 prefix information for an IPv6 address.
 * Under RFC 4941 / SLAAC, ISPs assign a /64 subnet to a subscriber.
 */
function getIpv6Subnet64(ip) {
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  const parts = expanded.split(':');
  const expandedPrefix = parts.slice(0, 4).join(':') + ':';
  const shortParts = parts.slice(0, 4).map(p => p.replace(/^0+/, '') || '0');
  const shortPrefix = shortParts.join(':') + ':';

  // Compute compressed prefix if ends with trailing zeros (e.g. 2001:db8:0:0: -> 2001:db8::)
  let compressedPrefix = null;
  const unpaddedStr = shortParts.join(':');
  if (unpaddedStr.endsWith(':0:0')) {
    compressedPrefix = unpaddedStr.slice(0, -4) + '::';
  } else if (unpaddedStr.endsWith(':0')) {
    compressedPrefix = unpaddedStr.slice(0, -2) + '::';
  }

  return { expanded, expandedPrefix, shortPrefix, compressedPrefix };
}

/**
 * Check if two IP addresses are equivalent:
 * - Equal IPv4 addresses
 * - Equal IPv6 addresses
 * - Or two IPv6 addresses within the same /64 subnet (handles privacy extension rotations)
 */
function areIpsEquivalent(ip1, ip2) {
  const n1 = normalizeIp(ip1);
  const n2 = normalizeIp(ip2);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;

  const v1 = net.isIP(n1);
  const v2 = net.isIP(n2);
  if (v1 === 6 && v2 === 6) {
    // Special addresses (loopback, link-local) must never be grouped by /64
    if (isSpecialIpv6(n1) || isSpecialIpv6(n2)) {
      return expandIpv6(n1) === expandIpv6(n2);
    }
    const s1 = getIpv6Subnet64(n1);
    const s2 = getIpv6Subnet64(n2);
    if (s1 && s2 && s1.expandedPrefix === s2.expandedPrefix) {
      return true;
    }
  }

  return false;
}

/**
 * Retrieve the client IP address from the Express request.
 * Only trusts proxy headers when Express trust proxy is configured,
 * otherwise safely defaults to the direct socket address.
 */
function getClientIp(req) {
  if (!req) return null;

  // 1. If Express resolved req.ip (e.g. app.set('trust proxy', 1)), use it if valid
  if (req.ip) {
    const norm = normalizeIp(req.ip);
    if (norm) return norm;
  }

  const socketIp = normalizeIp(req.socket?.remoteAddress);

  // 2. Only inspect forwarded proxy headers if the request is from a trusted proxy setup
  const trustProxyConfig = req.app?.get?.('trust proxy');
  if (trustProxyConfig) {
    if (req.headers?.['cf-connecting-ip']) {
      const cfIp = normalizeIp(req.headers['cf-connecting-ip']);
      if (cfIp) return cfIp;
    }

    if (req.headers?.['x-real-ip']) {
      const realIp = normalizeIp(req.headers['x-real-ip']);
      if (realIp) return realIp;
    }

    if (req.headers?.['x-forwarded-for']) {
      const hops = String(req.headers['x-forwarded-for'])
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      // Select candidate counting from the right (closest untrusted hop)
      const candidate = hops[hops.length - 1] || hops[0];
      const normForwarded = normalizeIp(candidate);
      if (normForwarded) return normForwarded;
    }
  }

  return socketIp;
}

/**
 * Find allowlist entry for a user.
 * Supports exact IPv4/IPv6 matches, as well as /64 subnet matches for IPv6.
 */
async function findUserAllowlistEntry(db, ipAddress, userId) {
  const normalizedIp = normalizeIp(ipAddress);
  if (!normalizedIp || !userId) return null;

  // 1. Direct match
  const directMatch = await db.antiVpnAllowlist.findFirst({
    where: {
      ipAddress: normalizedIp,
      users: {
        some: { userId }
      }
    },
    select: {
      id: true,
      ipAddress: true,
      reason: true
    }
  });

  if (directMatch) return directMatch;

  // 2. Subnet /64 match for IPv6
  if (net.isIP(normalizedIp) === 6) {
    const userAllowlists = await db.antiVpnAllowlist.findMany({
      where: {
        users: {
          some: { userId }
        }
      },
      select: {
        id: true,
        ipAddress: true,
        reason: true
      }
    });

    for (const entry of userAllowlists) {
      if (areIpsEquivalent(entry.ipAddress, normalizedIp)) {
        return entry;
      }
    }
  }

  return null;
}

async function isUserAllowlisted(db, ipAddress, userId) {
  return Boolean(await findUserAllowlistEntry(db, ipAddress, userId));
}

module.exports = {
  normalizeIp,
  expandIpv6,
  isSpecialIpv6,
  getIpv6Subnet64,
  areIpsEquivalent,
  getClientIp,
  findUserAllowlistEntry,
  isUserAllowlisted
};
