import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Terminal, Power, RotateCw, Square, Cpu, MemoryStick,
  HardDrive, Network, Server, Upload, Database, RefreshCw,
  Clock, Shield, Download, AlertTriangle, CheckCircle2,
  X, XCircle, Info, Loader2, AlertCircle, Copy, ChevronDown, InfoIcon
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip,
  ResponsiveContainer, Area, AreaChart
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import axios from "axios";
import MinecraftPlayerList from './MinecraftPlayerList';
import ConnectionOverlay from '../../components/ConnectionOverlay';

const RETRY_COUNT = 5;
const RETRY_DELAY = 5000;
const MAX_HISTORY_POINTS = 50;
const CHART_COLORS = {
  cpu: '#3B82F6',
  memory: '#3B82F6',
  disk: '#A855F7',
  network: '#F59E0B'
};

// Custom Notification Component
const NotificationContainer = ({ notifications, removeNotification }) => (
  <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-md w-full">
    {notifications.map((notification) => (
      <div
        key={notification.id}
        className={`
          rounded-lg backdrop-blur shadow-lg p-4 pr-10 relative animate-in slide-in-from-right-5
          ${notification.type === 'success' ? 'bg-green-500/10 backdrop-blur-lg border border-green-500/20 text-green-500' : ''}
          ${notification.type === 'error' ? 'bg-red-500/10 backdrop-blur-lg border border-red-500/20 text-red-500' : ''}
          ${notification.type === 'warning' ? 'bg-yellow-500/10 backdrop-blur-lg border border-yellow-500/20 text-yellow-500' : ''}
          ${notification.type === 'info' ? 'bg-blue-500/10 backdrop-blur-lg border border-blue-500/20 text-blue-500' : ''}
        `}
      >
        <div className="flex items-start gap-3">
          {notification.type === 'success' && <CheckCircle2 className="h-5 w-5 mt-0.5" />}
          {notification.type === 'error' && <XCircle className="h-5 w-5 mt-0.5" />}
          {notification.type === 'warning' && <AlertTriangle className="h-5 w-5 mt-0.5" />}
          {notification.type === 'info' && <Info className="h-5 w-5 mt-0.5" />}
          <div className="flex-1">
            {notification.title && (
              <h4 className="font-medium mb-1">{notification.title}</h4>
            )}
            <p className="text-sm opacity-90">{notification.message}</p>
          </div>
        </div>
        <button
          onClick={() => removeNotification(notification.id)}
          className="absolute top-4 right-4 opacity-70 hover:opacity-100 transition-opacity"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    ))}
  </div>
);

// Custom notification hook
const useNotifications = () => {
  const [notifications, setNotifications] = useState([]);
  const notificationId = useRef(0);

  const addNotification = useCallback((type, message, title = null, duration = 5000) => {
    const id = notificationId.current++;
    setNotifications(prev => [...prev, { id, type, message, title, timestamp: Date.now() }]);

    if (duration) {
      setTimeout(() => {
        setNotifications(prev => prev.filter(notification => notification.id !== id));
      }, duration);
    }
  }, []);

  const removeNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(notification => notification.id !== id));
  }, []);

  return {
    notifications,
    addNotification,
    removeNotification
  };
};

const ResourceChart = ({ data, dataKey, color, label, unit = "", domain }) => (
  <div className="h-36">
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
        <defs>
          <linearGradient id={`gradient-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10, fill: '#6B7280' }}
          stroke="#374151"
          interval="preserveStart"
        />
        <YAxis
          domain={domain || [0, 'auto']}
          tick={{ fontSize: 10, fill: '#6B7280' }}
          stroke="#374151"
          width={40}
        />
        <RechartsTooltip
          content={({ active, payload }) => {
            if (active && payload?.[0]) {
              return (
                <div className="bg-[#202229] border border-neutral-800 p-2 rounded-lg shadow-lg">
                  <p className="text-sm text-neutral-300">
                    {`${label}: ${payload[0].value.toFixed(1)}${unit}`}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {payload[0].payload.time}
                  </p>
                </div>
              );
            }
            return null;
          }}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          fill={`url(#gradient-${dataKey})`}
          strokeWidth={2}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  </div>
);

const formatNetworkSpeed = (kbps) => {
  if (kbps >= 1099511627776) {
    return `${(kbps / 1099511627776).toFixed(2)} PB/s`;
  } else if (kbps >= 1073741824) {
    return `${(kbps / 1073741824).toFixed(2)} TB/s`;
  } else if (kbps >= 1048576) {
    return `${(kbps / 1048576).toFixed(2)} GB/s`;
  } else if (kbps >= 1024) {
    return `${(kbps / 1024).toFixed(2)} MB/s`;
  }
  return `${kbps.toFixed(2)} KB/s`;
};

const NetworkChart = ({ data }) => (
  <div className="h-36">
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10, fill: '#6B7280' }}
          stroke="#374151"
          interval="preserveStart"
        />
        <YAxis
          tick={{ fontSize: 10, fill: '#6B7280' }}
          stroke="#374151"
          width={40}
          tickFormatter={(value) => {
            if (value >= 1099511627776) return `${(value / 1099511627776).toFixed(1)}P`;
            if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)}T`;
            if (value >= 1048576) return `${(value / 1048576).toFixed(1)}G`;
            if (value >= 1024) return `${(value / 1024).toFixed(1)}M`;
            return `${value.toFixed(0)}K`;
          }}
        />
        <RechartsTooltip
          content={({ active, payload }) => {
            if (active && payload?.length) {
              return (
                <div className="bg-[#202229] border border-neutral-800 p-2 rounded-lg shadow-lg">
                  <p className="text-sm text-neutral-300">
                    {`↑ Upload: ${formatNetworkSpeed(payload[0].value)}`}
                  </p>
                  <p className="text-sm text-neutral-300">
                    {`↓ Download: ${formatNetworkSpeed(payload[1].value)}`}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {payload[0].payload.time}
                  </p>
                </div>
              );
            }
            return null;
          }}
        />
        <Line
          type="monotone"
          dataKey="up"
          stroke={CHART_COLORS.network}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="down"
          stroke="#60A5FA"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  </div>
);

const ResourceStat = ({ icon: Icon, title, value, secondaryValue, chartData, dataKey, color, unit, domain, Chart = ResourceChart }) => (
  <Card className="overflow-hidden">
    <CardHeader className="p-4 pb-0">
      <div className="flex items-center gap-3">
        <div className="bg-white/5 p-2.5 rounded-lg">
          <Icon className="w-5 h-5 text-neutral-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-400">{title}</p>
          <div className="flex items-baseline gap-2">
            <p className="text-lg font-semibold text-white truncate">{value}</p>
            {secondaryValue && (
              <p className="text-sm text-neutral-500 truncate">{secondaryValue}</p>
            )}
          </div>
        </div>
      </div>
    </CardHeader>
    <CardContent className="p-4 pt-2">
      {chartData?.length > 0 && (
        <Chart
          data={chartData}
          dataKey={dataKey}
          color={color}
          label={title}
          unit={unit}
          domain={domain}
        />
      )}
    </CardContent>
  </Card>
);

const formatConsoleOutput = (line) => {
  let processedLine = line;

  const replacements = [
    // Handle [m reset marker
    {
      pattern: /\[m/g,
      replacement: '</span>'
    },
    // EULA message
    {
      pattern: /You need to agree to the EULA in order to run the server/i,
      replacement: '<span class="text-yellow-500 font-mono">You need to agree to the EULA to run the server. Please check the dialog above.</span>'
    },
    // Timestamp and log level brackets
    {
      pattern: /(\[\d{2}:\d{2}:\d{2}\s*[A-Z]*\])/g,
      replacement: '<span class="text-neutral-400 font-mono">$1</span>'
    },
    // Log levels
    {
      pattern: /(ERROR|WARN|INFO|DEBUG)/g,
      replacement: (match) => {
        const colors = {
          ERROR: 'text-red-300',
          WARN: 'text-yellow-300',
          INFO: 'text-blue-300',
          DEBUG: 'text-neutral-400'
        };
        return `<span class="font-mono ${colors[match]}">${match}</span>`;
      }
    },
    // Replace container@pterodactyl with badge
    {
      pattern: /container@pterodactyl~/g,
      replacement: '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-normal bg-[#101218] text-white/80 shadow border border-white/10">container</span>'
    },
    // Replace [Piledriver]: with badge
    {
      pattern: /\[Pterodactyl Daemon\]:/g,
      replacement: '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-normal bg-[#101218] text-white/80 shadow border border-white/10">kryptond</span>'
    },
    // Replace specific Piledriver messages with more direct ones
    {
      pattern: /Checking server disk space usage, this could take a few seconds\.\.\./g,
      replacement: 'Checking things, hold on...'
    },
    {
      pattern: /Updating process configuration files\.\.\./g,
      replacement: 'This might take a while. One moment.'
    },
    {
      pattern: /Ensuring file permissions are set correctly, this could take a few seconds\.\.\./g,
      replacement: 'All checks completed. We\'re good to go.'
    },
    {
      pattern: /Pulling Docker container image, this could take a few minutes to complete\.\.\./g,
      replacement: 'Updating Cargo on-the-fly...'
    },
    {
      pattern: /Finished pulling Docker container image/g,
      replacement: 'All done!'
    },
    // Plugin names in brackets
    {
      pattern: /\[([\w\s]+)\]/g,
      replacement: '<span class="text-neutral-400 font-mono">[$1]</span>'
    },
    // Clean up any residual color codes
    {
      pattern: /\u001b\[\d+(?:;\d+)*m/g,
      replacement: ''
    }
  ];

  for (const { pattern, replacement } of replacements) {
    processedLine = processedLine.replace(pattern, replacement);
  }

  // Handle ANSI color codes after other replacements
  processedLine = processedLine
    .replace(/\u001b\[(\d+)m/g, (match, code) => {
      const colors = {
        31: 'text-red-500',     // Red
        32: 'text-green-500',   // Green
        33: 'text-yellow-500',  // Yellow
        34: 'text-neutral-400', // Blue -> Gray
        35: 'text-purple-500',  // Purple
        36: 'text-cyan-500',    // Cyan
        37: 'text-white',       // White
        '31;1': 'text-red-500 font-bold',
        '32;1': 'text-green-500 font-bold',
        '33;1': 'text-yellow-500 font-bold',
        '34;1': 'text-neutral-400 font-bold',
        '36;1': 'text-cyan-500 font-bold'
      };
      return `<span class="font-mono ${colors[code] || ''}">`;
    })
    .replace(/\u001b\[0m/g, '</span>')
    .replace(/\[0;39m/g, '</span>')
    .replace(/\n/g, '<br>');

  // Ensure the entire line is monospaced, including colored text
  return `<div class="font-mono">${processedLine}</div>`;
};

export default function ConsolePage() {
  const isFirstStateUpdate = useRef(true);
  const { id } = useParams();
  const socketRef = useRef(null);
  const [serverState, setServerState] = useState("offline");
  const [isInstalling, setIsInstalling] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const [command, setCommand] = useState("");
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [retryCount, setRetryCount] = useState(0);
  const [showEulaDialog, setShowEulaDialog] = useState(false);
  const [installationProgress, setInstallationProgress] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copySuccess, setCopySuccess] = useState(false);
  const [resourceHistory, setResourceHistory] = useState({
    cpu: [],
    memory: [],
    disk: [],
    network: []
  });
  const [stats, setStats] = useState({
    cpu: 0,
    memory: 0,
    disk: 0,
    network: { up: 0, down: 0 },
    uptime: "0h 00m 0s"
  });
  const [isConnecting, setIsConnecting] = useState(true);

  const scrollAreaRef = useRef(null);
  const mounted = useRef(true);
  const { notifications, addNotification, removeNotification } = useNotifications();

  const { data: userData } = useQuery({
    queryKey: ['user'],
    queryFn: async () => {
      const { data } = await axios.get('/api/user');
      return data;
    }
  });

  const { data: argonData } = useQuery({
    queryKey: ['argon'],
    queryFn: async () => {
      const { data } = await axios.get('/api/remote/argon');
      return data;
    }
  });

  const { data: server, error: serverError } = useQuery({
    queryKey: ['server', id],
    queryFn: async () => {
      const { data } = await axios.get(`/api/server/${id}`);
      return data.attributes;
    }
  });

  const writeFile = async (path, content) => {
    try {
      const response = await fetch(`/api/server/${id}/files/write?file=${encodeURIComponent(path)}`, {
        method: 'POST',
        body: content
      });

      if (!response.ok) throw new Error(`Failed to write file: ${response.statusText}`);
      return true;
    } catch (error) {
      addNotification('error', `Failed to write to ${path}: ${error.message}`);
      return false;
    }
  };

  const handleAcceptEula = async () => {
    if (await writeFile('eula.txt', 'eula=true')) {
      addNotification('success', 'EULA accepted successfully');
      setShowEulaDialog(false);
      socketRef.current?.send(JSON.stringify({
        event: 'set state',
        args: ['restart']
      }));
    }
  };

  const handleWebSocketMessage = useCallback((event) => {
    if (!mounted.current) return;

    try {
      const message = JSON.parse(event.data);

      switch (message.event) {
        case 'auth success':
          socketRef.current?.send(JSON.stringify({ event: 'send logs', args: [null] }));
          socketRef.current?.send(JSON.stringify({ event: 'send stats', args: [null] }));
          break;

        case 'console output':
          setConsoleLines(prev => [...prev.slice(-1000), message.args[0]]);
          if (message.args[0].toLowerCase().includes('agree to the eula')) {
            setShowEulaDialog(true);
          }
          break;

        case 'stats':
          const statsData = JSON.parse(message.args[0]);
          if (!statsData || !mounted.current) return;

          setStats(prev => ({
            ...prev,
            cpu: (statsData.cpu_absolute || 0).toFixed(1),
            memory: (statsData.memory_bytes / 1024 / 1024 || 0).toFixed(0),
            disk: (statsData.disk_bytes / 1024 / 1024 || 0).toFixed(0),
            network: {
              up: (statsData.network?.tx_bytes / 1024 || 0).toFixed(2),
              down: (statsData.network?.rx_bytes / 1024 || 0).toFixed(2)
            },
            uptime: statsData.uptime || "0h 00m 0s"
          }));
          break;

        case 'status':
          const newState = message.args[0];
          setServerState(newState);
          setIsInstalling(message.args[1]?.is_installing || false);
          break;

        case 'install started':
          setInstallationProgress({ status: 'started', message: 'Installation started...' });
          addNotification('info', 'Server installation started');
          break;

        case 'install output':
          setInstallationProgress(prev => ({
            ...prev,
            message: message.args[0]
          }));
          break;

        case 'install completed':
          setInstallationProgress({ status: 'completed', message: 'Installation completed successfully' });
          addNotification('success', 'Server installation completed successfully');
          setIsInstalling(false);
          break;

        case 'token expired':
          addNotification('warning', 'Your session has expired. Reconnecting...', 'Session Expired');
          break;

        case 'token expiring':
          refreshToken();
          break;

        case 'daemon error':
          addNotification('error', message.args[0], 'Daemon Error');
          break;

        case 'jwt error':
          addNotification('error', message.args[0], 'Authentication Error');
          break;
      }
    } catch (error) {
      console.error('WebSocket message handling error:', error);
    }
  }, [addNotification]);

  const refreshToken = async () => {
    try {
      const { data } = await axios.get(`/api/server/${id}/websocket`);
      socketRef.current?.send(JSON.stringify({
        event: "auth",
        args: [data.data.token]
      }));
    } catch (error) {
      addNotification('error', 'Failed to refresh connection token', 'Connection Error');
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  // Update resource history when stats change
  useEffect(() => {
    if (!mounted.current) return;

    const timestamp = new Date().toLocaleTimeString();
    setResourceHistory(prev => ({
      cpu: [...prev.cpu.slice(-MAX_HISTORY_POINTS), { time: timestamp, value: parseFloat(stats.cpu) }],
      memory: [...prev.memory.slice(-MAX_HISTORY_POINTS), { time: timestamp, value: parseFloat(stats.memory) }],
      disk: [...prev.disk.slice(-MAX_HISTORY_POINTS), { time: timestamp, value: parseFloat(stats.disk) }],
      network: [...prev.network.slice(-MAX_HISTORY_POINTS), {
        time: timestamp,
        up: parseFloat(stats.network.up) || 0,
        down: parseFloat(stats.network.down) || 0
      }]
    }));
  }, [stats]);

  useEffect(() => {
    mounted.current = true;
    setIsConnecting(true);

    const connectWebSocket = async () => {
      try {
        if (!mounted.current) return;

        // Show connecting state while fetching websocket URL
        setIsConnecting(true);

        const { data } = await axios.get(`/api/server/${id}/websocket`);
        const ws = new WebSocket(data.data.socket);

        ws.onopen = () => {
          if (!mounted.current) {
            ws.close();
            return;
          }

          setRetryCount(0);
          setIsConnecting(false);

          ws.send(JSON.stringify({
            event: "auth",
            args: [data.data.token]
          }));
        };

        ws.onmessage = handleWebSocketMessage;

        ws.onclose = () => {
          if (!mounted.current) return;

          if (retryCount < RETRY_COUNT) {
            setTimeout(() => {
              if (mounted.current) {
                setRetryCount(prev => prev + 1);
                setIsConnecting(true);
                connectWebSocket();
              }
            }, RETRY_DELAY);
          }
        };

        ws.onerror = () => {
          setIsConnecting(true);
        };

        socketRef.current = ws;
      } catch (error) {
        addNotification('error', 'Failed to connect to server', 'Connection Error');
        // Keep connecting state for a bit to show the error
        setTimeout(() => {
          if (mounted.current) setIsConnecting(false);
        }, 2000);
      }
    };

    connectWebSocket();

    return () => {
      mounted.current = false;
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [id, retryCount, handleWebSocketMessage, addNotification]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        setTimeout(() => {
          scrollContainer.scrollTo({
            top: scrollContainer.scrollHeight,
            behavior: 'instant'
          });
        }, 0);
      }
    }
  }, [consoleLines, autoScroll]);

  const handleScroll = useCallback((event) => {
    const container = event.currentTarget;
    const isAtBottom = Math.abs(
      (container.scrollHeight - container.clientHeight) - container.scrollTop
    ) < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const sendCommand = (e) => {
    e?.preventDefault();
    if (!command.trim() || !socketRef.current) return;

    socketRef.current.send(JSON.stringify({
      event: "send command",
      args: [command]
    }));
    setCommandHistory(prev => [command, ...prev.slice(0, 99)]);
    setCommand("");
    setHistoryIndex(-1);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHistoryIndex(prev => {
        if (prev < commandHistory.length - 1) {
          const newIndex = prev + 1;
          setCommand(commandHistory[newIndex]);
          return newIndex;
        }
        return prev;
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHistoryIndex(prev => {
        if (prev > -1) {
          const newIndex = prev - 1;
          setCommand(newIndex === -1 ? '' : commandHistory[newIndex]);
          return newIndex;
        }
        return prev;
      });
    }
  };

  const sendPowerAction = (action) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        event: "set state",
        args: [action]
      }));
    }
  };
  // Update this helper function for better uptime calculation
  const formatUptime = (uptime) => {
    // First check if it's already a formatted string
    if (typeof uptime === 'string' && (uptime.includes('h') || uptime.includes('m'))) {
      return uptime;
    }

    // Try to parse as a number if it's a string
    let seconds = 0;

    if (typeof uptime === 'string') {
      // Try to parse as number
      const parsed = parseInt(uptime, 10);
      if (!isNaN(parsed)) {
        seconds = parsed;
      }
    } else if (typeof uptime === 'number') {
      seconds = uptime;
    }

    // If uptime is jumping by ~18 minutes every second, it might be reporting in deciseconds (1/10th of a second)
    // Or it could be milliseconds (which would be 16.7 minutes per second)

    // Let's try to detect the most likely time unit based on the magnitude
    if (seconds > 1000) {
      // If value is very large, it's likely milliseconds
      seconds = Math.round(seconds / 1000);
    } else if (seconds > 100) {
      // If the value is moderately large but not huge, it might be deciseconds
      seconds = Math.round(seconds / 10);
    }

    // Calculate hours, minutes, seconds
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    // Format with leading zeros for better readability
    return `${hours}h ${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
  };


  // Loading state
  if (!server) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-2">
        <RefreshCw className="w-6 h-6 text-neutral-400 animate-spin" />
        <p className="text-white/50 uppercase tracking-widest text-xs mt-2">
          Connecting to server...
        </p>
        <p className="text-white text-md mt-8 font-medium">Is this taking a while?</p>
        <p className="text-white/70 text-xs">We may be experiencing high demand, which can cause high API latency and connection issues.</p>
      </div>
    );
  }

  // Error state
  if (serverError) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-red-400">
        Failed to load server data
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <NotificationContainer
        notifications={notifications}
        removeNotification={removeNotification}
      />

      {/* Server Header with updated status badge */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-white">{server?.name}</h1>
          <Badge
            variant={
              serverState === 'running'
                ? 'success'
                : serverState === 'starting'
                  ? 'warning'
                  : 'secondary'
            }
            className="rounded-md font-normal flex items-center gap-1.5 px-2.5 py-0.5"
          >
            <div
              className={`h-1.5 w-1.5 rounded-full ${serverState === 'running'
                  ? 'bg-emerald-500/80'
                  : serverState === 'starting'
                    ? 'bg-amber-500/80'
                    : 'bg-neutral-400/80'
                }`}
            />
            {serverState.charAt(0).toUpperCase() + serverState.slice(1)}
          </Badge>
        </div>

        <TooltipProvider>
          <div className="flex gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => sendPowerAction('start')}
                  disabled={['starting', 'running'].includes(serverState) || isInstalling}
                >
                  <Power className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Start Server</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => sendPowerAction('restart')}
                  disabled={!['running'].includes(serverState) || isInstalling}
                >
                  <RotateCw className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Restart Server</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    // Send kill command if server is in a transitional state
                    const action = ['starting', 'stopping'].includes(serverState) ? 'kill' : 'stop';
                    sendPowerAction(action);
                  }}
                  disabled={['offline'].includes(serverState) || isInstalling}
                >
                  <Square className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {['starting', 'stopping'].includes(serverState) ? 'Kill Server' : 'Stop Server'}
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      <MinecraftPlayerList serverIdentifier={id} />
      {isConnecting && <ConnectionOverlay />}

      {/* Replace the existing Card after the Server Header with this */}
      <div className="flex items-center gap-6 p-4 rounded-lg border border-white/5">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-neutral-400" />
          <div>
            <p className="text-xs text-neutral-500">Node</p>
            <p className="text-sm text-white font-medium">{server?.node}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-neutral-400" />
          <div>
            <p className="text-xs text-neutral-500">IP Address</p>
            <p className="text-sm text-white font-medium">
              {server?.relationships?.allocations?.data?.[0]?.attributes?.ip_alias}:
              {server?.relationships?.allocations?.data?.[0]?.attributes?.port}
            </p>
          </div>
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <div className="flex items-center gap-2 cursor-pointer group">
              <Upload className="w-4 h-4 text-neutral-400" />
              <div className="flex items-center gap-1">
                <div>
                  <p className="text-xs text-neutral-500">SFTP</p>
                  <p className="text-sm text-white font-medium truncate max-w-[150px]">
                    {argonData?.ArgonUser?.Username}.{server?.identifier}
                  </p>
                </div>
                <ChevronDown className="h-4 w-4 text-neutral-500 group-hover:text-neutral-300 transition-colors" />
              </div>
            </div>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-4">
            <div className="space-y-3">
              <h4 className="font-medium text-sm">SFTP Details</h4>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <p className="text-xs text-neutral-500">Host</p>
                  <p className="text-xs text-black">{server?.sftp_details?.ip}</p>
                </div>

                <div className="flex justify-between">
                  <p className="text-xs text-neutral-500">Port</p>
                  <p className="text-xs text-black">{server?.sftp_details?.port}</p>
                </div>

                <div className="flex justify-between">
                  <p className="text-xs text-neutral-500">Username</p>
                  <div className="flex items-center gap-1">
                    <p className="text-xs text-black">{argonData?.ArgonUser?.Username}.{server?.identifier}</p>
                    <TooltipProvider>
                      <Tooltip open={copySuccess}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 hover:bg-neutral-800/50"
                            onClick={() => copyToClipboard(`${argonData?.ArgonUser?.Username}.${server?.identifier}`)}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{copySuccess ? 'Copied!' : 'Copy to clipboard'}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </div>

              <div className="p-2 rounded bg-blue-100 border border-blue-200/20">
                <div className="flex gap-2">
                  <InfoIcon className="h-4 w-4 text-blue-800 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-800">
                    Use your SFTP password from the Account Settings page when connecting.
                  </p>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-2 ml-auto">
          <Clock className="w-4 h-4 text-neutral-400" />
          <div>
            <p className="text-xs text-neutral-500">Uptime</p>
            <p className="text-sm text-white font-medium">{formatUptime(stats.uptime) || "Offline"}</p>
          </div>
        </div>
      </div>

      <div>
        <div>
          {/* Console with Empty State - Fixed Vertical Centering */}
          <Card>
            <CardContent className="p-0">
              <ScrollArea
                ref={scrollAreaRef}
                className="h-[440px] font-mono text-sm bg-transparent"
                onScroll={handleScroll}
              >
                {consoleLines.length > 0 ? (
                  <div className="p-4">
                    {consoleLines.map((line, i) => (
                      <div
                        key={i}
                        className="py-0.5"
                        dangerouslySetInnerHTML={{ __html: formatConsoleOutput(line) }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="flex flex-col items-center justify-center text-center p-6">
                      <div className="bg-white/5 p-4 rounded-full mb-4 mt-8">
                        <Terminal className="h-8 w-8 text-neutral-400" />
                      </div>
                      <h3 className="text-lg font-medium text-white mb-2">Hm... there's nothing here</h3>
                      <p className="text-neutral-400 max-w-md">
                        {serverState === 'offline'
                          ? 'Start your server to see console output here'
                          : 'Waiting for console output...'}
                      </p>
                      {serverState === 'offline' && (
                        <Button
                          variant="outline"
                          className="mt-4"
                          onClick={() => sendPowerAction('start')}
                          disabled={isInstalling}
                        >
                          <Power className="w-4 h-4 mr-2" />
                          Start server
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </ScrollArea>
              <div className="p-4 border-t border-white/10">
                <form onSubmit={sendCommand} className="flex gap-2">
                  <Input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isInstalling ? "Console commands are disabled during installation..." : "Type a command..."}
                    className="flex-1 bg-transparent border-white/10"
                    disabled={isInstalling || serverState === 'offline'}
                  />
                  <Button
                    type="submit"
                    disabled={isInstalling || !command.trim() || serverState === 'offline'}
                  >
                    Send
                  </Button>
                </form>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Resource Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <ResourceStat
          icon={Cpu}
          title="CPU Usage"
          value={`${stats?.cpu || 0} %`}
          secondaryValue={`${server?.limits?.cpu || 0} % Limit`}
          chartData={resourceHistory.cpu}
          dataKey="value"
          color={CHART_COLORS.cpu}
          unit="%"
          domain={[0, 100]}
        />
        <ResourceStat
          icon={MemoryStick}
          title="Memory Usage"
          value={`${stats.memory || 0} MB`}
          secondaryValue={`${server?.limits.memory || 0} MB Limit`}
          chartData={resourceHistory.memory}
          dataKey="value"
          color={CHART_COLORS.memory}
          unit=" MB"
          domain={[0, server?.limits.memory]}
        />
        <ResourceStat
          icon={HardDrive}
          title="Storage Usage"
          value={`${stats.disk || 0} MB`}
          secondaryValue={`${server?.limits.disk === 0 ? '∞' : server?.limits.disk + ' MB' || 0} Limit`}
          chartData={resourceHistory.disk}
          dataKey="value"
          color={CHART_COLORS.disk}
          unit=" MB"
          domain={server?.limits.disk ? [0, server.limits.disk] : undefined}
        />
        <ResourceStat
          icon={Network}
          title="Network Traffic"
          value={`↑${formatNetworkSpeed(parseFloat(stats.network.up) || 0)}`}
          secondaryValue={`↓${formatNetworkSpeed(parseFloat(stats.network.down) || 0)}`}
          chartData={resourceHistory.network}
          dataKey="up"
          color={CHART_COLORS.network}
          Chart={NetworkChart}
        />
      </div>

      {/* EULA Dialog */}
      <Dialog open={showEulaDialog} onOpenChange={setShowEulaDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Minecraft EULA Required</DialogTitle>
            <DialogDescription className="space-y-4">
              <p>
                You need to agree to the Minecraft End User License Agreement (EULA) to run the server.
              </p>
              <p>
                By clicking Accept, you agree to the{' '}
                <a
                  href="https://www.minecraft.net/en-us/eula"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Minecraft EULA
                </a>
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEulaDialog(false)}>
              Decline
            </Button>
            <Button onClick={handleAcceptEula}>
              Accept EULA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Installation Progress Overlay */}
      {isInstalling && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <Card className="w-[400px]">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="h-8 w-8 animate-spin" />
                <div className="text-center">
                  <h3 className="font-medium mb-1">Installation in Progress</h3>
                  <p className="text-sm text-muted-foreground">
                    {installationProgress?.message || 'Please wait while the server is being installed...'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}