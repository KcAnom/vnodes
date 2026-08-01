'use strict';
// Config resolution: defaults < .vnodes/config.json < environment variables.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS_PATH = path.join(__dirname, '..', 'config', 'defaults.json');
const ENGINE_DIR = '.vnodes';

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadConfig(projectRoot) {
  let cfg = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  const local = path.join(projectRoot, ENGINE_DIR, 'config.json');
  if (fs.existsSync(local)) {
    try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(local, 'utf8'))); }
    catch (e) { cfg._config_error = `invalid ${local}: ${e.message}`; }
  }
  const env = process.env;
  if (env.VNODES_PORT) cfg.mcp.port = Number(env.VNODES_PORT);
  if (env.VNODES_RUNTIME) cfg.runtime.provider = env.VNODES_RUNTIME;
  if (env.VNODES_PI_MODEL) cfg.runtime.pi_model = env.VNODES_PI_MODEL;
  if (env.VNODES_LOG_LEVEL) cfg.log.level = env.VNODES_LOG_LEVEL;
  if (env.VNODES_MAX_TOKENS) cfg.capsule.max_tokens = Number(env.VNODES_MAX_TOKENS);
  if (env.VNODES_PERSONAL_MODE) cfg.personal_mode = env.VNODES_PERSONAL_MODE === '1';
  return cfg;
}

// Walk up from cwd to find an existing engine dir or workspace parent pointer;
// fall back to cwd (indexing starts automatically wherever the project is opened).
function findProjectRoot(start) {
  let dir = path.resolve(start || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, ENGINE_DIR))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start || process.cwd());
    dir = parent;
  }
}

function engineDir(projectRoot) {
  const dir = path.join(projectRoot, ENGINE_DIR);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  // Graph store is local-only and gitignored; manifest is committed (BR-001).
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'index.db\nlogs/\ndaemon.pid\nmemory.db\n');
  return dir;
}

module.exports = { loadConfig, findProjectRoot, engineDir, ENGINE_DIR };
