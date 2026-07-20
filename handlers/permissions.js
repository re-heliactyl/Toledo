const PERMISSION_CATEGORIES = {
  general: {
    id: 'general',
    name: 'General Access',
    description: 'Basic permissions for accessing administrative routes',
    permissions: [
      { key: 'admin.access', name: 'Admin Panel Access', description: 'Grants access to administration routes' },
      { key: 'admin.overview.view', name: 'View Overview', description: 'View system statistics and global analytics' },
    ]
  },
  users: {
    id: 'users',
    name: 'User Management',
    description: 'Permissions to manage user accounts',
    permissions: [
      { key: 'admin.users.view', name: 'View Users', description: 'View user list and account details' },
      { key: 'admin.users.manage', name: 'Manage Users', description: 'Modify coins, resources, packages and create users' },
      { key: 'admin.users.ban', name: 'Ban Users', description: 'Ban or unban user accounts' },
    ]
  },
  servers: {
    id: 'servers',
    name: 'Server Management',
    description: 'Permissions to manage panel servers',
    permissions: [
      { key: 'admin.servers.view', name: 'View Servers', description: 'View list of all panel servers' },
      { key: 'admin.servers.manage', name: 'Manage Servers', description: 'Change server resource limits (RAM, CPU, Disk), egg and owner' },
      { key: 'admin.servers.actions', name: 'Power Actions', description: 'Start, stop, restart or kill any server' },
      { key: 'admin.servers.console', name: 'Console Access', description: 'View live server console and send commands' },
      { key: 'admin.servers.files', name: 'File Manager Access', description: 'Browse, edit, upload and delete server files' },
      { key: 'admin.servers.delete', name: 'Delete Servers', description: 'Purge or permanently delete a server' },
    ]
  },
  nodes: {
    id: 'nodes',
    name: 'Nodes & Locations',
    description: 'Permissions to manage Pterodactyl nodes and locations',
    permissions: [
      { key: 'admin.nodes.view', name: 'View Nodes', description: 'View nodes and locations' },
      { key: 'admin.nodes.manage', name: 'Manage Nodes', description: 'Sync and edit nodes and locations' },
    ]
  },
  eggs: {
    id: 'eggs',
    name: 'Eggs & Nests',
    description: 'Permissions to manage Pterodactyl eggs and nests',
    permissions: [
      { key: 'admin.eggs.view', name: 'View Eggs', description: 'View eggs and egg categories' },
      { key: 'admin.eggs.manage', name: 'Manage Eggs', description: 'Sync, edit and categorize eggs' },
    ]
  },
  tickets: {
    id: 'tickets',
    name: 'Support & Tickets',
    description: 'Permissions to process support tickets',
    permissions: [
      { key: 'admin.tickets.view', name: 'View Tickets', description: 'View all support tickets' },
      { key: 'admin.tickets.manage', name: 'Manage Tickets', description: 'Reply, change status or reassign tickets' },
    ]
  },
  roles: {
    id: 'roles',
    name: 'Roles & Permissions',
    description: 'Permissions to manage custom roles and role assignments',
    permissions: [
      { key: 'admin.roles.manage', name: 'Manage Roles', description: 'Create, edit, delete and assign custom roles' },
    ]
  },
  settings: {
    id: 'settings',
    name: 'System Settings',
    description: 'Permissions to configure panel settings',
    permissions: [
      { key: 'admin.settings.manage', name: 'Manage Settings', description: 'Modify panel configuration, SFTP and Anti-VPN settings' },
      { key: 'admin.updater.manage', name: 'Manage Updates', description: 'View and run system updates' },
    ]
  }
};

const ALL_PERMISSION_KEYS = Object.values(PERMISSION_CATEGORIES).flatMap(
  cat => cat.permissions.map(p => p.key)
);

function isValidPermission(permKey) {
  return permKey === '*' || ALL_PERMISSION_KEYS.includes(permKey);
}

module.exports = {
  PERMISSION_CATEGORIES,
  ALL_PERMISSION_KEYS,
  isValidPermission,
};
