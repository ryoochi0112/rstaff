'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// A registered plugin switched off in settings.json is treated as absent.
// Missing, unreadable, or oddly shaped settings count as enabled.
function disabled(configDir, id) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    const enabled = settings && settings.enabledPlugins;
    return !!enabled && typeof enabled === 'object' && enabled[id] === false;
  } catch (_) {
    return false;
  }
}

function locate(name, { configDir, selfRoot } = {}) {
  try {
    configDir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    selfRoot = selfRoot || path.resolve(__dirname, '..');
    try {
      const registry = JSON.parse(fs.readFileSync(
        path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
      const plugins = registry && registry.plugins;
      if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
        let marketplace = 'rstaff';
        for (const [key, entries] of Object.entries(plugins)) {
          if (!Array.isArray(entries)) continue;
          if (entries.some(entry => entry && typeof entry.installPath === 'string'
            && path.resolve(entry.installPath) === path.resolve(selfRoot))) {
            marketplace = key.slice(key.lastIndexOf('@') + 1);
            break;
          }
        }
        const entries = plugins[`${name}@${marketplace}`];
        if (Array.isArray(entries) && !disabled(configDir, `${name}@${marketplace}`)) {
          for (const entry of entries) {
            if (entry && typeof entry.installPath === 'string' && fs.existsSync(entry.installPath)) {
              return entry.installPath;
            }
          }
        }
      }
    } catch (_) {}
    const sibling = path.join(selfRoot, '..', name);
    if (fs.existsSync(path.join(sibling, '.claude-plugin', 'plugin.json'))) return sibling;
  } catch (_) {}
  return null;
}

module.exports = { locate };

if (require.main === module) {
  const resolved = locate(process.argv[2]);
  if (resolved) process.stdout.write(resolved + '\n');
  process.exitCode = resolved ? 0 : 1;
}
