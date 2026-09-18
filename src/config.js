'use strict';
// Config resolution: defaults < .vnodes/config.json < environment variables.
const fs = require('node:fs');
const os = require('node:os');
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

// `projectRoot` is optional: the daemon's hub mode owns no project, and there
// is nothing for it to read a per-project override out of. Defaults plus the
// environment is the whole answer there, and it must not be spelled by pointing
// loadConfig at some arbitrary directory that happens to have a .vnodes in it.
function loadConfig(projectRoot) {
  let cfg = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  const local = projectRoot ? path.join(projectRoot, ENGINE_DIR, 'config.json') : null;
  if (local && fs.existsSync(local)) {
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

/**
 * The OS temp roots on this machine, in every spelling they answer to.
 *
 * os.tmpdir() on macOS is `/var/folders/<…>/T`, whose realpath is
 * `/private/var/folders/<…>/T`; on Linux it is `/tmp` or `$TMPDIR`. A project
 * below one of these must never resolve upward past it — the temp root is a
 * shared landfill, not a project, and a marker there (`.vnodes`, `.git`) is
 * how one stray index became every temp directory's project (verified live:
 * a `T/.vnodes` made 5,717 temp files into one knowledge base and re-routed
 * every fixture in the test suite).
 */
let tempRootsCache = null;
function tempRoots() {
  if (tempRootsCache) return tempRootsCache;
  const candidates = process.platform === 'win32'
    ? [os.tmpdir(), path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp')]
    : [os.tmpdir(), '/tmp', '/var/tmp'];
  const set = new Set();
  for (const c of candidates) {
    set.add(path.resolve(c));
    try { set.add(fs.realpathSync(c)); } catch {}
  }
  tempRootsCache = set;
  return set;
}

/** Is this path an OS temp root itself — not merely a directory inside one? */
function isTempRoot(p) {
  const resolved = path.resolve(p);
  if (tempRoots().has(resolved)) return true;
  try { return tempRoots().has(fs.realpathSync(p)); } catch { return false; }
}

// Walk up from cwd to find an existing engine dir or workspace parent pointer;
// fall back to cwd (indexing starts automatically wherever the project is opened).
function findProjectRoot(start) {
  const fallback = path.resolve(start || process.cwd());
  let dir = fallback;
  while (true) {
    if (fs.existsSync(path.join(dir, ENGINE_DIR))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    /**
     * The walk stops at an OS temp root, the way git stops at a filesystem
     * boundary. Everything the fall-through below protects against happened
     * on 2026-09-18: a `.vnodes` appeared in the shared macOS temp root (one
     * daemon started with its cwd in temp), and from then on every project in
     * every temp directory — the whole test suite's fixtures — resolved UP to
     * the temp root and answered from a 5,717-file index nobody indexed on
     * purpose. A marker below the temp root still resolves normally; the root
     * itself never claims anything above its own subtrees.
     */
    if (isTempRoot(parent)) return fallback;
    dir = parent;
  }
}

function engineDir(projectRoot) {
  const dir = path.join(projectRoot, ENGINE_DIR);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  // Graph store is local-only and gitignored; manifest is committed.
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'index.db\nlogs/\ndaemon.pid\nmemory.db\n');
  return dir;
}

/**
 * Where the engine directory would be, without making one.
 *
 * `engineDir` is not a getter: it mkdirs `<root>/.vnodes/logs` and writes a
 * .gitignore, which is correct for the indexer and the CLI and wrong for a read.
 * uiApi called it on every /ui/api/* request, and once a request can name a
 * project other than the daemon's own, that becomes the daemon materialising
 * directories inside somebody else's tree in order to answer a GET.
 */
function engineDirPath(projectRoot) {
  return path.join(projectRoot, ENGINE_DIR);
}

module.exports = { loadConfig, findProjectRoot, engineDir, engineDirPath, isTempRoot, tempRoots, ENGINE_DIR };
