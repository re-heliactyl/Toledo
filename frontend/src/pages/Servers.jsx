import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import {
  ServerIcon, PlusIcon, 
  ArrowPathIcon, ExclamationCircleIcon,
  UsersIcon, MagnifyingGlassIcon
} from '@heroicons/react/24/outline';

// Utility function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 MB';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function CreateServerModal({ isOpen, onClose }) {
  const [name, setName] = useState('');
  const [egg, setEgg] = useState('');
  const [location, setLocation] = useState('');
  const [ram, setRam] = useState('');
  const [disk, setDisk] = useState('');
  const [cpu, setCpu] = useState('');
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [animationClass, setAnimationClass] = useState('');

  const [showEggDropdown, setShowEggDropdown] = useState(false);
  const [showLocationDropdown, setShowLocationDropdown] = useState(false);

  const eggDropdownRef = useRef(null);
  const locationDropdownRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      setTimeout(() => setAnimationClass('opacity-100 scale-100'), 10);
    } else {
      setAnimationClass('opacity-0 scale-95');
      setTimeout(() => setIsVisible(false), 300);
    }
  }, [isOpen]);

  const { data: eggs } = useQuery({
    queryKey: ['eggs'],
    queryFn: async () => {
      const { data } = await axios.get('/api/v5/eggs');
      return data;
    }
  });

  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: async () => {
      const { data } = await axios.get('/api/v5/locations');
      return data;
    }
  });

  const selectedEgg = Array.isArray(eggs) ? eggs.find(e => e.id === egg) : null;

  // Handle clicks outside dropdowns
  useEffect(() => {
    function handleClickOutside(event) {
      if (eggDropdownRef.current && !eggDropdownRef.current.contains(event.target)) {
        setShowEggDropdown(false);
      }
      if (locationDropdownRef.current && !locationDropdownRef.current.contains(event.target)) {
        setShowLocationDropdown(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCreate = async () => {
    try {
      setError('');
      setIsCreating(true);

      if (!name?.trim()) throw new Error('Server name is required');
      if (!egg) throw new Error('Server type is required');
      if (!location) throw new Error('Location is required');
      if (!ram || !disk || !cpu) throw new Error('Resource values are required');

      await axios.post('/api/v5/servers', {
        name: name.trim(),
        egg,
        location,
        ram: parseInt(ram),
        disk: parseInt(disk),
        cpu: parseInt(cpu)
      });

      onClose();
      window.location.reload(); // Simple reload to refresh list
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen && !isVisible) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div
        className={`fixed inset-0 transition-opacity duration-300 ${animationClass}`}
        onClick={onClose}
      ></div>
      <div
        className={`relative bg-[#202229] border border-white/5 rounded-lg w-full max-w-lg p-6 transition-all duration-300 ${animationClass}`}
      >
        <div className="mb-4">
          <h2 className="text-lg font-medium">Create New Server</h2>
        </div>

        <div className="space-y-5 py-4">
          <div className="space-y-2">
            <label className="text-sm text-[#95a1ad] block">Server Name</label>
            <input
              placeholder="My Awesome Server"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-[#394047] focus:bg-[#394047]/50 border border-white/5 focus:border-white/5 focus:ring-1 focus:ring-white/20 rounded-md p-2 text-sm focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-2" ref={eggDropdownRef}>
            <label className="text-sm text-[#95a1ad] block">Server Type</label>
            <div className="relative">
              <button
                type="button"
                className="w-full bg-[#394047] border border-white/5 rounded-md p-2 text-sm flex justify-between items-center focus:outline-none focus:bg-[#394047]/50 focus:border-white/5 focus:ring-1 focus:ring-white/20 transition-colors"
                onClick={() => setShowEggDropdown(!showEggDropdown)}
              >
                <span className={egg ? "text-white" : "text-[#95a1ad]"}>
                  {Array.isArray(eggs) ? eggs.find(e => e.id === egg)?.name : "Select Server Type"}
                </span>
                <svg className="h-5 w-5 text-[#95a1ad]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>

              {showEggDropdown && (
                <div className="absolute z-10 mt-1 w-full bg-[#202229] border border-white/5 rounded-md shadow-lg max-h-60 overflow-auto">
                  {Array.isArray(eggs) && eggs.map(eggItem => (
                    <button
                      key={eggItem.id}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-white/5 transition-colors"
                      onClick={() => {
                        setEgg(eggItem.id);
                        setShowEggDropdown(false);
                      }}
                    >
                      {eggItem.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2" ref={locationDropdownRef}>
            <label className="text-sm text-[#95a1ad] block">Location</label>
            <div className="relative">
              <button
                type="button"
                className="w-full bg-[#394047] border border-white/5 rounded-md p-2 text-sm flex justify-between items-center focus:outline-none focus:bg-[#394047]/50 focus:border-white/5 focus:ring-1 focus:ring-white/20 transition-colors"
                onClick={() => setShowLocationDropdown(!showLocationDropdown)}
              >
                <span className={location ? "text-white" : "text-[#95a1ad]"}>
                  {Array.isArray(locations) ? locations.find(loc => loc.id === location)?.name : "Select Location"}
                </span>
                <svg className="h-5 w-5 text-[#95a1ad]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>

              {showLocationDropdown && (
                <div className="absolute z-10 mt-1 w-full bg-[#202229] border border-white/5 rounded-md shadow-lg max-h-60 overflow-auto">
                  {Array.isArray(locations) && locations.map(locationItem => (
                    <button
                      key={locationItem.id}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-white/5 transition-colors"
                      onClick={() => {
                        setLocation(locationItem.id);
                        setShowLocationDropdown(false);
                      }}
                    >
                      {locationItem.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-[#95a1ad] block">RAM (MB)</label>
              <input
                type="number"
                placeholder="2048"
                value={ram}
                onChange={e => setRam(e.target.value)}
                className="w-full bg-[#394047] focus:bg-[#394047]/50 border border-white/5 focus:border-white/5 focus:ring-1 focus:ring-white/20 rounded-md p-2 text-sm focus:outline-none transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-[#95a1ad] block">Disk (MB)</label>
              <input
                type="number"
                placeholder="10240"
                value={disk}
                onChange={e => setDisk(e.target.value)}
                className="w-full bg-[#394047] focus:bg-[#394047]/50 border border-white/5 focus:border-white/5 focus:ring-1 focus:ring-white/20 rounded-md p-2 text-sm focus:outline-none transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-[#95a1ad] block">CPU (%)</label>
              <input
                type="number"
                placeholder="100"
                value={cpu}
                onChange={e => setCpu(e.target.value)}
                className="w-full bg-[#394047] focus:bg-[#394047]/50 border border-white/5 focus:border-white/5 focus:ring-1 focus:ring-white/20 rounded-md p-2 text-sm focus:outline-none transition-colors"
              />
            </div>
          </div>

          {selectedEgg && (
            <div className="rounded-md border border-blue-500/20 bg-blue-500/10 text-blue-500 p-3 flex items-start">
              <ExclamationCircleIcon className="w-4 h-4 mt-0.5 mr-2 flex-shrink-0" />
              <span className="text-sm">
                Minimum requirements: {selectedEgg.minimum.ram}MB RAM, {selectedEgg.minimum.disk}MB Disk, {selectedEgg.minimum.cpu}% CPU
              </span>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/20 bg-red-500/10 text-red-500 p-3 flex items-start">
              <ExclamationCircleIcon className="w-4 h-4 mt-0.5 mr-2 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-white/5 text-[#95a1ad] hover:text-white hover:bg-white/5 font-medium text-sm transition active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 bg-white text-black hover:bg-white/90 rounded-md font-medium text-sm transition active:scale-95 flex items-center justify-center gap-2 disabled:opacity-70"
          >
            {isCreating ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <PlusIcon className="w-4 h-4" />}
            Create Server
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerCard({ server, wsStatus, stats }) {
  const navigate = useNavigate();

  const statusColors = {
    running: 'bg-emerald-500',
    starting: 'bg-amber-500',
    stopping: 'bg-amber-500',
    offline: 'bg-neutral-500'
  };

  const {
    limits = {}
  } = server?.attributes || {};

  let globalIdentifier;
  let globalName;

  if (server?.attributes) {
    globalIdentifier = server.attributes.identifier;
  } else {
    globalIdentifier = server.id;
  }

  if (server?.attributes) {
    globalName = server.attributes.name;
  } else {
    globalName = server.name;
  }

  const status = wsStatus?.[globalIdentifier] || 'offline';
  const serverStats = stats?.[globalIdentifier] || { cpu: 0, memory: 0, disk: 0 };

  const handleCardClick = () => {
    navigate(`/server/${globalIdentifier}/overview`);
  };

  return (
    <div
      className="border border-[#2e3337]/50 hover:scale-[1.01] hover:border-[#2e3337] rounded-lg bg-transparent transition duration-200 hover:border-white/10 cursor-pointer relative group"
      onClick={handleCardClick}
    >
      <div className="p-4 pb-3 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[#202229] border border-white/5 group-hover:border-white/10 transition-colors">
            <ServerIcon className="w-5 h-5 text-[#95a1ad]" />
          </div>
          <div>
            <h3 className="font-medium text-sm">{globalName || 'Unnamed Server'}</h3>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={`h-1.5 w-1.5 rounded-full ${statusColors[status]}`}></div>
              <p className="text-xs text-[#95a1ad]">
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 pt-2 pb-3 space-y-4">
        <div>
          <div className="flex justify-between text-xs text-[#95a1ad] mb-1.5">
            <span>Memory</span>
            <span>{serverStats.memory?.toFixed(0) || 0} / {limits.memory || 0} MB</span>
          </div>
          <div className="h-1 bg-[#202229] rounded-full overflow-hidden">
            <div
              className="h-full bg-neutral-300 rounded-full"
              style={{ width: `${limits.memory ? Math.min((serverStats.memory / limits.memory) * 100, 100) : 0}%` }}
            ></div>
          </div>
        </div>

        <div>
          <div className="flex justify-between text-xs text-[#95a1ad] mb-1.5">
            <span>CPU</span>
            <span>{serverStats.cpu?.toFixed(1) || 0} / {limits.cpu || 0}%</span>
          </div>
          <div className="h-1 bg-[#202229] rounded-full overflow-hidden">
            <div
              className="h-full bg-neutral-300 rounded-full"
              style={{ width: `${limits.cpu ? Math.min((serverStats.cpu / limits.cpu) * 100, 100) : 0}%` }}
            ></div>
          </div>
        </div>

        <div>
          <div className="flex justify-between text-xs text-[#95a1ad] mb-1.5">
            <span>Disk</span>
            <span>{formatBytes(serverStats.disk || 0)} / {formatBytes((limits.disk || 0) * 1024 * 1024)}</span>
          </div>
          <div className="h-1 bg-[#202229] rounded-full overflow-hidden">
            <div
              className="h-full bg-neutral-300 rounded-full"
              style={{ width: `${limits.disk ? Math.min((serverStats.disk / (limits.disk * 1024 * 1024)) * 100, 100) : 0}%` }}
            ></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8 p-6 max-w-screen-2xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 bg-[#202229] rounded-md animate-pulse"></div>
        <div className="h-9 w-32 bg-[#202229] rounded-md animate-pulse"></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-[220px] border border-[#2e3337] rounded-lg bg-[#202229]/20 animate-pulse"></div>
        ))}
      </div>
    </div>
  );
}

export default function ServersPage() {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [serverStatus, setServerStatus] = useState({});
  const [serverStats, setServerStats] = useState({});
  const socketsRef = useRef({});

  const { data: servers, isLoading: loadingServers } = useQuery({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data } = await axios.get('/api/v5/servers');
      return data;
    }
  });

  const { data: subuserServers, isLoading: loadingSubuserServers } = useQuery({
    queryKey: ['subuser-servers'],
    queryFn: async () => {
      const { data } = await axios.get('/api/subuser-servers');
      return data;
    }
  });

  useEffect(() => {
    if (!servers && !subuserServers) return;

    // Connect WebSockets for owned servers
    if (Array.isArray(servers)) {
      servers.forEach(server => {
        if (!socketsRef.current[server.attributes.identifier]) {
          connectWebSocket(server);
        }
      });
    }

    // Connect WebSockets for subuser servers
    if (Array.isArray(subuserServers)) {
      subuserServers.forEach(server => {
        if (!socketsRef.current[server.id]) {
          connectWebSocket(server);
        }
      });
    }

    return () => {
      Object.values(socketsRef.current).forEach(ws => ws.close());
      socketsRef.current = {};
    };
  }, [servers, subuserServers]);

  const connectWebSocket = async (server) => {
    try {
      const serverId = server?.attributes?.identifier || server.id;
      const { data: wsData } = await axios.get(`/api/server/${serverId}/websocket`);
      const ws = new WebSocket(wsData.data.socket);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          event: "auth",
          args: [wsData.data.token]
        }));
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message, serverId);
      };

      ws.onclose = () => {
        delete socketsRef.current[serverId];
        // Reconnect after 5 seconds if page is still open
        // Note: Simple reconnect, ideally check if component mounted
      };

      socketsRef.current[serverId] = ws;
    } catch (error) {
      console.error(`WebSocket connection error for ${server?.attributes?.identifier || server.id}:`, error);
    }
  };

  const handleWebSocketMessage = (message, serverId) => {
    switch (message.event) {
      case 'auth success':
        socketsRef.current[serverId].send(JSON.stringify({
          event: 'send stats',
          args: [null]
        }));
        break;

      case 'stats':
        const statsData = JSON.parse(message.args[0]);
        if (!statsData) return;

        setServerStats(prev => ({
          ...prev,
          [serverId]: {
            cpu: statsData.cpu_absolute || 0,
            memory: statsData.memory_bytes / 1024 / 1024 || 0,
            disk: statsData.disk_bytes || 0
          }
        }));
        break;

      case 'status':
        setServerStatus(prev => ({
          ...prev,
          [serverId]: message.args[0]
        }));
        break;
    }
  };

  // Filter servers
  const filteredOwnedServers = Array.isArray(servers) 
    ? servers.filter(s => s.attributes.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : [];
    
  const filteredSubuserServers = Array.isArray(subuserServers)
    ? subuserServers.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : [];

  if (loadingServers || loadingSubuserServers) {
    return <LoadingSkeleton />;
  }

  const hasSubuserServers = filteredSubuserServers.length > 0;
  const hasOwnedServers = filteredOwnedServers.length > 0;

  return (
    <div className="space-y-8 p-6 max-w-screen-2xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Servers</h1>
          <p className="text-[#95a1ad]">Manage your instances and access subuser servers</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#95a1ad]" />
            <input 
              type="text" 
              placeholder="Search servers..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 bg-[#1a1c1e] border border-[#2e3337] rounded-md text-sm focus:outline-none focus:border-white/10 w-full sm:w-64"
            />
          </div>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="px-4 py-2 bg-white text-black hover:bg-white/90 rounded-md font-medium text-sm transition active:scale-95 flex items-center gap-2 whitespace-nowrap"
          >
            <PlusIcon className="w-4 h-4" />
            New Server
          </button>
        </div>
      </div>

      <div className="space-y-8">
        {/* Owned Servers Section */}
        <div className="space-y-4">
          <h2 className="text-lg font-medium flex items-center gap-2 text-[#95a1ad] uppercase text-xs tracking-wider">
            <ServerIcon className="w-4 h-4" />
            Your Servers
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredOwnedServers.map(server => (
              <ServerCard
                key={server.attributes.id}
                server={server}
                wsStatus={serverStatus}
                stats={serverStats}
              />
            ))}

            {filteredOwnedServers.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center p-12 text-center border border-[#2e3337] border-dashed rounded-lg bg-[#202229]/20">
                <ServerIcon className="w-8 h-8 text-[#2e3337] mb-2" />
                <p className="text-sm text-[#95a1ad]">
                  {searchTerm ? 'No servers match your search.' : 'You don\'t have any servers yet.'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Subuser Servers Section */}
        {hasSubuserServers && (
          <div className="space-y-4">
            <h2 className="text-lg font-medium flex items-center gap-2 text-[#95a1ad] uppercase text-xs tracking-wider">
              <UsersIcon className="w-4 h-4" />
              Shared With You
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSubuserServers.map(server => (
                <ServerCard
                  key={server.id}
                  server={server}
                  wsStatus={serverStatus}
                  stats={serverStats}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <CreateServerModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </div>
  );
}
