const axios = require("axios");

const HeliactylModule = {
  name: "WebSocket Credentials",
  version: "1.0.0",
  api_level: 4,
  target_platform: "10.0.0",
  description: "WebSocket credential caching and request deduplication",
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
  tags: ["server", "websocket"],
  license: "MIT"
};

const WEBSOCKET_CREDENTIAL_TTL_MS = 9 * 60 * 1000;
const websocketCredentialCache = new Map();
const websocketCredentialRequests = new Map();

function getCachedWebSocketCredentials(serverId) {
  const cachedEntry = websocketCredentialCache.get(serverId);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    websocketCredentialCache.delete(serverId);
    return null;
  }

  return cachedEntry.data;
}

function invalidateWebSocketCredentials(serverId) {
  websocketCredentialCache.delete(serverId);
  websocketCredentialRequests.delete(serverId);
}

async function fetchWebSocketCredentials({ serverId, panelUrl, apiKey }) {
  const cachedCredentials = getCachedWebSocketCredentials(serverId);
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const inFlightRequest = websocketCredentialRequests.get(serverId);
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const requestPromise = axios.get(
    `${panelUrl}/api/client/servers/${serverId}/websocket`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  ).then((response) => {
    websocketCredentialCache.set(serverId, {
      data: response.data,
      expiresAt: Date.now() + WEBSOCKET_CREDENTIAL_TTL_MS,
    });

    return response.data;
  }).finally(() => {
    websocketCredentialRequests.delete(serverId);
  });

  websocketCredentialRequests.set(serverId, requestPromise);

  return requestPromise;
}

module.exports = {
  HeliactylModule,
  load: async function () {},
  fetchWebSocketCredentials,
  invalidateWebSocketCredentials,
};
