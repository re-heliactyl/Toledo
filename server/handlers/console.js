/**
 * @fileoverview Compact Rust-inspired logging system for Heliactyl Next
 * @module handlers/console
 * @version 3.0.0
 */

const chalk = require('chalk');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

// Create logs directory if it doesn't exist
if (!fsSync.existsSync(path.join(process.cwd(), 'logs'))) {
  fsSync.mkdirSync(path.join(process.cwd(), 'logs'));
}

/**
 * Error filter patterns
 */
const ERROR_FILTERS = {
  patterns: [
    "'app' is missing 'framework'",
    "Bun.serve() needs either",
    "routes object",
    "fetch handler",
    "ERR_INVALID_ARG_TYPE",
    "Learn more at https://bun.sh/docs/api/http",
    "TypeError: Bun.serve()",
    "Or a fetch handler"
  ],

  shouldFilter: (error) => {
    if (!error) return false;
    const errorString = typeof error === 'string'
      ? error
      : error.message || error.stack || JSON.stringify(error);
    return ERROR_FILTERS.patterns.some(pattern => errorString.includes(pattern));
  }
};

/**
 * Logger class with Rust-like formatting
 */
class RustStyleLogger {
  constructor() {
    this.logFile = path.join('logs', 'combined.log');
    this.errorFile = path.join('logs', 'error.log');

    // Intercept console methods
    this.interceptConsole();

    // Intercept process errors
    this.setupProcessHandlers();
  }

  /**
   * Format timestamp like "2025-05-14 12:55:40"
   */
  getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Format log message with timestamp, level, and message
   */
  formatLogMessage(level, message, color = '#ffffff') {
    const timestamp = this.getTimestamp();
    const formattedTimestamp = chalk.hex('#888888')(timestamp);
    const formattedLevel = chalk.hex(color)(level.padEnd(3));

    return `${formattedTimestamp} ${message}`;
  }

  /**
   * Write log to console and file
   */
  log(level, message, metadata = {}, color = '#ffffff') {
    // Skip filtered errors
    if (level === 'ERR' && ERROR_FILTERS.shouldFilter(message)) {
      return;
    }

    // Format message with metadata
    let formattedMessage = message;
    if (metadata && Object.keys(metadata).length > 0) {
      formattedMessage += ` ${JSON.stringify(metadata)}`;
    }

    // Console output with color
    const consoleMessage = this.formatLogMessage(level, formattedMessage, color);
    process.stdout.write(consoleMessage + '\n');

    // File output without color
    const fileMessage = `${this.getTimestamp()} ${level} ${formattedMessage}`;
    fs.appendFile(this.logFile, fileMessage + '\n').catch(() => { });

    // Write errors to error log
    if (level === 'ERR') {
      fs.appendFile(this.errorFile, fileMessage + '\n').catch(() => { });
    }
  }

  /**
   * Log info message
   */
  info(message, metadata = {}) {
    this.log('INF', message, metadata, '#00b0ff');
  }

  /**
   * Log debug message
   */
  debug(message, metadata = {}) {
    this.log('DBG', message, metadata, '#9e9e9e');
  }

  /**
   * Log warning message
   */
  warn(message, metadata = {}) {
    this.log('WRN', message, metadata, '#ffae00');
  }

  /**
   * Log error message
   */
  error(message, error = {}) {
    let errorMessage = message;
    let metadata = {};

    if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
      metadata.stack = error.stack;
    } else if (typeof error === 'object') {
      metadata = error;
    } else if (error) {
      errorMessage += `: ${error}`;
    }

    this.log('ERR', errorMessage, metadata, '#ff4b4b');
  }

  /**
   * Express request logger middleware
   */
  requestLogger() {
    return (req, res, next) => {
      const startTime = process.hrtime();

      // Record response finish
      res.on('finish', () => {
        const hrTime = process.hrtime(startTime);
        const duration = (hrTime[0] * 1000 + hrTime[1] / 1000000).toFixed(2);

        let color = '#00b0ff'; // Default blue
        if (res.statusCode >= 500) color = '#ff4b4b';
        else if (res.statusCode >= 400) color = '#ffae00';
        else if (res.statusCode >= 300) color = '#9e9e9e';
        else if (res.statusCode >= 200) color = '#00c853';

        // Create HTTP log message similar to the rust format
        const httpMethod = chalk.hex(color)(req.method);
        this.log('INF', `${httpMethod} ${req.originalUrl} ${chalk.gray('(' + res.statusCode + ', ' + duration + 'ms)')}`);
      });

      next();
    };
  }

  /**
   * Track requests with websocket
   */
  wsRequestLogger(req, ws, next) {
    this.log('INF', `WS ${req.originalUrl}`, {}, '#00b0ff');
    next();
  }

  /**
   * Override console methods
   */
  interceptConsole() {
    const originalConsoleLog = console.log;
    const originalConsoleInfo = console.info;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    const originalConsoleDebug = console.debug;

    console.log = (...args) => {
      const message = args
        .map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))
        .join(' ');

      if (!ERROR_FILTERS.shouldFilter(message)) {
        this.info(message);
      }
    };

    console.info = (...args) => {
      const message = args
        .map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))
        .join(' ');

      this.info(message);
    };

    console.warn = (...args) => {
      const message = args
        .map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))
        .join(' ');

      if (!ERROR_FILTERS.shouldFilter(message)) {
        this.warn(message);
      }
    };

    console.error = (...args) => {
      if (args.length === 0) return;

      const message = args[0];
      const error = args.length > 1 ? args[1] : null;

      if (!ERROR_FILTERS.shouldFilter(message) && !ERROR_FILTERS.shouldFilter(error)) {
        this.error(message, error);
      }
    };

    console.debug = (...args) => {
      const message = args
        .map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))
        .join(' ');

      this.debug(message);
    };
  }

  /**
   * Setup process error handlers
   */
  setupProcessHandlers() {
    const errorHandler = (error) => {
      if (ERROR_FILTERS.shouldFilter(error)) {
        return;
      }
      this.error('Process error', error);
    };

    // Remove existing listeners
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    // Add filtered handlers
    process.on('uncaughtException', errorHandler);
    process.on('unhandledRejection', errorHandler);
  }
}

/**
 * Create and export logger instance
 */
function createLogger() {
  return new RustStyleLogger();
}

module.exports = createLogger;