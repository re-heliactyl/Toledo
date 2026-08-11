const crypto = require('crypto');
const loadConfig = require("../handlers/config.js");
const settings = loadConfig("./config.toml");
const axios = require("axios");
const { paginate, getPaginationParams } = require("../handlers/pagination");
const { validate, schemas } = require("../handlers/validate");
const createAuthz = require('../handlers/authz');
const log = require('../handlers/log');
const { sendTicketReplyDM } = require('./auth_discord.js');

/**
 * Send a ticket notification to the dedicated ticket webhook if configured,
 * otherwise fall back to the main logging webhook.
 * @param {string} action 
 * @param {string} message 
 */
function logTicket(action, message) {
  const ticketWebhook = settings.logging?.ticket_webhook;
  if (ticketWebhook && ticketWebhook.trim() !== '') {
    axios.post(ticketWebhook, {
      embeds: [{
        color: 0x5865F2,
        title: `Ticket: \`${action}\``,
        description: message,
        author: { name: 'Heliactyl Support Tickets' },
        thumbnail: { url: settings.website?.logo || '' }
      }]
    }).catch(() => {});
  } else {
    log(action, message);
  }
}

// Pterodactyl API helper
const pteroApi = axios.create({
  baseURL: settings.pterodactyl.domain,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${settings.pterodactyl.key}`
  }
});

/* Ensure platform release target is met */
const HeliactylModule = {
  "name": "Support Tickets",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

/* Module */
module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const authz = createAuthz(db);

  // Middleware to check admin status
  async function checkAdmin(req, res, settings, db) {
    return authz.getAdminStatus(req);
  }

  // Get ticket statistics (admin only)
  app.get("/api/tickets/stats", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const tickets = await db.ticket.findMany({ include: { messages: true } });

      const stats = {
        total: tickets.length,
        open: tickets.filter(t => t.status === 'open').length,
        closed: tickets.filter(t => t.status === 'closed').length,
        priorities: {
          low: tickets.filter(t => t.priority === 'low').length,
          medium: tickets.filter(t => t.priority === 'medium').length,
          high: tickets.filter(t => t.priority === 'high').length,
          urgent: tickets.filter(t => t.priority === 'urgent').length
        },
        categories: {
          technical: tickets.filter(t => t.category === 'technical').length,
          billing: tickets.filter(t => t.category === 'billing').length,
          general: tickets.filter(t => t.category === 'general').length,
          abuse: tickets.filter(t => t.category === 'abuse').length
        },
        averageResponseTime: calculateAverageResponseTime(tickets),
        ticketsLastWeek: tickets.filter(t => t.createdAt.getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000).length
      };

      res.json(stats);
    } catch (error) {
      console.error("Error fetching ticket statistics:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/notifications/:id/read", async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      await db.notification.updateMany({
        where: {
          id: req.params.id,
          userId: sessionUser.id
        },
        data: {
          read: true
        }
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get ticket count for user
  app.get("/api/tickets/count", async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const userTickets = await db.ticket.findMany({
        where: { userId: sessionUser.id }
      });

      const counts = {
        total: userTickets.length,
        open: userTickets.filter(t => t.status === 'open').length,
        closed: userTickets.filter(t => t.status === 'closed').length
      };

      res.json(counts);
    } catch (error) {
      console.error("Error fetching ticket counts:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get recent activity for admin dashboard
  app.get("/api/tickets/activity", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const tickets = await db.ticket.findMany({ include: { messages: true } });
      const activity = [];

      // Get recent messages from all tickets
      tickets.forEach(ticket => {
        ticket.messages.forEach(message => {
          activity.push({
            type: 'message',
            ticketId: ticket.id,
            subject: ticket.subject,
            timestamp: message.createdAt.getTime(),
            isStaff: message.isStaff,
            content: message.content
          });
        });
      });

      // Sort by timestamp descending and limit to 50 items
      activity.sort((a, b) => b.timestamp - a.timestamp);
      const recentActivity = activity.slice(0, 50);

      res.json(recentActivity);
    } catch (error) {
      console.error("Error fetching ticket activity:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Search tickets (admin only) with pagination
  app.get("/api/tickets/search", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { query, status, priority, category } = req.query;
      
      const where = {};
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (category) where.category = category;
      
      if (query) {
        where.OR = [
          { subject: { contains: query } },
          { messages: { some: { content: { contains: query } } } }
        ];
      }

      const tickets = await db.ticket.findMany({
        where,
        include: { messages: true },
        orderBy: { createdAt: 'desc' }
      });

      // Format tickets for display
      const formattedTickets = tickets.map(ticket => formatTicketForDisplay(ticket, false));

      // Paginate results
      const { page, perPage } = getPaginationParams(req.query);
      const paginatedResult = paginate(formattedTickets, page, perPage);
      
      res.json(paginatedResult);
    } catch (error) {
      console.error("Error searching tickets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Export tickets to CSV (admin only)
  app.get("/api/tickets/export", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const tickets = await db.ticket.findMany({ include: { messages: true } });
      let csv = 'Ticket ID,Subject,Status,Priority,Category,Created,Updated,Messages\n';

      tickets.forEach(ticket => {
        csv += `${ticket.id},${escapeCsvField(ticket.subject)},${ticket.status},${ticket.priority},${ticket.category},${ticket.createdAt.toISOString()},${ticket.updatedAt.toISOString()},${ticket.messages.length}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=tickets.csv');
      res.send(csv);
    } catch (error) {
      console.error("Error exporting tickets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Helper function to escape CSV fields
  function escapeCsvField(field) {
    if (typeof field !== 'string') return field;
    return `"${field.replace(/"/g, '""')}"`;
  }

  // Create a new ticket
  app.post("/api/tickets", validate(schemas.ticketCreate), async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const { subject, description, priority, category } = req.body;

      const ticket = await db.ticket.create({
        data: {
          userId: sessionUser.id,
          subject: subject,
          description: description,
          priority: priority,
          category: category,
          status: 'open'
        },
        include: { messages: true }
      });

      const message = await db.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          userId: sessionUser.id,
          content: description,
          isStaff: false
        }
      });

      ticket.messages = [message];

      // Create user notification
      await db.notification.create({
        data: {
          userId: sessionUser.id,
          action: 'ticket_created',
          name: `Ticket #${ticket.id.slice(0, 8)} has been created`
        }
      });

      // Webhook log for ticket creation
      logTicket('ticket_created', `**${sessionUser.username || sessionUser.email}** created ticket **#${ticket.id.slice(0, 8).toUpperCase()}**\n**Subject:** ${subject}\n**Priority:** ${priority}\n**Category:** ${category}`);

      res.status(201).json(ticket);
    } catch (error) {
      console.error("Error creating ticket:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all tickets (admin only) with pagination
  app.get("/api/tickets/all", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { page, perPage } = getPaginationParams(req.query);
      const { status, priority, category, query } = req.query;

      const where = {};
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (category) where.category = category;
      if (query) {
        where.OR = [
          { subject: { contains: query } },
          { messages: { some: { content: { contains: query } } } }
        ];
      }

      const tickets = await db.ticket.findMany({
        where,
        include: { 
          messages: true,
          user: {
            select: {
              username: true,
              email: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      const formattedTickets = tickets.map(ticket => {
        const formatted = formatTicketForDisplay(ticket, false);
        return {
          ...formatted,
          user: ticket.user || { username: 'Unknown', email: 'unknown@example.com' }
        };
      });

      // Paginate results
      const paginatedResult = paginate(formattedTickets, page, perPage);
      res.json(paginatedResult);
    } catch (error) {
      console.error("Error fetching tickets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get user's tickets with pagination
  app.get("/api/tickets", async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const { page, perPage } = getPaginationParams(req.query);
      const userTickets = await db.ticket.findMany({
        where: { userId: sessionUser.id },
        include: { messages: true },
        orderBy: { createdAt: 'desc' }
      });
      
      // Paginate results
      const paginatedResult = paginate(userTickets.map(t => formatTicketForDisplay(t)), page, perPage);
      res.json(paginatedResult);
    } catch (error) {
      console.error("Error fetching user tickets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get specific ticket
  app.get("/api/tickets/:id", async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const ticket = await db.ticket.findUnique({
        where: { id: req.params.id },
        include: { messages: { orderBy: { createdAt: 'asc' } } }
      });

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      // Check if user owns ticket or is admin
      const isAdmin = await checkAdmin(req, res, settings, db);
      if (ticket.userId !== sessionUser.id && !isAdmin) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const formattedTicket = formatTicketForDisplay(ticket);

      // Add admin-only data if requester is admin
      if (isAdmin) {
        const adminData = await getAdminTicketData(ticket.userId, db, pteroApi);
        formattedTicket.customer = adminData.customer;
        formattedTicket.ownedServers = adminData.ownedServers;
      }

      res.json(formattedTicket);
    } catch (error) {
      console.error("Error fetching ticket:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Add message to ticket
  app.post("/api/tickets/:id/messages", validate(schemas.ticketMessage), async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const { content } = req.body;

      const ticket = await db.ticket.findUnique({
        where: { id: req.params.id }
      });

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const isAdmin = await checkAdmin(req, res, settings, db);

      // Check if user owns ticket or is admin
      if (ticket.userId !== sessionUser.id && !isAdmin) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const message = await db.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          userId: sessionUser.id,
          content: content,
          isStaff: isAdmin
        }
      });

      await db.ticket.update({
        where: { id: ticket.id },
        data: { status: 'open' }
      });

      // Create notification for the other party
      let notifyUserId = null;
      if (isAdmin) {
        notifyUserId = ticket.userId;
      } else {
        const adminNotifRecord = await db.heliactyl.findUnique({ where: { key: "admin-notifications" } });
        if (adminNotifRecord) {
          try {
            notifyUserId = JSON.parse(adminNotifRecord.value);
          } catch {
            notifyUserId = adminNotifRecord.value;
          }
        }
      }

      if (notifyUserId) {
        await db.notification.create({
          data: {
            userId: notifyUserId,
            action: 'ticket_reply',
            name: `New reply on ticket #${ticket.id.slice(0, 8)}`
          }
        });
      }

      // Send Discord DM to ticket owner if admin replied
      if (isAdmin) {
        try {
          const ticketOwner = await db.user.findUnique({
            where: { id: ticket.userId },
            select: { discordId: true }
          });

          if (ticketOwner?.discordId) {
            const ticketDisplayId = ticket.id.slice(0, 8).toUpperCase();
            sendTicketReplyDM(ticketOwner.discordId, ticketDisplayId, ticket.subject, settings.website.domain);
          }
        } catch (dmError) {
          console.error('Failed to send Discord DM notification:', dmError.message);
        }
      }

      // Webhook log for ticket reply
      const sender = isAdmin ? 'Staff' : (sessionUser.username || sessionUser.email);
      logTicket('ticket_reply', `**${sender}** replied to ticket **#${ticket.id.slice(0, 8).toUpperCase()}**\n**Subject:** ${ticket.subject}\n**Message:** ${content.length > 200 ? content.slice(0, 200) + '...' : content}`);

      res.json({
        ...message,
        timestamp: message.createdAt.getTime(),
        timeAgo: getTimeAgo(message.createdAt)
      });
    } catch (error) {
      console.error("Error adding message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update ticket status (open/closed)
  app.patch("/api/tickets/:id/status", validate(schemas.ticketStatus), async (req, res) => {
    if (!authz.hasUserSession(req)) return res.status(401).json({ error: "Unauthorized" });
    const sessionUser = authz.getSessionUser(req);

    try {
      const { status } = req.body;

      const ticket = await db.ticket.findUnique({
        where: { id: req.params.id }
      });

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const isAdmin = await checkAdmin(req, res, settings, db);

      // Check if user owns ticket or is admin
      if (ticket.userId !== sessionUser.id && !isAdmin) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      await db.ticket.update({
        where: { id: ticket.id },
        data: { status }
      });

      // Add system message about status change
      await db.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          userId: sessionUser.id,
          content: `Ticket ${status} by ${isAdmin ? 'staff' : 'user'}`,
          isSystem: true
        }
      });

      // Create notification for the other party
      let notifyUserId = null;
      if (isAdmin) {
        notifyUserId = ticket.userId;
      } else {
        const adminNotifRecord = await db.heliactyl.findUnique({ where: { key: "admin-notifications" } });
        if (adminNotifRecord) {
          try {
            notifyUserId = JSON.parse(adminNotifRecord.value);
          } catch {
            notifyUserId = adminNotifRecord.value;
          }
        }
      }

      if (notifyUserId) {
        await db.notification.create({
          data: {
            userId: notifyUserId,
            action: 'ticket_status',
            name: `Ticket #${ticket.id.slice(0, 8)} has been ${status}`
          }
        });
      }

      const updatedTicket = await db.ticket.findUnique({
        where: { id: ticket.id },
        include: { messages: true }
      });

      res.json(formatTicketForDisplay(updatedTicket));
    } catch (error) {
      console.error("Error updating ticket status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update ticket priority (admin only)
  app.patch("/api/tickets/:id/priority", validate(schemas.ticketPriority), async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const sessionUser = authz.getSessionUser(req);

    try {
      const { priority } = req.body;

      const ticket = await db.ticket.findUnique({
        where: { id: req.params.id }
      });

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      await db.ticket.update({
        where: { id: ticket.id },
        data: { priority }
      });

      // Add system message about priority change
      await db.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          userId: sessionUser.id,
          content: `Ticket priority changed to ${priority}`,
          isSystem: true
        }
      });

      // Notify user of priority change
      await db.notification.create({
        data: {
          userId: ticket.userId,
          action: 'ticket_priority',
          name: `Ticket #${ticket.id.slice(0, 8)} priority changed to ${priority}`
        }
      });

      const updatedTicket = await db.ticket.findUnique({
        where: { id: ticket.id },
        include: { messages: true }
      });

      res.json(formatTicketForDisplay(updatedTicket));
    } catch (error) {
      console.error("Error updating ticket priority:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Archive a ticket
  app.post("/api/tickets/:id/archive", async (req, res) => {
    if (!await checkAdmin(req, res, settings, db)) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const sessionUser = authz.getSessionUser(req);

    try {
      const ticket = await db.ticket.findUnique({
        where: { id: req.params.id }
      });

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      await db.ticket.update({
        where: { id: ticket.id },
        data: { status: 'archived' }
      });

      // Add system message about archiving
      await db.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          userId: sessionUser.id,
          content: 'Ticket archived by staff',
          isSystem: true
        }
      });

      const updatedTicket = await db.ticket.findUnique({
        where: { id: ticket.id },
        include: { messages: true }
      });

      res.json(formatTicketForDisplay(updatedTicket));
    } catch (error) {
      console.error("Error archiving ticket:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};

// Helper function to calculate average response time
function calculateAverageResponseTime(tickets) {
  let totalResponseTime = 0;
  let responsesCount = 0;

  tickets.forEach(ticket => {
    if (ticket.messages.length > 1) {
      for (let i = 1; i < ticket.messages.length; i++) {
        const currentMessage = ticket.messages[i];
        const previousMessage = ticket.messages[i - 1];

        // Only count response time if messages are from different users
        if (currentMessage.userId !== previousMessage.userId) {
          totalResponseTime += currentMessage.createdAt.getTime() - previousMessage.createdAt.getTime();
          responsesCount++;
        }
      }
    }
  });

  return responsesCount > 0 ? Math.floor(totalResponseTime / responsesCount) : 0;
}

// Helper function to format tickets for display
function formatTicketForDisplay(ticket, includeMessages = true) {
  const displayTicket = {
    id: ticket.id,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    created: ticket.createdAt.getTime(),
    updated: ticket.updatedAt.getTime(),
    displayId: ticket.id.slice(0, 8).toUpperCase(),
    timeAgo: getTimeAgo(ticket.updatedAt),
    userId: ticket.userId,
  };

  if (includeMessages && ticket.messages) {
    displayTicket.messages = ticket.messages.map(msg => ({
      id: msg.id,
      content: msg.content,
      timestamp: msg.createdAt.getTime(),
      timeAgo: getTimeAgo(msg.createdAt),
      isStaff: msg.isStaff,
      isSystem: msg.isSystem,
      userId: msg.userId,
    }));
  }

  return displayTicket;
}

// Helper function to get time ago string
function getTimeAgo(timestamp) {
  const date = new Date(timestamp);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60
  };

  for (const [unit, secondsInUnit] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInUnit);
    if (interval >= 1) {
      return interval === 1 ? `1 ${unit} ago` : `${interval} ${unit}s ago`;
    }
  }

  return 'just now';
}

// Helper function to get admin ticket data (customer info and owned servers)
async function getAdminTicketData(userId, db, pteroApi) {
  const fallbackCustomer = {
    id: userId,
    pterodactylId: null,
    username: 'Unknown',
    email: 'unknown@example.com',
    firstName: null,
    lastName: null,
    rootAdmin: false,
    createdAt: null,
    coins: 0,
    packageName: null,
    packageRAM: 0,
    packageDisk: 0,
    packageCpu: 0,
    packageServers: 0,
    extraRAM: 0,
    extraDisk: 0,
    extraCpu: 0,
    extraServers: 0,
    totalRAM: 0,
    totalDisk: 0,
    totalCpu: 0,
    totalServers: 0
  };

  const fallbackServers = [];

  try {
    // Fetch user from database (coins, package, extras)
    const dbUser = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        pterodactylId: true,
        coins: true,
        packageName: true,
        extraRam: true,
        extraDisk: true,
        extraCpu: true,
        extraServers: true,
        createdAt: true
      }
    });

    if (!dbUser) {
      return { customer: fallbackCustomer, ownedServers: fallbackServers };
    }

    // Get package defaults from settings
    const defaultPackage = settings.api.client.packages?.default || 'free';
    const userPackage = settings.api.client.packages?.list?.[dbUser.packageName || defaultPackage] || {};
    const packageRAM = userPackage.ram || 0;
    const packageDisk = userPackage.disk || 0;
    const packageCpu = userPackage.cpu || 0;
    const packageServers = userPackage.servers || 0;

    let pteroUsername = 'Unknown';
    let pteroEmail = 'unknown@example.com';
    let pteroFirstName = null;
    let pteroLastName = null;
    let pteroRootAdmin = false;
    let pteroCreatedAt = dbUser.createdAt;

    // Fetch Pterodactyl panel user info if pterodactylId exists
    if (dbUser.pterodactylId) {
      try {
        const pteroResponse = await pteroApi.get(`/api/application/users/${dbUser.pterodactylId}`);
        const pteroUser = pteroResponse.data?.attributes;
        if (pteroUser) {
          pteroUsername = pteroUser.username || pteroUsername;
          pteroEmail = pteroUser.email || pteroEmail;
          pteroFirstName = pteroUser.first_name || null;
          pteroLastName = pteroUser.last_name || null;
          pteroRootAdmin = Boolean(pteroUser.root_admin);
          pteroCreatedAt = pteroUser.created_at || pteroCreatedAt;
        }
      } catch (pteroError) {
        console.warn('Could not fetch Pterodactyl user:', pteroError.message);
      }
    }

    // Fetch all servers and filter by this user
    let ownedServers = [];
    try {
      const perPage = 100;
      const allServers = [];
      let page = 1;

      while (page <= 100) {
        const serversResponse = await pteroApi.get(`/api/application/servers?page=${page}&per_page=${perPage}&include=node`);
        const pageServers = serversResponse.data?.data || [];

        allServers.push(...pageServers);

        if (pageServers.length < perPage) {
          break;
        }

        page += 1;
      }

      ownedServers = allServers
        .filter(server => server.attributes?.user === dbUser.pterodactylId)
        .map(server => ({
          id: server.attributes.id,
          name: server.attributes.name,
          identifier: server.attributes.identifier,
          uuid: server.attributes.uuid,
          suspended: Boolean(server.attributes.suspended),
          limits: {
            memory: server.attributes?.limits?.memory || 0,
            disk: server.attributes?.limits?.disk || 0,
            cpu: server.attributes?.limits?.cpu || 0
          },
          node: server.attributes?.relationships?.node?.data?.attributes?.name || 'Unknown',
          status: server.attributes.status,
          internalId: server.attributes.internal_id
        }));
    } catch (serversError) {
      console.warn('Could not fetch servers:', serversError.message);
    }

    const customer = {
      id: dbUser.id,
      pterodactylId: dbUser.pterodactylId,
      username: pteroUsername,
      email: pteroEmail,
      firstName: pteroFirstName,
      lastName: pteroLastName,
      rootAdmin: pteroRootAdmin,
      createdAt: pteroCreatedAt,
      coins: dbUser.coins || 0,
      packageName: dbUser.packageName || defaultPackage,
      packageRAM,
      packageDisk,
      packageCpu,
      packageServers,
      extraRAM: dbUser.extraRam || 0,
      extraDisk: dbUser.extraDisk || 0,
      extraCpu: dbUser.extraCpu || 0,
      extraServers: dbUser.extraServers || 0,
      totalRAM: packageRAM + (dbUser.extraRam || 0),
      totalDisk: packageDisk + (dbUser.extraDisk || 0),
      totalCpu: packageCpu + (dbUser.extraCpu || 0),
      totalServers: packageServers + (dbUser.extraServers || 0)
    };

    return { customer, ownedServers };
  } catch (error) {
    console.error('Error fetching admin ticket data:', error);
    return { customer: fallbackCustomer, ownedServers: fallbackServers };
  }
}
