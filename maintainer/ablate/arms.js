'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildEvalCopy, removeEvalCopy } = require('../lib-eval-copy.js');

const ARM_NAMES = ['full', 'placebo', 'null', 'known-fail'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fileList(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return fileList(dir, rel);
    if (entry.isFile()) return [rel];
    throw new Error(`Unsupported arm tree entry: ${path.join(dir, rel)}`);
  }).sort();
}

function treeHash(dir) {
  const lines = fileList(dir).map((file) => `${sha256(fs.readFileSync(path.join(dir, file)))}  ./${file}\n`).join('');
  return sha256(lines).slice(0, 16);
}

function splitSkill(bytes, file) {
  const match = bytes.toString('utf8').match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Missing skill frontmatter: ${file}`);
  const boundary = Buffer.byteLength(match[0]);
  return { frontmatter: bytes.subarray(0, boundary), body: bytes.subarray(boundary) };
}

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Missing file: ${file}`);
}

function resolveSkill(skill, repoRoot = process.cwd()) {
  if (typeof skill !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) throw new Error(`Invalid skill: ${skill}`);
  const plugins = path.join(repoRoot, 'plugins');
  const owners = fs.existsSync(plugins) ? fs.readdirSync(plugins).filter((owner) =>
    fs.existsSync(path.join(plugins, owner, 'skills', skill, 'SKILL.md'))) : [];
  if (owners.length !== 1) throw new Error(`Expected one plugin owner for skill: ${skill}; found ${owners.length}`);
  const pluginDir = path.join(plugins, owners[0]);
  const fixtureDir = path.join(pluginDir, 'ablation', skill);
  const fixturePath = path.join(fixtureDir, 'known-fail.md');
  const metadataPath = path.join(fixtureDir, 'ablation.json');
  requireFile(fixturePath);
  requireFile(metadataPath);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!metadata || typeof metadata.case !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.case)) {
    throw new Error(`Invalid designated case in ${metadataPath}`);
  }
  const evalsDir = path.join(pluginDir, 'evals');
  const caseFiles = fileList(evalsDir).filter((file) => path.basename(file) === 'case.yaml');
  const cases = caseFiles.filter((file) =>
    file.endsWith(`/${metadata.case}/case.yaml`));
  if (cases.length !== 1) throw new Error(`Expected one designated case ${metadata.case} in ${metadataPath}; found ${cases.length}`);
  const caseRel = `evals/${cases[0]}`;
  const casePath = path.join(pluginDir, caseRel);
  const caseValue = JSON.parse(fs.readFileSync(casePath, 'utf8'));
  const caseName = caseValue.name;
  if (typeof caseName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseName)) {
    throw new Error(`Missing or invalid case name: ${casePath}`);
  }
  for (const file of caseFiles) {
    if (file === cases[0]) continue;
    const otherPath = path.join(evalsDir, file);
    if (JSON.parse(fs.readFileSync(otherPath, 'utf8')).name === caseName) {
      throw new Error(`Duplicate case name ${caseName}: ${casePath} and ${otherPath}`);
    }
  }
  if (!caseValue.execution || typeof caseValue.execution !== 'object' || Array.isArray(caseValue.execution)) {
    throw new Error(`Missing case execution: ${path.join(pluginDir, caseRel)}`);
  }
  const skillPath = path.join(pluginDir, 'skills', skill, 'SKILL.md');
  splitSkill(fs.readFileSync(skillPath), skillPath);
  return { pluginDir, fixturePath, metadataPath, case: metadata.case, caseName, caseRel };
}

function buildArms(skill, outDir, { repoRoot = process.cwd() } = {}) {
  const info = resolveSkill(skill, repoRoot);
  const arms = {};
  let caseHash;
  for (const arm of ARM_NAMES) {
    const armRoot = path.join(outDir, 'arms', arm);
    const copy = buildEvalCopy(info.pluginDir, armRoot);
    const dir = path.join(armRoot, path.basename(info.pluginDir));
    try { fs.renameSync(copy.pluginDir, dir); } finally { removeEvalCopy(copy.root); }
    const casePath = path.join(dir, info.caseRel);
    const caseValue = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    caseValue.execution.max_turns = 4;
    fs.writeFileSync(casePath, JSON.stringify(caseValue, null, 2) + '\n');
    caseHash = sha256(fs.readFileSync(casePath));
    const skillDir = path.join(dir, 'skills', skill);
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (arm === 'null') fs.rmSync(skillDir, { recursive: true });
    else if (arm !== 'full') {
      const { frontmatter } = splitSkill(fs.readFileSync(skillMd), skillMd);
      const body = arm === 'placebo' ? Buffer.from('This skill has no further instructions.') : fs.readFileSync(info.fixturePath);
      fs.writeFileSync(skillMd, Buffer.concat([frontmatter, body]));
    }
    arms[arm] = { dir, treeHash: treeHash(dir), skillMdHash: arm === 'null' ? null : sha256(fs.readFileSync(skillMd)) };
  }
  return { arms, caseHash };
}

module.exports = { buildArms, resolveSkill, treeHash, sha256, splitSkill };
