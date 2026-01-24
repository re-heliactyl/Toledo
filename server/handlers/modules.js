"use strict";

const fs = require("fs").promises;
const path = require("path");
const semver = require("semver");
const createLogger = require("../handlers/console.js");
const logger = createLogger();

class ModuleLoader {
  constructor(app, db, platformVersion, apiLevel) {
    this.app = app;
    this.db = db;
    this.platformVersion = platformVersion;
    this.apiLevel = apiLevel;
    this.logger = logger;
    this.loadedModules = new Map();
    this.moduleRegistry = new Map();
    this.modulesDir = path.join(__dirname, "..", "modules");
  }

  /**
   * Validates a module manifest against the schema
   * @param {Object} manifest - The module manifest object
   * @param {string} moduleId - The module ID for error reporting
   * @returns {boolean} - Whether the manifest is valid
   */
  validateManifest(manifest, moduleId) {
    if (!manifest) {
      this.logger.error(`Module ${moduleId} is missing a manifest`);
      return false;
    }

    // Required fields
    const requiredFields = ["name", "version", "api_level", "target_platform"];
    for (const field of requiredFields) {
      if (!manifest[field]) {
        this.logger.error(`Module ${moduleId} is missing required manifest field: ${field}`);
        return false;
      }
    }

    // API level check
    if (manifest.api_level > this.apiLevel) {
      this.logger.error(`Module ${moduleId} requires API level ${manifest.api_level}, but platform only supports ${this.apiLevel}`);
      return false;
    }

    // Platform version check
    if (!semver.satisfies(this.platformVersion, manifest.target_platform)) {
      this.logger.error(`Module ${moduleId} targets platform ${manifest.target_platform}, but current platform is ${this.platformVersion}`);
      return false;
    }

    return true;
  }

  /**
   * Recursively discovers modules in the modules directory and subdirectories
   * @returns {Promise<Array<{id: string, path: string}>>} - List of discovered modules
   */
  async discoverModules() {
    const modules = [];

    /**
     * Recursive function to scan directories for modules
     * @param {string} dir - Directory to scan
     * @param {string} baseDir - Base modules directory for ID calculation
     */
    const scanDirectory = async (dir, baseDir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Recursively scan subdirectory
            await scanDirectory(fullPath, baseDir);
          } else if (entry.isFile() && entry.name.endsWith(".js")) {
            // Calculate the module ID relative to the base modules directory
            const relativePath = path.relative(baseDir, fullPath);
            const moduleId = path.dirname(relativePath) === "."
              ? path.basename(relativePath, ".js")
              : path.dirname(relativePath) + "/" + path.basename(relativePath, ".js");

            modules.push({
              id: moduleId,
              path: fullPath
            });
          }
        }
      } catch (error) {
        this.logger.error(`Error scanning directory ${dir}:`, error);
      }
    };

    await scanDirectory(this.modulesDir, this.modulesDir);
    return modules;
  }

  /**
   * Sorts modules based on dependencies
   * @param {Map<string, Object>} moduleMap - Map of module IDs to module data
   * @returns {Array<string>} - Sorted list of module IDs
   */
  sortModulesByDependency(moduleMap) {
    const visited = new Set();
    const visiting = new Set();
    const sorted = [];

    const visit = (moduleId) => {
      if (visited.has(moduleId)) return;
      if (visiting.has(moduleId)) {
        this.logger.error(`Circular dependency detected involving module ${moduleId}`);
        return;
      }

      visiting.add(moduleId);

      const module = moduleMap.get(moduleId);
      if (module && module.manifest.dependencies) {
        for (const dep of module.manifest.dependencies) {
          if (!moduleMap.has(dep.name)) {
            if (dep.optional) {
              this.logger.warn(`Optional dependency ${dep.name} for module ${moduleId} not found`);
            } else {
              this.logger.error(`Required dependency ${dep.name} for module ${moduleId} not found`);
            }
            continue;
          }

          visit(dep.name);
        }
      }

      visiting.delete(moduleId);
      visited.add(moduleId);
      sorted.push(moduleId);
    };

    for (const moduleId of moduleMap.keys()) {
      visit(moduleId);
    }

    return sorted;
  }

  /**
   * Loads a single module
   * @param {string} moduleId - The module ID
   * @param {string} modulePath - Path to the module file
   * @returns {Promise<boolean>} - Whether the module was loaded successfully
   */
  async loadModule(moduleId, modulePath) {
    try {
      // Clear require cache to ensure fresh load
      delete require.cache[require.resolve(modulePath)];

      const moduleExports = require(modulePath);

      if (!moduleExports.HeliactylModule) {
        this.logger.error(`Module ${moduleId} is missing HeliactylModule manifest`);
        return false;
      }

      if (!this.validateManifest(moduleExports.HeliactylModule, moduleId)) {
        return false;
      }

      if (!moduleExports.load || typeof moduleExports.load !== 'function') {
        //this.logger.error(`Module ${moduleId} is missing load function`);
        return false;
      }

      // Store in registry for dependency resolution
      this.moduleRegistry.set(moduleId, {
        id: moduleId,
        path: modulePath,
        exports: moduleExports,
        manifest: moduleExports.HeliactylModule
      });

      return true;
    } catch (error) {
      this.logger.error(`Error loading module ${moduleId}:`, error);
      return false;
    }
  }

  /**
   * Initializes a single module by calling its load function
   * @param {string} moduleId - The module ID
   * @returns {Promise<boolean>} - Whether the module was initialized successfully
   */
  async initializeModule(moduleId) {
    const module = this.moduleRegistry.get(moduleId);
    if (!module) return false;

    try {
      //this.logger.info(`Initializing module: ${module.manifest.name} (${moduleId})`);
      await module.exports.load(this.app, this.db);
      this.loadedModules.set(moduleId, module);
      //this.logger.info(`Successfully loaded module: ${module.manifest.name} v${module.manifest.version}`);
      return true;
    } catch (error) {
      this.logger.error(`Error initializing module ${moduleId}:`, error);
      return false;
    }
  }

  /**
   * Loads all modules from the modules directory and subdirectories
   * @returns {Promise<Map<string, Object>>} - Map of loaded modules
   */
  async loadAllModules() {
    //this.logger.info("Discovering modules...");
    const discoveredModules = await this.discoverModules();
    //this.logger.info(`Found ${discoveredModules.length} modules`);

    // Load module definitions
    for (const { id, path } of discoveredModules) {
      await this.loadModule(id, path);
    }

    // Sort modules by dependency
    const sortedModuleIds = this.sortModulesByDependency(this.moduleRegistry);

    // Initialize modules in order
    for (const moduleId of sortedModuleIds) {
      await this.initializeModule(moduleId);
    }

    return this.loadedModules;
  }

  /**
   * Gets information about all loaded modules
   * @returns {Array<Object>} - Array of module information objects
   */
  getLoadedModuleInfo() {
    const moduleInfo = [];
    for (const [id, module] of this.loadedModules.entries()) {
      moduleInfo.push({
        id,
        name: module.manifest.name,
        version: module.manifest.version,
        apiLevel: module.manifest.api_level,
        description: module.manifest.description || "No description",
        author: module.manifest.author || "Unknown"
      });
    }
    return moduleInfo;
  }
}

module.exports = ModuleLoader;