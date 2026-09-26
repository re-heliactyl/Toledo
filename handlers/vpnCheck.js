const axios = require("axios");
const { normalizeIp } = require("./antiVpnAllowlist");

module.exports = async (key, db, ip, res) => {
  if (!ip) {
    return { blocked: false, ip: null };
  }

  const cleanIp = normalizeIp(ip) || ip;
  if (!cleanIp) {
    return { blocked: false, ip: null };
  }

  const cacheKey = `vpncheckcache-${cleanIp}`;

  let ipcache = null;
  const row = await db.heliactyl.findUnique({ where: { key: cacheKey } });
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      if (parsed.expires && Date.now() > parsed.expires) {
        await db.heliactyl.delete({ where: { key: cacheKey } });
      } else {
        ipcache = parsed.value;
      }
    } catch { /* corrupted cache entry, ignore */ }
  }
  
  if (!ipcache) {
    try {
      const response = await axios.get(`https://api.ippriv.com/api/security/${encodeURIComponent(cleanIp)}`, {
        timeout: 5000
      });
      
      const data = response.data;
      
      if (data) {
        // Check if VPN, proxy, Tor, or hosting/datacenter IP
        if (data.isVPN === true || data.isProxy === true || data.isTor === true || data.isHosting === true) {
          ipcache = "yes";
        } else {
          ipcache = "no";
        }
      }
    } catch (error) {
      // Silently fail - allow request if check fails
      return { blocked: false, ip: cleanIp };
    }
  }
  
  // Cache result for 48 hours
  if (ipcache) {
    const cacheData = JSON.stringify({ value: ipcache, expires: Date.now() + 172800000 });
    await db.heliactyl.upsert({
      where: { key: cacheKey },
      update: { value: cacheData },
      create: { key: cacheKey, value: cacheData }
    });
  }
  
  // Block if VPN/proxy detected
  if (ipcache === "yes") {
    return { blocked: true, ip: cleanIp };
  }
  
  return { blocked: false, ip: cleanIp };
};

/**
 * Check VPN and send response directly (legacy mode)
 */
module.exports.checkAndBlock = async (key, db, ip, res) => {
  const result = await module.exports(key, db, ip);
  if (result.blocked) {
    if (res && typeof res.send === 'function') {
      res.send('VPN Detected! Please disable your VPN to continue.');
    }
    return true;
  }
  return false;
};
