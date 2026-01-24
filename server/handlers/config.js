const fs = require('fs');
const toml = require('@iarna/toml');
const path = require('path');
const chokidar = require('chokidar');

/**
 * Global cache for configuration objects and their watchers.
 * key: absolute path
 * value: { data: Object, watcher: ChokidarWatcher }
 */
const configStore = new Map();

/**
 * Deeply updates a target object with properties from a source object
 * while maintaining the target object's reference.
 * 
 * @param {Object} target - The object to update
 * @param {Object} source - The object containing new values
 */
function updateObjectInPlace(target, source) {
  // Remove keys that no longer exist in source
  Object.keys(target).forEach(key => {
    if (!(key in source)) {
      delete target[key];
    }
  });

  // Update or add keys from source
  Object.keys(source).forEach(key => {
    const value = source[key];

    // If both are objects (and not null), recurse
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      updateObjectInPlace(target[key], value);
    } else {
      target[key] = value;
    }
  });
}

/**
 * Loads and parses a TOML file and returns a "live" JSON object.
 * This object's reference remains the same, but its properties update automatically
 * when the source file changes.
 *
 * @param {string} filePath - The path to the TOML file.
 * @returns {Object} - The "live" configuration object.
 */
function loadConfig(filePath = 'config.toml') {
  const fullPath = path.resolve(filePath);

  // Return existing live object if already watching
  if (configStore.has(fullPath)) {
    return configStore.get(fullPath).data;
  }

  try {
    // Initial load
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Config file not found: ${fullPath}`);
    }

    const tomlString = fs.readFileSync(fullPath, 'utf8');
    const configData = toml.parse(tomlString);

    // Setup chokidar watcher
    const watcher = chokidar.watch(fullPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
      }
    });

    watcher.on('change', () => {
      try {
        const updatedTomlString = fs.readFileSync(fullPath, 'utf8');
        const updatedConfig = toml.parse(updatedTomlString);

        // Update the cached object in place so all modules referencing it see the change
        updateObjectInPlace(configData, updatedConfig);
      } catch (err) {
        console.error(`\x1b[31m[CONFIG] Hot-reload failed for ${path.basename(fullPath)}: ${err.message}\x1b[0m`);
      }
    });

    watcher.on('error', (error) => {
      console.error(`[CONFIG] Watcher error for ${fullPath}:`, error);
    });

    // Store the reference and watcher
    configStore.set(fullPath, {
      data: configData,
      watcher: watcher
    });

    return configData;
  } catch (err) {
    console.error(`[CONFIG] Initial load failed for ${fullPath}:`, err);
    throw err;
  }
}

// Ensure watchers are closed on exit
process.on('exit', () => {
  for (const entry of configStore.values()) {
    entry.watcher.close();
  }
});

module.exports = loadConfig;