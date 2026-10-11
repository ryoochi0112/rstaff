'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Copy a plugin dir to a temp root and strip `dependencies` from its manifest,
// so evals can load it without its sibling-plugin deps.
function buildEvalCopy(srcPluginDir, tmpRoot) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpRoot, 'copy-'));
  const pluginDir = path.join(root, path.basename(srcPluginDir));
  fs.cpSync(srcPluginDir, pluginDir, { recursive: true, verbatimSymlinks: true });
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.dependencies;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { root, pluginDir };
}

function removeEvalCopy(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { buildEvalCopy, removeEvalCopy };
