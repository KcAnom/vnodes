'use strict';
/**
 * The list of knowledge bases this machine knows about.
 *
 * A knowledge base is one indexed project: `<root>/.vnodes/index.db`. Until
 * this file existed a knowledge base was discoverable only by already standing
 * in its directory, which is why the daemon could only ever serve the one
 * project it was launched in and why the packaged app always showed the vnodes
 * repo itself. The registry is the missing index: a directory per knowledge
 * base, holding a snapshot record vnodes itself wrote at the end of an index
 * run.
 *
 * It does not live in `~/.vnodes/`. That path IS the accidental home-directory
 * knowledge base, and the honest way to disown that accident is
 * `rm -rf ~/.vnodes` — a registry living inside it would be destroyed by the
 * very command the picker tells the reader to run. `~/.config/vnodes/registry`
 * sits beside the other agent config on this machine and survives that.
 *
 * THE SECURITY PROPERTY THIS FILE CARRIES: `resolveKb` is the only function in
 * the codebase permitted to turn a request parameter into a project root, and
 * it does so by looking the parameter up as a KEY — never by joining it into a
 * path. Caller text is shape-gated to sixteen lowercase hex characters before
 * any I/O happens at all, so there is no branch in which it reaches
 * `path.join`, `fs.open`, `openStore` or `openMemory`. The daemon binds to
 * localhost, but "read any sqlite file on disk by URL" is a hole at any
 * address: every page in every browser can GET localhost.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[0-9a-f]{16}$/;
const SCHEMA = 1;

/**
 * Registry tuning, from config/defaults.json.
 *
 * That file's own header says every value is "Configurable — never hardcoded in
 * source", so the numbers live there. The literal below is not a second source
 * of truth: it is what keeps an install whose defaults.json lost the block from
 * turning an index run into a crash. If you are changing a number, change
 * config/defaults.json.
 */
const REGISTRY_FALLBACK = Object.freeze({
  write_interval_s: 60, scan_cap: 500, list_cap: 200,
  tmp_sweep_s: 3600, oversize_files: 50000, oversize_db_mb: 512,
});
let defaultsCache = null;
function registryCfg(cfg) {
  if (cfg && cfg.registry) return { ...REGISTRY_FALLBACK, ...cfg.registry };
  if (!defaultsCache) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.json'), 'utf8'));
      defaultsCache = { ...REGISTRY_FALLBACK, ...(raw.registry || {}) };
    } catch { defaultsCache = { ...REGISTRY_FALLBACK }; }
  }
  return defaultsCache;
}

/**
 * Where the registry lives.
 *
 * VNODES_HOME first, following the existing VNODES_* convention in
 * src/config.js — it is what every test sets, so `npm test` never writes into
 * the developer's real home. Then XDG_CONFIG_HOME, then ~/.config.
 */
function registryDir() {
  const env = process.env;
  if (env.VNODES_HOME) return path.join(env.VNODES_HOME, 'registry');
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'vnodes', 'registry');
  return path.join(os.homedir(), '.config', 'vnodes', 'registry');
}

/** The opaque key a browser names a knowledge base by. Never a path component of the caller's choosing. */
function kbId(realpath) {
  return crypto.createHash('sha256').update(String(realpath)).digest('hex').slice(0, 16);
}

/** The id for a project root on disk, or null if the root does not resolve. */
function idForPath(projectRoot) {
  try { return kbId(fs.realpathSync(projectRoot)); } catch { return null; }
}

function entryDir(id) { return path.join(registryDir(), id); }

/**
 * Write a file so a concurrent reader sees all of the old bytes or all of the
 * new ones, never a half-written record.
 *
 * There is no lock and no PID liveness check: this codebase already paid that
 * bill once for daemon.pid, and the shared mutable object is removed here
 * rather than guarded. One logical writer per file — kb.json by the indexer or
 * daemon for that one project, agents/<slug>.json by that one agent, hidden by
 * the CLI — so the worst outcome of a race is a lost timestamp.
 */
function atomicWriteJson(target, value, cfg) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  sweepTmp(dir, cfg);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Orphan .tmp files from a process killed mid-write.
 *
 * Readers only ever open kb.json, agents/*.json and hidden, so an orphan is
 * already invisible to them; sweeping is housekeeping, not correctness, which
 * is why it happens on the way past a write instead of on a timer.
 */
function sweepTmp(dir, cfg) {
  const maxAge = registryCfg(cfg).tmp_sweep_s * 1000;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue;
    const p = path.join(dir, n);
    try { if (now - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p); } catch {}
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The branch name, from a plain read of .git/HEAD.
 *
 * Never a child process: this runs at the end of every index run and inside a
 * page load, and spawning git there would put a process launch on both.
 */
function gitBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (m) return m[1];
    if (/^[0-9a-f]{7,40}$/.test(head)) return `detached ${head.slice(0, 7)}`;
    return null;
  } catch { return null; }
}

/**
 * What to call this knowledge base in a list.
 *
 * `os.homedir()` gets the literal words rather than its basename, because
 * "kcdacr8tor" in a list of projects reads as a username and not as the
 * half-million-file accident it actually is.
 */
function kbName(real) {
  if (real === os.homedir()) return 'your home directory';
  try {
    const { loadWorkspace } = require('./workspace');
    const ws = loadWorkspace(real);
    if (ws && ws.name) return ws.name;
  } catch {}
  return path.basename(real) || real;
}

/**
 * How much disk this index occupies, WAL included.
 *
 * index.db alone under-reports badly while a daemon is watching: the store runs
 * in WAL mode, so a freshly written index can be a quarter-megabyte in the main
 * file and megabytes in the -wal beside it. The oversize guards are decided on
 * this number, and a guard that reads a quarter of the real size is not a guard.
 */
function engineDbBytes(engDir) {
  let total = null;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total = (total || 0) + fs.statSync(path.join(engDir, `index.db${suffix}`)).size; } catch {}
  }
  return total;
}

/**
 * Notes counts for a knowledge base, from ONE query against its own memory.db.
 *
 * Taken at index time and stored in the record so the picker never opens a
 * database of its own. A 16 KB file and a sub-millisecond query here is what
 * buys a list that costs two statSync calls a row.
 */
function memorySnapshot(engDir) {
  const { openMemoryReadOnly } = require('./store');
  try {
    const db = openMemoryReadOnly(engDir);
    if (!db) return { notes: 0, notes_manual: 0, last_activity_ms: null };
    try {
      const r = db.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN kind = 'manual' THEN 1 ELSE 0 END) manual,
        MAX(ts) last FROM observations`).get();
      return {
        notes: Number(r.total || 0),
        notes_manual: Number(r.manual || 0),
        last_activity_ms: r.last ? Number(r.last) : null,
      };
    } finally { db.close(); }
  } catch {
    return { notes: 0, notes_manual: 0, last_activity_ms: null };
  }
}

/**
 * Counts read back out of an existing index, without writing to it.
 *
 * Used only when a record has to be created for a project that was indexed
 * before the registry existed — the migration path. `runIndex` passes its own
 * counts straight in and never comes through here.
 */
function storeSnapshot(engDir) {
  const { openStoreReadOnly } = require('./store');
  const empty = { files: null, nodes: null, edges: null, langs: null, repos: null, last_indexed_ms: null, last_index_duration_ms: null };
  let db;
  try { db = openStoreReadOnly(engDir); } catch { return empty; }
  if (!db) return empty;
  try {
    const lastIndex = Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index'").get()?.value || 0);
    if (!lastIndex) return empty; // never finished a run — counting rows would dress that up as a result
    return {
      files: Number(db.prepare('SELECT COUNT(*) c FROM files').get().c),
      nodes: Number(db.prepare('SELECT COUNT(*) c FROM nodes').get().c),
      edges: Number(db.prepare('SELECT COUNT(*) c FROM edges').get().c),
      langs: db.prepare('SELECT lang, COUNT(*) c FROM files GROUP BY lang ORDER BY c DESC LIMIT 3').all().map(r => r.lang || 'unknown'),
      repos: db.prepare('SELECT DISTINCT repo FROM files').all().map(r => r.repo || '(root)'),
      last_indexed_ms: lastIndex,
      last_index_duration_ms: Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index_ms'").get()?.value || 0) || null,
    };
  } catch {
    return empty;
  } finally {
    try { db.close(); } catch {}
  }
}

/** Every key in the record, always present. A null is a stated unknown; an absent key is a silent one. */
function buildRecord(real, pathAsGiven, engDir, counts, writer) {
  const manifest = fs.existsSync(path.join(engDir, 'manifest.json'));
  const complete = manifest && !!counts.last_indexed_ms;
  const mem = memorySnapshot(engDir);
  const now = Date.now();
  return {
    schema: SCHEMA,
    id: kbId(real),
    path: real,
    path_as_given: pathAsGiven && pathAsGiven !== real ? pathAsGiven : null,
    name: kbName(real),
    branch: gitBranch(real),
    complete,
    last_indexed_ms: counts.last_indexed_ms || null,
    last_index_duration_ms: counts.last_index_duration_ms || null,
    files: complete ? (counts.files ?? null) : null,
    nodes: complete ? (counts.nodes ?? null) : null,
    edges: complete ? (counts.edges ?? null) : null,
    langs: complete ? (counts.langs || []) : null,
    repos: complete ? (counts.repos || []) : null,
    db_bytes: engineDbBytes(engDir),
    notes: mem.notes,
    notes_manual: mem.notes_manual,
    last_activity_ms: mem.last_activity_ms || counts.last_indexed_ms || null,
    snapshot_at: now,
    writer,
  };
}

/**
 * W1 — the snapshot an index run leaves behind.
 *
 * Called from runIndex one line before it closes the database, where every
 * field is already a local variable. Throttled on a single statSync: the
 * daemon's watcher debounces runIndex at 500 ms, so under active editing this
 * fires many times a minute, and one stat against a run that already took
 * >100 ms costs nothing.
 */
function recordIndex(projectRoot, stats = {}, cfg) {
  const rcfg = registryCfg(cfg);
  const real = fs.realpathSync(projectRoot);
  const id = kbId(real);
  const target = path.join(entryDir(id), 'kb.json');
  const counts = {
    files: stats.files ?? null,
    nodes: stats.nodes ?? null,
    edges: stats.edges ?? null,
    langs: stats.langs || [],
    repos: stats.repos || [],
    last_indexed_ms: stats.last_indexed_ms || Date.now(),
    last_index_duration_ms: stats.ms ?? null,
  };
  try {
    const st = fs.statSync(target);
    if (Date.now() - st.mtimeMs < rcfg.write_interval_s * 1000) {
      const prev = readJson(target);
      if (prev.files === counts.files && prev.nodes === counts.nodes && prev.edges === counts.edges) {
        return { id, written: false, reason: 'throttled — same counts within write_interval_s' };
      }
    }
  } catch {}
  const engDir = stats.engDir || path.join(real, '.vnodes');
  atomicWriteJson(target, buildRecord(real, projectRoot, engDir, counts, 'runIndex'), cfg);
  return { id, written: true };
}

/**
 * W2/W4 — make sure a project that already has an index is listed.
 *
 * This is the whole migration path: a project indexed before the registry
 * shipped self-registers the first time its daemon runs or the first time
 * someone runs `vnodes kb register` in it. There is no scan job and no
 * backfill, and nothing here indexes anything.
 *
 * `requireIndex` is what keeps this from becoming the mechanism that created
 * the home-directory accident: with it set, a project with no index.db is not
 * registered at all.
 */
function ensureEntry(projectRoot, writer = 'daemon', { requireIndex = true, cfg } = {}) {
  let real;
  try { real = fs.realpathSync(projectRoot); } catch { return null; }
  const engDir = path.join(real, '.vnodes');
  const hasIndex = fs.existsSync(path.join(engDir, 'index.db'));
  if (requireIndex && !hasIndex) return null;
  const id = kbId(real);
  const target = path.join(entryDir(id), 'kb.json');
  if (fs.existsSync(target)) return { id, written: false, reason: 'already registered' };
  const counts = hasIndex ? storeSnapshot(engDir) : { files: null, nodes: null, edges: null, langs: null, repos: null, last_indexed_ms: null, last_index_duration_ms: null };
  atomicWriteJson(target, buildRecord(real, projectRoot, engDir, counts, writer), cfg);
  return { id, written: true };
}

function agentSlug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return s || 'unknown';
}

/**
 * W3 — which agent touched this knowledge base.
 *
 * One file per agent, because attribution is the one genuinely accumulating
 * fact here and a lost update would silently drop an agent that really did use
 * the project. Writes nothing when the knowledge base is not already
 * registered: an MCP handshake in an unindexed directory must not create an
 * entry, since that is exactly how the $HOME accident began.
 */
function recordAgent(projectRoot, clientInfo, cfg) {
  let real;
  try { real = fs.realpathSync(projectRoot); } catch { return null; }
  const id = kbId(real);
  const dir = entryDir(id);
  if (!fs.existsSync(path.join(dir, 'kb.json'))) return null;
  const slug = agentSlug(clientInfo && clientInfo.name);
  const target = path.join(dir, 'agents', `${slug}.json`);
  const now = Date.now();
  let prev = null;
  try { prev = readJson(target); } catch {}
  atomicWriteJson(target, {
    name: (clientInfo && clientInfo.name) ? String(clientInfo.name).slice(0, 80) : 'unknown',
    version: (clientInfo && clientInfo.version) ? String(clientInfo.version).slice(0, 40) : null,
    first_seen_ms: prev && prev.first_seen_ms ? prev.first_seen_ms : now,
    last_seen_ms: now,
    sessions: (prev && Number(prev.sessions) ? Number(prev.sessions) : 0) + 1,
  }, cfg);
  return { id, slug };
}

function agentsOf(dir) {
  let names;
  try { names = fs.readdirSync(path.join(dir, 'agents')); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const a = readJson(path.join(dir, 'agents', n));
      out.push({ name: a.name || n.replace(/\.json$/, ''), version: a.version ?? null, last_seen_ms: a.last_seen_ms ?? null, sessions: Number(a.sessions || 0) });
    } catch {}
  }
  return out.sort((a, b) => (b.last_seen_ms || 0) - (a.last_seen_ms || 0));
}

/** The sentence a row carries next to its state. Never a bare enum: a state nobody can act on is a state nobody reads. */
const STATE_DETAIL = {
  ok: 'indexed and readable',
  never_completed: 'the index database exists but no index run ever finished on this tree',
  engine_removed: 'the project is still there; its .vnodes/index.db is gone',
  missing: 'the project directory no longer exists at the recorded path',
  unreadable: 'the recorded path could not be read (permissions, or an unmounted volume) — not the same as deleted',
  unparseable: 'this registry record could not be parsed',
};

function verdictFor(rec) {
  if (!rec.complete) return 'never finished indexing';
  if (!rec.files) return 'empty — no supported files found in this tree';
  if (!rec.edges) return `no dependency graph — ${rec.nodes || 0} symbols, 0 edges · capsules will have no supporters`;
  return `graph connected · ${rec.edges} edges`;
}

/**
 * Every knowledge base this machine knows about, as the picker's whole payload.
 *
 * NO DATABASE IS OPENED. indexStatus() was measured at 5,819 ms for the home
 * knowledge base alone, and it opens the store in WRITE mode — nine
 * CREATE TABLE IF NOT EXISTS and a WAL pragma — so a picker built on it would
 * open every registered project's index.db for writing just to draw a list.
 * Two statSync calls a row is the whole liveness budget.
 */
function listKbs({ launchRoot = null, cfg = null, includeHidden = false } = {}) {
  const rcfg = registryCfg(cfg);
  const dir = registryDir();
  const notes = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) {
    notes.push(e.code === 'ENOENT'
      ? `no registry yet at ${dir} — a project is listed here the first time it finishes an index run`
      : `registry directory unreadable: ${e.message}`);
  }
  const ids = names.filter(n => ID_RE.test(n));
  const skipped = names.length - ids.length;
  if (skipped > 0) notes.push(`${skipped} entr${skipped === 1 ? 'y' : 'ies'} in ${dir} did not look like a knowledge base id and were skipped`);
  const scanCapped = ids.length > rcfg.scan_cap;
  if (scanCapped) notes.push(`registry holds ${ids.length} entries; only the first ${rcfg.scan_cap} were read (registry.scan_cap)`);
  const scan = ids.slice(0, rcfg.scan_cap);

  const launchId = launchRoot ? idForPath(launchRoot) : null;
  const rows = [];
  let hiddenCount = 0;
  let totalDbBytes = 0;

  for (const id of scan) {
    const edir = path.join(dir, id);
    const hidden = fs.existsSync(path.join(edir, 'hidden'));
    if (hidden) hiddenCount++;
    let rec;
    try { rec = readJson(path.join(edir, 'kb.json')); } catch (e) {
      if (hidden && !includeHidden) continue;
      rows.push({
        id, path: null, name: id, state: 'unreadable', state_detail: `${STATE_DETAIL.unparseable}: ${e.message}`,
        hidden, is_launch: id === launchId, verdict: 'unreadable registry record', flags: [], agents: [],
        last_activity_ms: null, counts_stale: false,
        hide_command: `vnodes kb hide ${id}`, forget_command: `vnodes kb forget ${id}`, remove_engine_command: null,
      });
      continue;
    }
    if (hidden && !includeHidden) continue;

    // Two stats, and only two: the project directory and its index database.
    let state = 'ok';
    let dbStat = null;
    try {
      fs.statSync(rec.path);
      try { dbStat = fs.statSync(path.join(rec.path, '.vnodes', 'index.db')); }
      catch { state = 'engine_removed'; }
    } catch (e) {
      state = e.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    if (state === 'ok' && !rec.complete) state = 'never_completed';

    // The stat above is one of the two this row is allowed; the recorded size
    // stands in when the project is gone, so a missing row still says how much
    // disk it is holding somewhere.
    const dbBytes = dbStat ? (engineDbBytes(path.join(rec.path, '.vnodes')) ?? dbStat.size) : (rec.db_bytes ?? null);
    if (dbBytes) totalDbBytes += dbBytes;

    const flags = [];
    if (rec.path === os.homedir()) flags.push('home_dir');
    if (rec.complete && rec.files > 0 && !rec.edges) flags.push('no_edges');
    if (rec.files != null && rec.files > rcfg.oversize_files) flags.push('oversize_files');
    if (dbBytes != null && dbBytes > rcfg.oversize_db_mb * 1024 * 1024) flags.push('oversize_db');
    if (!rec.complete) flags.push('never_completed');

    const agents = agentsOf(edir);
    const lastActivity = Math.max(
      Number(rec.last_activity_ms || 0),
      Number(rec.last_indexed_ms || 0),
      ...agents.map(a => Number(a.last_seen_ms || 0)),
    ) || null;

    rows.push({
      ...rec,
      db_bytes: dbBytes,
      state,
      state_detail: STATE_DETAIL[state],
      hidden,
      is_launch: id === launchId,
      counts_stale: !!(dbStat && rec.snapshot_at && dbStat.mtimeMs > rec.snapshot_at),
      verdict: verdictFor(rec),
      flags,
      agents,
      last_activity_ms: lastActivity,
      hide_command: `vnodes kb hide ${id}`,
      forget_command: `vnodes kb forget ${id}`,
      // Forgetting removes the row; this removes the index itself. vnodes never
      // runs it — a remedy in this codebase is a line the reader copies.
      remove_engine_command: rec.path ? `rm -rf ${path.join(rec.path, '.vnodes')}` : null,
    });
  }

  rows.sort((a, b) => (b.last_activity_ms || 0) - (a.last_activity_ms || 0));
  const shown = rows.slice(0, rcfg.list_cap);
  if (rows.length > shown.length) {
    notes.push(`${rows.length - shown.length} more knowledge base(s) not listed (registry.list_cap = ${rcfg.list_cap}) — run: vnodes kb list`);
  }
  if (hiddenCount && !includeHidden) {
    notes.push(`${hiddenCount} knowledge base(s) hidden with \`vnodes kb hide\` — run \`vnodes kb show <id>\` to bring one back`);
  }

  return {
    registry_dir: dir,
    hub: !launchRoot,
    launch_kb: launchId,
    launch_root: launchRoot || null,
    sort: 'last_activity_desc',
    scanned: ids.length,
    scan_capped: scanCapped,
    shown: shown.length,
    hidden_count: hiddenCount,
    total_db_bytes: totalDbBytes,
    kbs: shown,
    notes,
  };
}

/**
 * THE SECURITY FUNCTION. The only path from a request parameter to a project
 * root anywhere in this codebase.
 *
 * The order of the steps is the point. The shape gate runs before any I/O, so
 * '/etc', '../../etc/passwd', '~', '%2e%2e%2f', an uppercase-hex id and a
 * 40-char sha1 all die before a single filesystem call. What survives is proven
 * to be sixteen lowercase hex characters, which cannot escape a join. The path
 * then comes out of a file vnodes itself wrote — and is still distrusted: it
 * must be absolute, it must still resolve, re-deriving the id from the live
 * realpath must reproduce the id that was asked for (which is what catches a
 * symlink swapped in under a registered root, and an APFS case-fold alias), and
 * the store must already exist because a GET may never create one.
 *
 * There is NO FALLBACK to the launch project on any failure. A 200 drawn from
 * the wrong project is exactly the failure mode the /ui path-prefix fix was
 * written to eliminate; answering 404 is the whole contract.
 */
function resolveKb(rawParam, launchRoot) {
  const id = String(rawParam ?? '');
  if (id === '') {
    return launchRoot
      ? { ok: true, id: null, root: launchRoot, source: 'default' }
      : { ok: false, code: 'no_default', error: 'this daemon has no launch project; name one with ?kb=' };
  }
  if (!ID_RE.test(id)) return { ok: false, code: 'bad_id', error: 'not a knowledge base id', kb: id };
  let rec;
  try { rec = readJson(path.join(registryDir(), id, 'kb.json')); }
  catch { return { ok: false, code: 'unknown_kb', error: 'no such knowledge base', kb: id }; }
  const root = rec.path;
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return { ok: false, code: 'corrupt_entry', error: 'this registry record has no usable path', kb: id };
  }
  let real;
  try { real = fs.realpathSync(root); } catch (e) {
    return {
      ok: false, code: e.code === 'ENOENT' ? 'missing' : 'unreadable',
      error: e.code === 'ENOENT' ? 'the project directory no longer exists' : `the project directory could not be read: ${e.message}`,
      kb: id, expected: root,
    };
  }
  if (kbId(real) !== id) {
    return { ok: false, code: 'moved', error: 'the recorded path now resolves somewhere else', kb: id, expected: root, resolved: real };
  }
  const db = path.join(real, '.vnodes', 'index.db');
  if (!fs.existsSync(db)) {
    return { ok: false, code: 'engine_removed', error: 'this knowledge base has no index database', kb: id, expected: db };
  }
  return { ok: true, id, root: real, entry: rec, source: 'query' };
}

function hide(id) {
  if (!ID_RE.test(String(id))) return { ok: false, error: 'not a knowledge base id', kb: String(id) };
  const dir = entryDir(id);
  if (!fs.existsSync(path.join(dir, 'kb.json'))) return { ok: false, error: 'no such knowledge base', kb: id };
  fs.writeFileSync(path.join(dir, 'hidden'), '');
  return { ok: true, id, hidden: true };
}

function show(id) {
  if (!ID_RE.test(String(id))) return { ok: false, error: 'not a knowledge base id', kb: String(id) };
  try { fs.unlinkSync(path.join(entryDir(id), 'hidden')); } catch {}
  return { ok: true, id, hidden: false };
}

/**
 * Drop the row. Never the index.
 *
 * Forgetting is a registry operation: it removes what vnodes wrote about a
 * project, and leaves the project's own .vnodes/ exactly where it is. The
 * command that removes that is returned as a string for the reader to run.
 */
function forget(id) {
  if (!ID_RE.test(String(id))) return { ok: false, error: 'not a knowledge base id', kb: String(id) };
  const dir = entryDir(id);
  let rec = null;
  try { rec = readJson(path.join(dir, 'kb.json')); } catch {}
  if (!fs.existsSync(dir)) return { ok: false, error: 'no such knowledge base', kb: id };
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    ok: true, id, forgotten: dir, path: rec ? rec.path : null,
    index_left_in_place: rec ? path.join(rec.path, '.vnodes') : null,
    remove_engine_command: rec ? `rm -rf ${path.join(rec.path, '.vnodes')}` : null,
    note: 'the registry row is gone; the index itself was not touched',
  };
}

module.exports = {
  registryDir, kbId, idForPath, recordIndex, ensureEntry, recordAgent,
  listKbs, resolveKb, hide, show, forget, registryCfg, agentSlug, engineDbBytes, ID_RE,
};
