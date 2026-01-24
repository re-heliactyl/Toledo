/**
 *  Heliactyl Next database handler
 */

/**
 * @module HeliactylNextDB
 * @version 0.4.0
 * @description SQLite database adapter for Heliactyl Next 4.x with big fancy features or something.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const winston = require('winston');

// Configure Winston logger
const dbLogger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/db.log' })
  ]
});

/**
 * @class HeliactylDB
 * @description Main database class that handles all database operations with queuing and TTL support
 */
class HeliactylDB {
  /**
   * @constructor
   * @param {string} dbPath - Path to SQLite database file (obviously)
   * @throws {Error} If database path is not provided or connection fails... 
   */
  constructor(dbPath) {
    if (!dbPath) {
      throw new Error('Database path is required');
    }

    const resolvedPath = path.resolve(dbPath.replace('sqlite://', ''));
    this.db = new sqlite3.Database(resolvedPath, (err) => {
      if (err) {
        throw new Error(`Failed to connect to database: ${err.message}`);
      }
    });

    this.namespace = 'heliactyl';
    this.ttlSupport = false;
    this.queue = [];
    this.isProcessing = false;
    this.totalOperationTime = 0;
    this.operationCount = 0;
    this.maxQueueSize = 10000; // Prevent unbounded queue growth
    this.tableName = 'heliactyl'; // Default table name

    // Enable WAL mode for better concurrency
    this.db.run('PRAGMA journal_mode = WAL');

    // Initialize the database table
    this.initializeDatabase().catch(err => {
      console.error('Failed to initialize database:', err);
    });

    // Log queue stats every 5 seconds
    setInterval(() => this.logQueueStats(), 5000);

    // Cleanup expired entries periodically if TTL is supported
    if (this.ttlSupport) {
      setInterval(() => this.cleanupExpired(), 60000);
    }
  }

  /**
   * @async
   * @method initializeDatabase
   * @description Initializes database tables and indexes
   * @returns {Promise<void>}
   */
  async initializeDatabase() {
    return this.executeQuery(() => new Promise((resolve, reject) => {
      // First check if keyv table exists
      this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='keyv'", (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (row) {
          console.log('Using Heliactyl Next Legacy compatibility mode - Found existing keyv database');
          this.tableName = 'keyv';
          this.namespace = 'keyv';
          resolve();
          return;
        }

        // Create Heliactyl Next table if keyv doesn't exist
        const createTableSQL = `
          CREATE TABLE IF NOT EXISTS heliactyl (
            [key] TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
          )`;

        this.db.serialize(() => {
          this.db.run('BEGIN TRANSACTION');
          this.db.run(createTableSQL, (err) => {
            if (err) {
              this.db.run('ROLLBACK');
              reject(err);
              return;
            }

            this.db.run('CREATE INDEX IF NOT EXISTS idx_heliactyl_key ON heliactyl ([key])', (indexErr) => {
              if (indexErr) {
                this.db.run('ROLLBACK');
                reject(indexErr);
                return;
              }

              this.db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
            });
          });
        });
      });
    }));
  }

  /**
   * @async
   * @method executeQuery
   * @description Executes a database operation with queuing and timeout
   * @param {Function} operation - Database operation to execute
   * @returns {Promise<any>} Result of the operation
   * @throws {Error} If queue is full or operation times out
   */
  async executeQuery(operation) {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Database queue is full');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Database operation timed out'));
      }, 30000); // 30 second timeout

      this.queue.push({
        operation,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  /**
   * @async
   * @method processQueue
   * @description Processes the next operation in the queue
   * @private
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const { operation, resolve, reject } = this.queue.shift();

    const startTime = Date.now();

    try {
      const result = await operation();
      const operationTime = Date.now() - startTime;
      this.updateStats(operationTime);

      // Log successful transaction
      dbLogger.info('Database transaction completed', {
        operationTime,
        queueLength: this.queue.length
      });

      resolve(result);
    } catch (error) {
      // Log failed transaction
      dbLogger.error('Database transaction failed', {
        error: error.message,
        queueLength: this.queue.length
      });

      console.error('Database operation failed:', error);
      reject(error);
    } finally {
      this.isProcessing = false;
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * @method updateStats
   * @description Updates operation statistics
   * @param {number} operationTime - Time taken for operation in milliseconds
   * @private
   */
  updateStats(operationTime) {
    this.totalOperationTime += operationTime;
    this.operationCount++;

    // Reset stats periodically to prevent overflow
    if (this.operationCount > 1000000) {
      this.totalOperationTime = operationTime;
      this.operationCount = 1;
    }
  }

  /**
   * @method logQueueStats
   * @description Logs queue statistics
   * @private
   */
  logQueueStats() {
    const avgOperationTime = this.operationCount > 0 ? this.totalOperationTime / this.operationCount : 0;
    dbLogger.info('Queue statistics', {
      queueLength: this.queue.length,
      averageOperationTime: avgOperationTime.toFixed(2)
    });
  }

  /**
   * @async
   * @method cleanupExpired
   * @description Removes expired entries from database
   * @returns {Promise<void>}
   */
  async cleanupExpired() {
    if (!this.ttlSupport) return;

    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM ${this.tableName} WHERE json_extract(value, "$.expires") < ?`, [Date.now()], (err) => {
        if (err) reject(err);
        else resolve();
      });
    }));
  }

  /**
   * @async
   * @method get
   * @description Retrieves a value by key
   * @param {string} key - Key to retrieve
   * @returns {Promise<any>} Retrieved value
   * @throws {Error} If key is not provided or value parsing fails
   */
  async get(key) {
    if (!key) throw new Error('Key is required');

    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.get(`SELECT value FROM ${this.tableName} WHERE [key] = ?`, [`${this.namespace}:${key}`], (err, row) => {
        if (err) {
          reject(err);
        } else {
          if (row) {
            try {
              const parsed = JSON.parse(row.value);
              if (this.ttlSupport && parsed.expires && parsed.expires < Date.now()) {
                this.delete(key).catch(console.error);
                resolve(undefined);
              } else {
                resolve(parsed.value);
              }
            } catch (e) {
              reject(new Error(`Failed to parse stored value: ${e.message}`));
            }
          } else {
            resolve(undefined);
          }
        }
      });
    }));
  }

  /**
   * @async
   * @method set
   * @description Sets a value with optional TTL
   * @param {string} key - Key to set
   * @param {any} value - Value to store
   * @param {number} [ttl] - Time-to-live in milliseconds
   * @returns {Promise<void>}
   * @throws {Error} If key is not provided
   */
  async set(key, value, ttl) {
    if (!key) throw new Error('Key is required');

    const expires = this.ttlSupport && ttl ? Date.now() + ttl : undefined;
    const data = JSON.stringify({
      value,
      expires
    });

    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.run(`INSERT OR REPLACE INTO ${this.tableName} ([key], value) VALUES (?, ?)`, [`${this.namespace}:${key}`, data], (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    }));
  }

  /**
   * @async
   * @method delete
   * @description Deletes a value by key
   * @param {string} key - Key to delete
   * @returns {Promise<void>}
   * @throws {Error} If key is not provided
   */
  async delete(key) {
    if (!key) throw new Error('Key is required');

    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM ${this.tableName} WHERE [key] = ?`, [`${this.namespace}:${key}`], (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    }));
  }

  /**
   * @async
   * @method clear
   * @description Clears all values in the current namespace
   * @returns {Promise<void>}
   */
  async clear() {
    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM ${this.tableName} WHERE [key] LIKE ?`, [`${this.namespace}:%`], (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    }));
  }

  /**
   * @async
   * @method has
   * @description Checks if a key exists
   * @param {string} key - Key to check
   * @returns {Promise<boolean>} True if key exists
   * @throws {Error} If key is not provided
   */
  async has(key) {
    if (!key) throw new Error('Key is required');

    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.get(`SELECT 1 FROM ${this.tableName} WHERE [key] = ?`, [`${this.namespace}:${key}`], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(!!row);
        }
      });
    }));
  }

  /**
   * @async
   * @method close
   * @description Closes database connection
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * @async
   * @method getAll
   * @description Retrieves all key-value pairs in the current namespace
   * @returns {Promise<Object>} Object containing all key-value pairs
   */
  async getAll() {
    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.all(`SELECT [key], value FROM ${this.tableName} WHERE [key] LIKE ?`, [`${this.namespace}:%`], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const result = {};
          rows.forEach(row => {
            const key = row.key.replace(`${this.namespace}:`, '');
            try {
              const parsed = JSON.parse(row.value);
              if (!(this.ttlSupport && parsed.expires && parsed.expires < Date.now())) {
                result[key] = parsed.value;
              }
            } catch (e) {
              console.error(`Failed to parse value for key ${key}:`, e);
            }
          });
          resolve(result);
        }
      });
    }));
  }

  /**
   * @async
   * @method increment
   * @description Increments a numeric value by the specified amount
   * @param {string} key - Key to increment
   * @param {number} [amount=1] - Amount to increment by
   * @returns {Promise<number>} New value after increment
   */
  async increment(key, amount = 1) {
    const currentValue = await this.get(key) || 0;
    if (typeof currentValue !== 'number') {
      throw new Error('Value must be a number to increment');
    }
    const newValue = currentValue + amount;
    await this.set(key, newValue);
    return newValue;
  }

  /**
   * @async
   * @method decrement
   * @description Decrements a numeric value by the specified amount
   * @param {string} key - Key to decrement
   * @param {number} [amount=1] - Amount to decrement by
   * @returns {Promise<number>} New value after decrement
   */
  async decrement(key, amount = 1) {
    return this.increment(key, -amount);
  }

  /**
   * @async
   * @method search
   * @description Searches for keys matching a pattern
   * @param {string} pattern - Search pattern (SQL LIKE pattern)
   * @returns {Promise<string[]>} Array of matching keys
   */
  async search(pattern) {
    return this.executeQuery(() => new Promise((resolve, reject) => {
      this.db.all(
        `SELECT [key] FROM ${this.tableName} WHERE [key] LIKE ?`,
        [`${this.namespace}:${pattern}`],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows.map(row => row.key.replace(`${this.namespace}:`, '')));
          }
        }
      );
    }));
  }

  /**
   * @async
   * @method setMultiple
   * @description Sets multiple key-value pairs at once
   * @param {Object} entries - Object containing key-value pairs to set
   * @param {number} [ttl] - Optional TTL for all entries
   * @returns {Promise<void>}
   */
  async setMultiple(entries, ttl) {
    return this.executeQuery(() => new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${this.tableName} ([key], value) VALUES (?, ?)`);

      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');

        try {
          for (const [key, value] of Object.entries(entries)) {
            const data = JSON.stringify({
              value,
              expires: this.ttlSupport && ttl ? Date.now() + ttl : undefined
            });
            stmt.run(`${this.namespace}:${key}`, data);
          }

          this.db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          this.db.run('ROLLBACK');
          reject(err);
        } finally {
          stmt.finalize();
        }
      });
    }));
  }
}

module.exports = HeliactylDB;