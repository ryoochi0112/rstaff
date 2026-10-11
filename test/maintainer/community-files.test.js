'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const TOP_LEVEL_FILES = [
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
];
const PULL_REQUEST_TEMPLATE = '.github/PULL_REQUEST_TEMPLATE.md';
const ISSUE_TEMPLATE_DIRECTORY = '.github/ISSUE_TEMPLATE';
const FORBIDDEN_CONTENT = /backlog\/|profiles\/|specs\/|docs\/research|HANDOFF|LEARNINGS/;

function issueTemplateFiles(directory = path.join(ROOT, ISSUE_TEMPLATE_DIRECTORY)) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return issueTemplateFiles(filePath);
    return entry.isFile() ? [path.relative(ROOT, filePath)] : [];
  });
}

function communityPaths() {
  return [...TOP_LEVEL_FILES, PULL_REQUEST_TEMPLATE, ...issueTemplateFiles()];
}

function isRegularFile(relativePath) {
  try {
    return fs.lstatSync(path.join(ROOT, relativePath)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('community files are present as regular files', () => {
  for (const relativePath of [...TOP_LEVEL_FILES, PULL_REQUEST_TEMPLATE]) {
    assert.ok(isRegularFile(relativePath), `${relativePath} must exist as a regular file`);
  }

  const supportedIssueTemplates = issueTemplateFiles().filter(file => /\.(?:md|yml)$/.test(file));
  assert.ok(
    supportedIssueTemplates.length > 0,
    `${ISSUE_TEMPLATE_DIRECTORY} must contain at least one regular .md or .yml file`,
  );
});

test('public tree allowlist covers community files without excluding them', () => {
  const allowlistPath = path.join(ROOT, 'maintainer', 'public-tree.allow');
  const entries = fs.readFileSync(allowlistPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  for (const relativePath of TOP_LEVEL_FILES) {
    assert.ok(entries.includes(relativePath), `${relativePath} must be an exact allowlist entry`);
  }
  assert.ok(entries.includes('.github/'), '.github/ must be an exact allowlist entry');

  const exclusions = entries.filter(entry => entry.startsWith('!'))
    .map(entry => entry.slice(1).replace(/\/+$/, ''));
  for (const relativePath of communityPaths()) {
    for (const exclusion of exclusions) {
      const excludesPath = relativePath === exclusion || relativePath.startsWith(exclusion);
      assert.ok(!excludesPath, `${relativePath} is excluded by !${exclusion}`);
    }
  }
});

test('community files contain no internal paths or handoff markers', () => {
  for (const relativePath of communityPaths()) {
    if (!isRegularFile(relativePath)) continue;

    const contents = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    contents.split(/\r?\n/).forEach((line, index) => {
      assert.doesNotMatch(line, FORBIDDEN_CONTENT, `${relativePath}:${index + 1} contains forbidden community content`);
    });
  }
});

test('CODE_OF_CONDUCT.md links the covenant and contains no email address', () => {
  const relativePath = 'CODE_OF_CONDUCT.md';
  if (!isRegularFile(relativePath)) return;

  const contents = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  assert.ok(
    contents.includes('https://www.contributor-covenant.org/version/2/1/code_of_conduct/'),
    `${relativePath} must link to Contributor Covenant 2.1`,
  );
  assert.doesNotMatch(contents, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
});

test('CHANGELOG.md starts its release history with a dated semantic version', () => {
  const relativePath = 'CHANGELOG.md';
  if (!isRegularFile(relativePath)) return;

  const contents = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const firstReleaseHeading = contents.split(/\r?\n/).find(line => /^## \[/.test(line));
  assert.ok(firstReleaseHeading, `${relativePath} must contain a release heading`);
  assert.match(firstReleaseHeading, /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/);
});
