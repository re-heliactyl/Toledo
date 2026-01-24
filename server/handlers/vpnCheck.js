const axios = require("axios");

module.exports = async (key, db, ip, res) => {
  let ipcache = await db.get(`vpncheckcache-${ip}`);
  
  if (!ipcache) {
    try {
      const response = await axios.get(`https://proxycheck.io/v2/${ip}?key=${key}&vpn=1`);
      const vpncheck = response.data;
      if (vpncheck && vpncheck[ip]) {
        ipcache = vpncheck[ip].proxy;
      }
    } catch (error) {
      // Silently fail on VPN check errors
    }
  }
  
  if (ipcache) {
    await db.set(`vpncheckcache-${ip}`, ipcache, 172800000);
    // Is a VPN/proxy?
    if (ipcache === "yes") {
      res.send('VPN Detected! Please disable your VPN to continue.');
      return true;
    }
  }
  
  return false;
};
