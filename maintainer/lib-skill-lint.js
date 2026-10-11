#!/usr/bin/env node
// Structural lint for rstaff skills, commands, and agents — Node built-ins only.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_DESCRIPTION = 1536;
const MAX_LINES = 500;

// Edits must be conscious convention decisions; keep this in sync with the
// all skill directories under plugins/*/skills/.
const SKILL_ROSTER = [
  'agent-evaluation',
  'data-science',
  'datadog-llmobs-analysis',
  'experiment-design',
  'grilling',
  'harness-validation',
  'parallel-build',
  'token-efficient-delegation',
];

// Pinned superpowers skills rstaff may cite; changes are conscious convention decisions.
// Keep in sync with Required disciplines in engineer rules/superpowers-precedence.md.
const PEER_TABLE_SKILLS = [
  'superpowers:test-driven-development',
  'superpowers:systematic-debugging',
  'superpowers:verification-before-completion',
  'superpowers:receiving-code-review',
  'superpowers:brainstorming',
];

// Edits must be conscious convention decisions; these are live-tree references
// beyond the required disciplines; each pin has a deliberate convention reason.
const PEER_EXTRA_SKILLS = [
  // The planning command names this as its planning discipline.
  'superpowers:writing-plans',
  // parallel-build and superpowers-precedence.md contrast this sibling explicitly.
  'superpowers:subagent-driven-development',
];

// Retain the T2 interface name as the table pin; R3 checks the table plus extras.
const PEER_SKILL_ALLOWLIST = PEER_TABLE_SKILLS;

// Edits must be conscious convention decisions.
const EXTERNAL_COMMAND_ALLOWLIST = [
  // Host browser tooling supplies this command; the QA description references it.
  '/browse',
];

// Edits must be conscious convention decisions; these skills are supplied by
// the host and are cited conditionally by live plugin prose.
const EXTERNAL_SKILL_ALLOWLIST = [
  'deep-research',
  'prompt-iteration',
  'security-review',
];

function normalizeNewlines(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

function failure(error) {
  return { ok: false, data: {}, error };
}

function isBlockScalar(value) {
  // Reject the flat-file forms of YAML's block scalar indicators. Any
  // continuation line is rejected by the key/value check below as well.
  return /^[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)?$/.test(value);
}

function parseFrontmatter(text) {
  const lines = normalizeNewlines(text).split('\n');
  if (lines[0] !== '---') return failure('frontmatter must start with ---');

  const data = {};
  let closingLine = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') {
      closingLine = i;
      break;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!match) return failure(`invalid frontmatter line ${i + 1}`);

    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return failure(`duplicate frontmatter key: ${key}`);
    }

    const value = match[2].trim();
    if (isBlockScalar(value)) return failure(`multiline frontmatter value for: ${key}`);
    Object.defineProperty(data, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  if (closingLine < 0) return failure('unterminated frontmatter block');
  return { ok: true, data, error: null };
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) {
    return [];
  }
}

function violation(code, file, detail) {
  return { code, file, detail };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function bodyAfterFrontmatter(text) {
  const lines = normalizeNewlines(text).split('\n');
  if (lines[0] !== '---') return '';
  const closingLine = lines.findIndex((line, index) => index > 0 && line === '---');
  return closingLine < 0 ? '' : lines.slice(closingLine + 1).join('\n');
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function containsLiteralToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9._-])${escaped}(?=$|[^A-Za-z0-9._-])`).test(text);
}

function referenceBasenames(body) {
  const matches = new Set();
  const pattern = /(?<!\/)\breferences\/([A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9_-]*)\b/g;
  for (const match of body.matchAll(pattern)) matches.add(match[1]);
  return matches;
}

function lintSkillReferences(item, text) {
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return [];

  const violations = [];
  const body = bodyAfterFrontmatter(text);
  const referencesDir = path.join(path.dirname(item.file), 'references');
  const cited = referenceBasenames(body);

  for (const basename of cited) {
    if (!isFile(path.join(referencesDir, basename))) {
      violations.push(violation(
        'R1',
        item.file,
        `referenced file does not exist: references/${basename}`,
      ));
    }
  }

  for (const entry of entries(referencesDir)) {
    if (!entry.isFile()) continue;
    const referencePath = `references/${entry.name}`;
    if (!containsLiteralToken(body, referencePath) && !containsLiteralToken(body, entry.name)) {
      violations.push(violation(
        'R2',
        path.join(referencesDir, entry.name),
        `reference file is not mentioned in ${path.basename(item.file)}: ${entry.name}`,
      ));
    }
  }
  return violations;
}

function markdownFiles(root, directories) {
  const files = [];
  function walk(dir) {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(file);
      }
    }
  }
  for (const directory of directories) walk(path.join(root, directory));
  return files;
}

function lintPeerReferences(root) {
  const violations = [];
  const allowed = new Set([...PEER_TABLE_SKILLS, ...PEER_EXTRA_SKILLS]);
  const pattern = /\bsuperpowers:[a-z][a-z0-9-]*\b/g;
  for (const file of markdownFiles(root, ['skills', 'commands', 'agents', 'rules', 'templates'])) {
    const text = readText(file);
    if (text == null) continue;
    for (const match of text.matchAll(pattern)) {
      if (allowed.has(match[0])) continue;
      violations.push(violation(
        'R3',
        file,
        `superpowers skill is not in the pinned allowlist: ${match[0]}`,
      ));
    }
  }
  return violations;
}

// Accept a repo, its plugins/ directory, or a standalone plugin fixture.
function pluginRoots(root) {
  const pluginsDir = isDirectory(path.join(root, 'plugins')) ? path.join(root, 'plugins')
    : path.basename(root) === 'plugins' ? root : null;
  if (!pluginsDir) return [root];
  return entries(pluginsDir)
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(pluginsDir, entry.name));
}

function skillDirectory(root, name) {
  return pluginRoots(root).map(base => path.join(base, 'skills', name))
    .find(dir => isDirectory(dir)) || path.join(root, 'skills', name);
}

function lintSkillRoster(root) {
  const skillsDir = path.join(root, 'skills');
  const actualNames = pluginRoots(root).flatMap(base => entries(path.join(base, 'skills'))
    .filter(entry => entry.isDirectory()).map(entry => entry.name));
  const pinnedNames = [...SKILL_ROSTER];
  const actual = new Set(actualNames);
  const pinned = new Set(pinnedNames);
  const violations = [];

  if (pinnedNames.length === 0) {
    violations.push(violation(
      'S2',
      skillsDir,
      'SKILL_ROSTER must not be empty',
    ));
  }
  if (actualNames.length === 0) {
    violations.push(violation(
      'S2',
      skillsDir,
      'skills directory must not be empty',
    ));
  }
  if (pinned.size !== pinnedNames.length) {
    violations.push(violation(
      'S2',
      skillsDir,
      'SKILL_ROSTER must not contain duplicate names',
    ));
  }

  for (const name of actualNames) {
    if (pinned.has(name)) continue;
    violations.push(violation(
      'S2',
      skillDirectory(root, name),
      `skill directory is not pinned in SKILL_ROSTER: ${name}`,
    ));
  }
  for (const name of pinnedNames) {
    if (actual.has(name)) continue;
    violations.push(violation(
      'S2',
      skillDirectory(root, name),
      `pinned skill directory is missing: ${name}`,
    ));
  }
  return violations;
}

function stripFencedCode(text) {
  return normalizeNewlines(text).replace(/```[\s\S]*?```/g, '');
}

function stripDescriptionCode(text) {
  return stripFencedCode(text)
    .replace(/`[^`\r\n]*`/g, '');
}

function pluginName(base) {
  const text = readText(path.join(base, '.claude-plugin', 'plugin.json'));
  if (text) {
    try {
      const manifestName = JSON.parse(text).name;
      if (typeof manifestName === 'string' && manifestName.trim()) return manifestName;
    } catch (_) {
      // A malformed manifest is reported by plugin validation; path lint still
      // uses the directory name so one bad manifest does not hide other errors.
    }
  }
  return path.basename(base);
}

function namespaceRoot(root, namespace) {
  return pluginRoots(root).find(base => pluginName(base) === namespace) || null;
}

function hasPluginUnit(base, name, kinds = ['commands', 'skills', 'agents']) {
  return kinds.some((kind) => {
    const target = path.join(base, kind, kind === 'skills' ? name : `${name}.md`);
    return kind === 'skills' ? isDirectory(target) : isFile(target);
  });
}

function resolvesNamespacedUnit(root, token, kinds) {
  const match = token.match(/^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/);
  if (!match) return false;
  const base = namespaceRoot(root, match[1]);
  return Boolean(base && hasPluginUnit(base, match[2], kinds));
}

function resolvesCommand(root, token) {
  if (EXTERNAL_COMMAND_ALLOWLIST.includes(token)) return true;

  if (token.startsWith('/')) {
    const target = token.slice(1);
    if (target.includes(':')) return resolvesNamespacedUnit(root, target, ['commands', 'skills']);
    return pluginRoots(root).some(base => isFile(path.join(base, 'commands', `${target}.md`)))
      || isDirectory(skillDirectory(root, target));
  }
  return resolvesNamespacedUnit(root, token);
}

function lintDescriptionReferences(root, item, parsed) {
  if (!parsed.ok || !parsed.data.description) return [];
  const text = stripDescriptionCode(parsed.data.description);
  const tokens = new Set();
  const slashPattern = /(?:^|[\s(])\/((?:rstaff(?:-[a-z0-9-]+)?:)?[a-z][a-z0-9-]+)\b/g;
  const namespacedPattern = /\b(rstaff(?:-[a-z0-9-]+)?):([a-z][a-z0-9-]+)\b/g;
  for (const match of text.matchAll(slashPattern)) tokens.add(`/${match[1]}`);
  for (const match of text.matchAll(namespacedPattern)) tokens.add(`${match[1]}:${match[2]}`);

  return [...tokens]
    .filter((token) => !resolvesCommand(root, token))
    .map((token) => violation(
      'R4',
      item.file,
      `unresolvable command reference in description: ${token}`,
    ));
}

function lintBodySkillReferences(root, item, text, parsed) {
  if (!parsed.ok || !['skill', 'command', 'agent'].includes(item.kind)) return [];

  const bodyBeforeInlineCode = stripFencedCode(bodyAfterFrontmatter(text));
  const body = stripDescriptionCode(bodyBeforeInlineCode);
  const namespacedNames = new Set();
  const namespacedPattern = /\b(rstaff(?:-[a-z0-9-]+)?):([a-z][a-z0-9-]+)\b/g;
  for (const match of body.matchAll(namespacedPattern)) namespacedNames.add(`${match[1]}:${match[2]}`);

  const invocationNames = new Set();
  const invocationPattern = /\*\*([a-z][a-z0-9-]+)\*\*\s+skill\b/g;
  for (const match of body.matchAll(invocationPattern)) invocationNames.add(match[1]);
  const backtickedInvocationPattern = /`([a-z][a-z0-9-]+)`\s+skill\b/g;
  for (const match of bodyBeforeInlineCode.matchAll(backtickedInvocationPattern)) {
    invocationNames.add(match[1]);
  }

  const violations = [];
  for (const token of namespacedNames) {
    const resolves = resolvesNamespacedUnit(root, token);
    if (resolves) continue;
    violations.push(violation(
      'R4',
      item.file,
      `unresolvable skill reference in body: ${token}`,
    ));
  }

  for (const name of invocationNames) {
    if (EXTERNAL_SKILL_ALLOWLIST.includes(name)) continue;
    if (isDirectory(skillDirectory(root, name))) continue;
    violations.push(violation(
      'R4',
      item.file,
      `unresolvable skill invocation in body: **${name}** skill`,
    ));
  }

  return violations;
}

function pathTokens(text) {
  const pattern = /\b(?:rules|scripts|templates|schemas|skills)\/[A-Za-z0-9._$<…-]+/g;
  return new Set([...text.matchAll(pattern)].map((match) => match[0]));
}

function resolvesPluginPath(root, token) {
  if (/[<$…]/.test(token)) return true;
  const separator = token.indexOf('/');
  const kind = token.slice(0, separator);
  const basename = token.slice(separator + 1);
  // Extensionless rules/ and scripts/ citations are out of R5 scope by design.
  if (kind === 'rules' && !basename.endsWith('.md')) return true;
  if (kind === 'scripts' && !basename.endsWith('.js')) return true;
  return pluginRoots(root).some(base => fs.existsSync(path.join(base, token)));
}

function lintBodyPaths(root, item, text) {
  const body = bodyAfterFrontmatter(text);
  // A locate-qualified citation belongs to an optional plugin. Check its path
  // when installed; absence is handled by the caller's documented skip branch.
  const located = /\$\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/locate\.js" ([a-z-]+)\)\/([A-Za-z0-9._/-]+)/g;
  const optional = [];
  const localBody = body.replace(located, (_, name, relative) => {
    const base = pluginRoots(root).find(base => path.basename(base) === name);
    if (base && !fs.existsSync(path.join(base, relative))) optional.push(violation(
      'R5', item.file, `cited plugin path does not exist: ${relative}`,
    ));
    return '';
  });
  const tokens = pathTokens(localBody);
  return [...optional, ...[...tokens]
    .filter((token) => !resolvesPluginPath(root, token))
    .map((token) => violation(
      'R5',
      item.file,
      `cited plugin path does not exist: ${token}`,
    ))];
}

function skillStructureViolations(skillDir, skillEntries) {
  const violations = [];
  let references = null;
  let hasSkillEntry = false;

  for (const entry of skillEntries) {
    const file = path.join(skillDir, entry.name);
    if (entry.name === 'SKILL.md') {
      hasSkillEntry = true;
      if (entry.isFile()) continue;
    }
    if (entry.name === 'references' && entry.isDirectory()) {
      references = entry;
      continue;
    }
    violations.push(violation('S1', file, 'skill directory contains an unexpected entry'));
  }

  if (references) {
    const referencesDir = path.join(skillDir, references.name);
    for (const entry of entries(referencesDir)) {
      if (entry.isFile()) continue;
      violations.push(violation(
        'S1',
        path.join(referencesDir, entry.name),
        'references directory may contain regular files only',
      ));
    }
  }
  if (!hasSkillEntry) {
    violations.push(violation('S1', skillDir, 'skill directory must contain SKILL.md'));
  }
  return violations;
}

function lineCount(text) {
  const normalized = normalizeNewlines(text);
  if (!normalized) return 0;
  const withoutTerminalNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTerminalNewline.split('\n').length;
}

function discover(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const files = [];
  const structures = [];
  const counts = { skills: 0, commands: 0, agents: 0 };

  for (const base of pluginRoots(root)) {
    const skillsDir = path.join(base, 'skills');
    for (const skill of entries(skillsDir)) {
      if (!skill.isDirectory()) continue;
      counts.skills++;
      const skillDir = path.join(skillsDir, skill.name);
      const skillEntries = entries(skillDir);
      structures.push(...skillStructureViolations(skillDir, skillEntries));
      const skillFile = skillEntries.find((entry) => entry.name === 'SKILL.md' && entry.isFile());
      if (skillFile) files.push({ kind: 'skill', dirName: skill.name, file: path.join(skillDir, skillFile.name) });
    }

    for (const kind of ['command', 'agent']) {
      const dir = path.join(base, `${kind}s`);
      for (const entry of entries(dir)) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        counts[`${kind}s`]++;
        files.push({ kind, file: path.join(dir, entry.name) });
      }
    }

  }
  return { files, structures, counts };
}

function lintFile(item) {
  let text;
  try {
    text = fs.readFileSync(item.file, 'utf8');
  } catch (error) {
    return [violation('F1', item.file, `unable to read file: ${error.message}`)];
  }

  const violations = [];
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) {
    violations.push(violation('F1', item.file, parsed.error));
  } else {
    const required = item.kind === 'skill' ? ['name', 'description'] : ['description'];
    const missing = required.filter((key) => !String(parsed.data[key] || '').trim());
    if (missing.length) {
      violations.push(violation('F2', item.file, `missing or empty key(s): ${missing.join(', ')}`));
    }

    if (item.kind === 'skill' && String(parsed.data.name || '').trim()
      && parsed.data.name !== item.dirName) {
      violations.push(violation(
        'F3',
        item.file,
        `name "${parsed.data.name}" must equal skill directory "${item.dirName}"`,
      ));
    }

    if (Object.prototype.hasOwnProperty.call(parsed.data, 'description')
      && parsed.data.description.length > MAX_DESCRIPTION) {
      violations.push(violation(
        'F4',
        item.file,
        `description is ${parsed.data.description.length} characters; maximum is ${MAX_DESCRIPTION}`,
      ));
    }
  }

  const lines = lineCount(text);
  if (lines >= MAX_LINES) {
    violations.push(violation('F5', item.file, `file has ${lines} lines; maximum is ${MAX_LINES - 1}`));
  }
  return violations;
}

function lintTree(pluginRoot) {
  const root = pluginRoot === undefined ? path.join(__dirname, '..', 'plugins') : pluginRoot;
  const discovered = discover(root);
  const violations = [...discovered.structures, ...lintSkillRoster(root)];
  for (const item of discovered.files) {
    violations.push(...lintFile(item));
    const text = readText(item.file);
    if (text == null) continue;
    const parsed = parseFrontmatter(text);
    if (item.kind === 'skill') violations.push(...lintSkillReferences(item, text));
    violations.push(...lintDescriptionReferences(root, item, parsed));
    violations.push(...lintBodySkillReferences(root, item, text, parsed));
    violations.push(...lintBodyPaths(root, item, text));
  }
  for (const base of pluginRoots(root)) violations.push(...lintPeerReferences(base));
  return { violations, counts: discovered.counts };
}

if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, '..', 'plugins');
  try {
    const resolvedRoot = path.resolve(root);
    let rootStat;
    try {
      rootStat = fs.statSync(resolvedRoot);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`plugin root does not exist: ${resolvedRoot}`);
      }
      throw error;
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`plugin root is not a directory: ${resolvedRoot}`);
    }

    const result = lintTree(resolvedRoot);
    const discoveredFiles = Object.values(result.counts).reduce((total, count) => total + count, 0);
    if (discoveredFiles === 0) {
      throw new Error(`no plugin files discovered under: ${resolvedRoot}`);
    }
    for (const item of result.violations) {
      process.stdout.write(`${item.code} ${item.file}: ${item.detail}\n`);
    }
    process.exitCode = result.violations.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`lib-skill-lint: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXTERNAL_COMMAND_ALLOWLIST,
  PEER_EXTRA_SKILLS,
  PEER_TABLE_SKILLS,
  PEER_SKILL_ALLOWLIST,
  SKILL_ROSTER,
  lintTree,
  parseFrontmatter,
};
