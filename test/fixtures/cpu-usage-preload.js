'use strict';
// Loaded with `node --require` ahead of a hook under test. On exit it writes the
// process's user+system CPU milliseconds, counted from after Node bootstrap, to
// fd 3. The hooks time-budget tests read it there.
const fs = require('node:fs');

const base = process.cpuUsage();
process.on('exit', () => {
  const used = process.cpuUsage(base);
  try { fs.writeSync(3, String((used.user + used.system) / 1000)); } catch (_) {}
});
