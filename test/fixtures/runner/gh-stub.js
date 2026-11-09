#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.STUB_DIR, 'gh.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.STUB_GH_FAIL) { process.stderr.write('gh: boom\n'); process.exit(1); }
process.stdout.write('Creating draft pull request…\nhttps://github.com/example/acme/pull/7\n');
