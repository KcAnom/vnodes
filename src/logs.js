'use strict';
// Diagnostics contract: two log channels — daemon log and index log — inside
// the project engine directory, self-truncating per cfg.log.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');

function logPath(projectRoot, channel) {
  return path.join(projectRoot, '.vnodes', 'logs', `${channel}.log`);
}

function log(projectRoot, channel, message) {
  const p = logPath(projectRoot, channel);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${new Date().toISOString()} ${message}\n`);
    maybeTruncate(projectRoot, p);
  } catch {}
}

function maybeTruncate(projectRoot, p) {
  const cfg = loadConfig(projectRoot);
  const threshold = cfg.log.truncate_threshold_mb * 1024 * 1024;
  try {
    if (fs.statSync(p).size <= threshold) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const keep = lines.slice(-cfg.log.truncate_lines);
    fs.writeFileSync(p, `[truncated to last ${cfg.log.truncate_lines} lines]\n` + keep.join('\n'));
  } catch {}
}

module.exports = { log, logPath };
