// src/services/minecraftService.js
import axios from 'axios';

// Function to get Minecraft server status
export const fetchServerStatus = async (serverAddress) => {
  try {
    // Using a custom User-Agent as required by the API
    const response = await axios.get(`https://api.mcsrvstat.us/3/${serverAddress}`, {
      headers: {
        'User-Agent': 'Altare-Admin-Panel/1.0'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error fetching Minecraft server status:', error);
    return {
      online: false,
      ip: '',
      port: 0
    };
  }
};

// Helper function to get player head URL from UUID
export const getPlayerHeadUrl = (uuid) => {
  // Remove hyphens from UUID for Minecraft API
  const cleanUuid = uuid.replace(/-/g, '');
  return `https://crafatar.com/avatars/${cleanUuid}?size=64&overlay`;
};

// Execute server command
export const executeServerCommand = async (serverId, command) => {
  try {
    await axios.post(`/api/server/${serverId}/command`, { command });
    return true;
  } catch (error) {
    console.error('Error executing server command:', error);
    return false;
  }
};