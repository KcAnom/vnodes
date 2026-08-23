'use strict';
// M8 Daemon & Diagnostics. HTTP transport is opt-in on cfg.mcp.port (BR-012);
// auto-restart when a tool call hits a stopped daemon (BR-024); read-only
// doctor that works with the daemon down (BR-026). Also serves the minimal
// M9 status UI at /ui (styling left on the design-system seam).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { loadConfig, findProjectRoot, engineDirPath } = require('./config');
const { resolveKb, listKbs, ensureEntry, registryCfg } = require('./registry');
const { TOOL_DEFS, callTool } = require('./tools');
const { indexStatus } = require('./indexer');
const { loadWorkspace } = require('./workspace');
const { log, logPath } = require('./logs');

function pidFile(projectRoot) { return path.join(projectRoot, '.vnodes', 'daemon.pid'); }

function daemonState(projectRoot) {
  const pf = pidFile(projectRoot);
  if (!fs.existsSync(pf)) return { running: false };
  const { pid, port } = JSON.parse(fs.readFileSync(pf, 'utf8'));
  try { process.kill(pid, 0); return { running: true, pid, port }; }
  catch { return { running: false, stale_pidfile: true, pid, port }; }
}

// Watch the project tree and re-index on source changes, debounced, so the
// SSE map stream (keyed off indexStamp) goes live without a manual
// `vnodes index`. Events are filtered through the same ignore rules and
// language check as the indexer — .vnodes/ is default-excluded, so the
// index writes themselves never re-trigger the watcher.
function startWatcher(projectRoot, cfg) {
  const { buildIgnore } = require('./ignore');
  const { langOf } = require('./parser');
  const { runIndex } = require('./indexer');
  const ws = loadWorkspace(projectRoot);
  const roots = ws ? ws.repos.map(r => path.resolve(ws.baseDir, r.path)).filter(p => fs.existsSync(p)) : [projectRoot];
  const watchers = [];
  let timer = null, indexing = false, dirty = false;
  const run = () => {
    if (indexing) { dirty = true; return; }
    indexing = true;
    try {
      const r = runIndex(projectRoot, cfg);
      log(projectRoot, 'daemon', `watcher re-index: ${r.files} files / ${r.edges} edges in ${r.ms}ms`);
    } catch (e) {
      log(projectRoot, 'daemon', `watcher re-index failed: ${e.message}`);
    }
    indexing = false;
    if (dirty) { dirty = false; kick(); }
  };
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(run, cfg.index.watch_debounce_ms);
    timer.unref?.();
  };
  for (const root of roots) {
    const isIgnored = buildIgnore(root);
    try {
      const w = fs.watch(root, { recursive: true }, (_ev, fname) => {
        if (!fname) return;
        const rel = String(fname).split(path.sep).join('/');
        if (isIgnored(rel) || !langOf(rel)) return;
        kick();
      });
      watchers.push(w);
    } catch (e) {
      log(projectRoot, 'daemon', `watcher unavailable for ${root}: ${e.message}`);
    }
  }
  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}

const UI_API_ROUTES = ['/ui/api/kbs', '/ui/api/health', '/ui/api/capsule', '/ui/api/notes', '/ui/api/composition'];

/**
 * Why this /ui data request is refused, or null if it is allowed.
 *
 * The same Origin and Host rule /rpc has carried, minus the content-type clause
 * — these are GETs, and demanding a content-type on a GET would refuse the
 * page's own fetches. Verified before this existed: `GET /ui/api/composition`
 * with `Origin: https://evil.example` returned 200, because rpcDenial was wired
 * only into the /rpc POST branch. On a 72-file repo that buys an attacker
 * milliseconds of someone else's CPU and a file listing; with a knowledge-base
 * selector it is one URL away from the 541,275-file home index, where
 * buildCapsule was measured at 18.6 seconds of synchronous work on the daemon's
 * only event loop. `sec-fetch-site` is checked as well as Origin because a
 * cross-site navigation sends no Origin header at all.
 */
function uiDenial(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some(h => origin === `http://${h}`)) return `origin ${origin}`;
  if (!hosts.includes(req.headers.host || '')) return `host ${req.headers.host || '(none)'}`;
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'sec-fetch-site cross-site';
  return null;
}

/** Why this /rpc request is refused, or null if it is allowed. */
function rpcDenial(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = req.headers.origin;
  // Absent Origin is the CLI, the MCP client and curl. Present-and-wrong is a
  // page in somebody's browser reaching a daemon it does not own.
  if (origin !== undefined && !hosts.some(h => origin === `http://${h}`)) return `origin ${origin}`;
  if (!hosts.includes(req.headers.host || '')) return `host ${req.headers.host || '(none)'}`;
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return `content-type ${req.headers['content-type'] || '(none)'} (application/json required)`;
  }
  return null;
}

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
}

/** Last N lines of a log channel, as lines. Fixed length so the response is bounded. */
function tailLog(projectRoot, channel, lines = 50) {
  try {
    return fs.readFileSync(logPath(projectRoot, channel), 'utf8')
      .split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * How many observations there are, and of what kind. Lets the notes page say
 * what it is looking at.
 *
 * Read-only: this ran openMemory, which CREATES memory.db, on a GET. For the
 * daemon's own project that was invisible; for a knowledge base named in a
 * query parameter it would be the daemon writing a database into a project the
 * reader merely clicked on.
 */
function observationCounts(engDir) {
  const { openMemoryReadOnly } = require('./store');
  try {
    const db = openMemoryReadOnly(engDir);
    if (!db) return null;
    const r = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN kind = 'manual' THEN 1 ELSE 0 END) manual,
      SUM(CASE WHEN kind <> 'manual' THEN 1 ELSE 0 END) auto,
      SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END) stale FROM observations`).get();
    db.close();
    return { total: Number(r.total || 0), manual: Number(r.manual || 0), auto: Number(r.auto || 0), stale: Number(r.stale || 0) };
  } catch {
    return null;
  }
}

/**
 * The capsule as the UI is allowed to see it.
 *
 * File bodies come out. The operator already has every one of these files open
 * in an editor two inches away, and shipping them would make this a 35 KB
 * response that says nothing the editor does not. The single exception is the
 * head of a clipped pivot: that is the one thing the editor cannot show,
 * because the clip is a decision the capsule made and not a fact about the file.
 */
/**
 * `projectFlag` is the project root to name in the reproduction line, or null
 * for the daemon's own. bin/vnodes.js resolves the project upward from cwd, so
 * once this page can preview a capsule for a knowledge base that is not the
 * daemon's launch project, the bare `vnodes pipeline "<task>"` printed here
 * reproduces a DIFFERENT project's capsule for whoever pastes it.
 */
function capsuleForUi(capsule, task, cfg, projectFlag = null) {
  const CLIP_HEAD_CHARS = 2000;
  return {
    ...capsule,
    pivots: capsule.pivots.map(p => {
      const out = { file: p.file, tokens: p.tokens };
      if (p.clipped) {
        out.clipped = true;
        out.full_tokens = p.full_tokens;
        out.content = String(p.content || '').slice(0, CLIP_HEAD_CHARS);
        out.content_is_head_of_clip = true;
      }
      return out;
    }),
    skeletons: capsule.skeletons.map(s => ({ file: s.file, tokens: s.tokens, detail: s.detail })),
    stripped: 'file bodies are not sent to the UI; only the head of a clipped pivot is',
    baseline: cfg.capsule.savings_baseline,
    command: `vnodes pipeline ${JSON.stringify(task)}${projectFlag ? ` --project ${projectFlag}` : ''}`,
  };
}

/**
 * What the index is actually made of.
 *
 * /status and doctor both reported healthy while 78% of this index was a
 * headless-Chrome profile, because neither of them looks at where the files
 * are or how big they are — index_status counts languages, and "173 json" is a
 * true sentence about a browser cache. Grouping on the first two path segments
 * is what makes `ui/.shots` its own row instead of a number hiding inside `ui`.
 */
/**
 * `projectRoot` is optional so the store-only callers (and their tests) keep
 * working; without it the page simply has no exclusions section rather than
 * inventing an empty one, which would read as "nothing was excluded".
 */
function composition(engDir, projectRoot) {
  const { openStoreReadOnly } = require('./store');
  // Read-only, and null rather than an empty page when there is no store: this
  // is reached by a GET that may name any registered knowledge base, and
  // openStore would have created an index.db inside it to answer.
  const db = openStoreReadOnly(engDir);
  if (!db) return null;
  const files = db.prepare('SELECT path, repo, lang, size FROM files').all();
  const symbols = new Map(db.prepare('SELECT file, COUNT(*) c FROM nodes GROUP BY file').all().map(r => [r.file, Number(r.c)]));
  const connected = new Set();
  for (const e of db.prepare('SELECT src_file, dst_file FROM edges').all()) {
    connected.add(e.src_file); connected.add(e.dst_file);
  }
  db.close();

  const dirs = new Map();
  for (const f of files) {
    const parts = String(f.path).split('/');
    parts.pop(); // the filename is not a directory
    const dir = parts.slice(0, 2).join('/') || '(root)';
    let row = dirs.get(dir);
    if (!row) dirs.set(dir, row = { dir, files: 0, bytes: 0, langs: {}, inert: 0 });
    row.files++;
    row.bytes += Number(f.size || 0);
    row.langs[f.lang || 'unknown'] = (row.langs[f.lang || 'unknown'] || 0) + 1;
    if (!symbols.get(f.path) && !connected.has(f.path)) row.inert++;
  }
  const byDir = [...dirs.values()].sort((a, b) => b.files - a.files);

  // A remedy is a line to copy, never a write: the daemon diagnosing its own
  // index is useful, the daemon editing .vnodesignore behind the operator's
  // back is the same class of surprise as a UI that saves observations.
  const ignoreSuggestion = byDir
    .filter(d => d.dir !== '(root)' && d.files >= 5 && d.inert / d.files >= 0.9)
    .slice(0, 5)
    .map(d => `${d.dir}/`);

  const LIST_CAP = 50;
  const noSymbols = files.filter(f => !symbols.get(f.path)).map(f => f.path);
  const noEdges = files.filter(f => !connected.has(f.path)).map(f => f.path);

  // What is on disk and deliberately absent. The page that answers "what is in
  // here" is not finished until it also answers "and what is not, and why".
  let excluded = null;
  if (projectRoot) {
    try {
      const { excludedSummary } = require('./exclusions');
      const report = excludedSummary(projectRoot);
      excluded = {
        subtrees: report.subtrees,
        files: report.files,
        by_source: report.by_source,
        truncated: report.truncated,
      };
    } catch (e) {
      excluded = { error: e.message };
    }
  }

  return {
    total_files: files.length,
    total_bytes: files.reduce((a, f) => a + Number(f.size || 0), 0),
    excluded,
    by_dir: byDir.slice(0, 12).map(({ inert, ...row }) => ({ ...row, inert_files: inert })),
    by_dir_shown: Math.min(12, byDir.length),
    by_dir_total: byDir.length,
    largest: [...files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0)).slice(0, 10)
      .map(f => ({ path: f.path, size: Number(f.size || 0), lang: f.lang, symbols: symbols.get(f.path) || 0 })),
    // Capped, and the count says how far past the cap it goes: a repo where
    // four thousand files parsed to nothing is exactly the repo where this
    // response must not be four thousand strings long.
    no_symbols: noSymbols.slice(0, LIST_CAP),
    no_symbols_total: noSymbols.length,
    no_edges: noEdges.slice(0, LIST_CAP),
    no_edges_total: noEdges.length,
    list_cap: LIST_CAP,
    ignore_suggestion: ignoreSuggestion,
  };
}

/**
 * The read-only data family behind the operator pages.
 *
 * None of these go through callTool. Every callTool invocation inserts an
 * observation (BR-013), so a panel that polls would fill the memory feed agents
 * read with rows summarising its own polling — which is both noise and a lie
 * about what happened in the session. Calling buildCapsule / sessionContext /
 * searchMemory / doctor directly is the pattern src/view/index.js already uses
 * for the map, and it writes nothing.
 */
/**
 * Whole-index work this knowledge base is too big for, or null.
 *
 * Not a taste judgement. composition() reads every row of `files` plus a full
 * edge scan into JS Maps; buildCapsule was measured at 18,648 ms and subgraph
 * at 7,850 ms against the home knowledge base — all of it synchronous, on the
 * daemon's single event loop, which means every other page in every other tab
 * stops for the duration. A 413 that names the file count and the size is a
 * better answer than a daemon that appears to have hung.
 */
function oversizeRefusal(root, entry, cfg, what) {
  const rcfg = registryCfg(cfg);
  const { engineDbBytes } = require('./registry');
  const dbBytes = engineDbBytes(engineDirPath(root));
  const files = entry && Number.isFinite(entry.files) ? entry.files : null;
  const limitBytes = rcfg.oversize_db_mb * 1024 * 1024;
  const over = (files !== null && files > rcfg.oversize_files) || (dbBytes !== null && dbBytes > limitBytes);
  if (!over) return null;
  return {
    error: `${what} is refused for this knowledge base: it is too large to compute in one synchronous pass`,
    files, db_bytes: dbBytes,
    limits: { oversize_files: rcfg.oversize_files, oversize_db_mb: rcfg.oversize_db_mb },
    hint: 'ask a narrower question — the map accepts ?target= or ?path= to scope a slice — or disown this index if it was indexed by accident (vnodes kb list shows why)',
  };
}

/**
 * composition(), remembered per index generation.
 *
 * It is the most expensive read on the /ui surface — every file row plus a full
 * edge scan — and the answer cannot change while the index has not been
 * rewritten. Keyed on the engine directory and the index database's mtime, so a
 * re-index invalidates it without anyone having to remember to. Eight entries:
 * enough for a reader flipping between knowledge bases, small enough that the
 * cache is never the thing holding a hundred megabytes of row objects alive.
 */
const COMPOSITION_CACHE_MAX = 8;
const compositionCache = new Map();
function cachedComposition(engDir, root) {
  let stamp = 0;
  try { stamp = fs.statSync(path.join(engDir, 'index.db')).mtimeMs; } catch {}
  const key = `${engDir}@${stamp}`;
  if (compositionCache.has(key)) return compositionCache.get(key);
  const value = composition(engDir, root);
  compositionCache.set(key, value);
  while (compositionCache.size > COMPOSITION_CACHE_MAX) {
    compositionCache.delete(compositionCache.keys().next().value);
  }
  return value;
}

/**
 * The read-only data family behind the operator pages, for ONE knowledge base.
 *
 * `ctx.root` came out of resolveKb, which means it is either the daemon's own
 * launch project or the `path` field of a registry record vnodes wrote. It is
 * never a string a caller supplied. `ctx.engDir` is engineDirPath, not
 * engineDir: this runs on every request, and the creating version would mkdir
 * `.vnodes/logs` and write a `.gitignore` inside whatever project the URL named.
 */
function uiApi(pathname, q, ctx, send) {
  const { root, engDir, cfg, kb, kbSource, entry, launchRoot } = ctx;
  const projectFlag = root === launchRoot ? null : root;
  if (pathname === '/ui/api/health') {
    const { llmState, runtimeInfo, runtimeCliFound } = require('./runtime');
    // doctor() is async (it probes the port) and createServer's callback is not,
    // so the response is written from the promise rather than returned.
    doctor(root).then(d => send(200, {
      // Which project these numbers are about, and whether the URL said so or
      // the daemon fell back to its own. A page that cannot tell the difference
      // is a page that will eventually show one project's health under
      // another's name.
      kb, kb_source: kbSource, project: root,
      doctor: d,
      llm: { ...llmState(root), mode: 'runtime-cli', runtime: runtimeInfo(root), runtime_cli_found: runtimeCliFound(root) },
      config: loadConfig(root),
      logs: { daemon: tailLog(root, 'daemon'), index: tailLog(root, 'index'), tail_lines: 50 },
    })).catch(e => send(500, { error: e.message }));
    return;
  }
  if (pathname === '/ui/api/capsule') {
    const task = String(q.task || '').trim();
    if (!task) return send(400, { error: 'no task' });
    const refusal = oversizeRefusal(root, entry, cfg, 'building a capsule');
    if (refusal) return send(413, { kb, ...refusal });
    const { buildCapsule } = require('./capsule');
    const capsule = buildCapsule(root, engDir, cfg, {
      task,
      preset: q.preset || undefined,
      max_tokens: clamp(q.max_tokens, 500, 200000, undefined),
      session: 'ui',
    });
    return send(200, { kb, ...capsuleForUi(capsule, task, cfg, projectFlag) });
  }
  if (pathname === '/ui/api/notes') {
    const { searchMemory, sessionContext } = require('./memory');
    const limit = clamp(q.limit, 1, 100, 20);
    // Never created to answer a GET. A knowledge base with no memory store is a
    // real, sayable state — "no agent has recorded anything here yet" — and
    // saying it is better than the daemon writing a memory.db into a project
    // from a surface documented as read-only.
    const memDb = path.join(engDir, 'memory.db');
    if (!fs.existsSync(memDb)) {
      return send(404, {
        kb, error: 'this knowledge base has no memory store yet', expected: memDb,
        detail: 'observations are written by agents through the MCP tools; nothing has written one for this project',
      });
    }
    const counts = observationCounts(engDir);
    // No `session` on either call: this daemon is not an agent session, and
    // passing one would sort the browser's own reads to the top of a feed whose
    // whole point is what the agents did.
    const query = String(q.q || '').trim();
    // Stated rather than assumed: staleness flags are as of the last write by
    // an indexer or an agent. Refreshing them is an UPDATE, and this surface
    // does not write.
    const staleness = {
      staleness_refreshed: false,
      staleness_note: 'stale flags are as of the last index run or agent call; the read-only UI does not re-check them',
    };
    return query
      ? send(200, { kb, query, results: searchMemory(engDir, query, { limit, readOnly: true }), counts, ...staleness })
      : send(200, { kb, observations: sessionContext(engDir, { limit, readOnly: true }), counts, ...staleness });
  }
  if (pathname === '/ui/api/composition') {
    const refusal = oversizeRefusal(root, entry, cfg, 'index composition');
    if (refusal) return send(413, { kb, ...refusal });
    const c = cachedComposition(engDir, root);
    return c
      ? send(200, { kb, ...c })
      : send(404, { kb, error: 'this knowledge base has no index database', expected: path.join(engDir, 'index.db') });
  }
  return send(404, { error: 'no such api route', api: UI_API_ROUTES });
}

/**
 * Exactly one daemon per project writes the index.
 *
 * A second daemon on the same project is a normal thing to want — the macOS app
 * runs its own on a private port while a terminal keeps one on the configured
 * one — and until now both watched the same files and both called runIndex
 * against the same SQLite file. The result was a steady stream of
 * `watcher re-index failed: database is locked`, one of the two never seeing a
 * change it was told about, and, worse, the newcomer overwriting the pidfile so
 * `vnodes daemon stop` reached for the wrong process.
 *
 * Readers do not need to be the writer: a follower serves out of the same
 * database the owner keeps current, so its answers are as fresh as the owner's.
 * Only writing is exclusive.
 */
function claimIndexing(projectRoot, port) {
  const state = daemonState(projectRoot);
  if (state.running && state.pid !== process.pid) return false;
  fs.writeFileSync(pidFile(projectRoot), JSON.stringify({ pid: process.pid, port }));
  return true;
}

/**
 * Serve one daemon.
 *
 * `projectRoot` may be null: that is HUB MODE, which the macOS app runs in. A
 * hub owns no project, so it indexes nothing, watches nothing, claims no
 * pidfile and registers nothing — it serves the registry, and every scoped
 * route demands a ?kb= because there is no launch project to fall back to.
 * That is the whole fix for "opening the app always shows the vnodes repo":
 * the app's daemon no longer has a project it could be wrong about.
 */
function serve(projectRoot) {
  const hub = !projectRoot;
  const cfg = loadConfig(projectRoot);
  /** The last on-disk scan for knowledge bases, or null if none has run. */
  let lastDiscovery = null;
  const port = cfg.mcp.port;
  // The hub has no .vnodes/logs to write into, and path.join(null, …) throws
  // inside a request listener, which takes the whole daemon down.
  const dlog = msg => { if (projectRoot) log(projectRoot, 'daemon', msg); };
  // The port actually bound, which is not cfg.mcp.port when the caller asked
  // for an ephemeral one. The Origin/Host rules compare against it, so they
  // must not read a 0 the kernel already replaced.
  let actualPort = port;
  const boundPort = () => actualPort;
  let owner = false;
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
    };
    if (req.method === 'GET' && req.url === '/status') {
      // UI must distinguish daemon-stopped from empty-index (ERR-005) — this
      // endpoint answering at all means the daemon is up; body carries index state.
      // Deliberately NOT overloaded with an array of projects: doctor() fetches
      // this against a foreign daemon and reads `project` to name the collision.
      // In hub mode that field is null, which is the true answer.
      return send(200, hub
        ? { daemon: 'running', pid: process.pid, port, project: null, index: { state: 'hub' }, workspace: null }
        : { daemon: 'running', pid: process.pid, port, project: projectRoot, index: indexStatus(projectRoot), workspace: loadWorkspace(projectRoot)?.name || null });
    }
    if (req.method === 'GET' && req.url === '/tools') return send(200, { tools: TOOL_DEFS });
    // Parsing moved up here from inside the /ui branch, which means it now runs
    // on every request — and `new URL('//', base)` throws, which in a request
    // listener takes the whole daemon down. Answer it as the bad request it is.
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); }
    catch { return send(400, { error: 'malformed url', url: req.url }); }
    // Gate on the parsed pathname, not on the raw URL's prefix. `startsWith('/ui')`
    // matched /uifoo and /ui-anything, and the branch ended in a catch-all that
    // returned 200 plus the status page for every unknown path under it. With
    // five real pages, that turns a typo in a shared link into a successful
    // response drawing the wrong screen — the exact failure "omission is never
    // silent" exists to rule out.
    if (req.method === 'GET' && (url.pathname === '/ui' || url.pathname.startsWith('/ui/'))) {
      const q = Object.fromEntries(url.searchParams);
      if (url.pathname === '/ui/theme.css') return send(200, uiThemeCss(), 'text/css');
      if (url.pathname.startsWith('/ui/static/')) {
        const { readAsset } = require('./view/shell');
        const asset = readAsset(url.pathname.slice('/ui/static/'.length));
        if (!asset) return send(404, { error: 'no such asset', asset: url.pathname });
        // The bundle is content-addressed by the commit it ships in, not by a
        // hash in its name, so it must not be cached across a rebuild.
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
        return res.end(asset.body);
      }
      // The plain-HTML floor. Kept deliberately: it is the one page that still
      // renders when the bundle is missing or the app throws on boot, it needs
      // no JavaScript beyond a fetch loop, and it is what keeps
      // cfg.ui.sidebar_refresh_s a setting that does something.
      if (url.pathname === '/ui/status') return send(200, uiHtml(cfg), 'text/html');

      // The picker's payload. Global on purpose: it takes no ?kb= and must
      // never grow one — it is the list you consult to learn what the ids are.
      const scoped = url.pathname === '/ui/map/data' || url.pathname === '/ui/map/events'
        || url.pathname === '/ui/map/node' || url.pathname.startsWith('/ui/api/');
      if (scoped) {
        const denial = uiDenial(req, boundPort());
        if (denial) {
          dlog(`ui data refused: ${denial} for ${url.pathname}`);
          return send(403, { error: `refused: ${denial}`, detail: 'the /ui data routes answer this daemon\'s own pages only' });
        }
      }
      if (url.pathname === '/ui/api/kbs') {
        // The scan is reported with the list because a short list and a scan
        // that gave up look identical otherwise, and one of them is a bug.
        return send(200, { ...listKbs({ launchRoot: projectRoot, cfg }), discovery: lastDiscovery });
      }

      if (scoped) {
        /**
         * One resolution per request, and the only one anywhere.
         *
         * `q.kb` is a registry KEY. resolveKb looks it up and hands back a root
         * that came out of a file vnodes itself wrote; it never joins caller
         * text into a path. Every failure is a 404 (or a 400 when a hub was
         * given nothing to work with) and NEVER a fall back to the launch
         * project: a 200 drawn from the wrong project is exactly the failure
         * the /ui path-prefix fix was written to eliminate.
         */
        const r = resolveKb(q.kb, projectRoot);
        if (!r.ok) return send(r.code === 'no_default' ? 400 : 404, { ...r, hint: 'ids come from /ui/api/kbs' });
        const root = r.root;
        const engDir = engineDirPath(root);
        // The knowledge base's own config, not the daemon's: token budgets, map
        // node caps and refresh intervals are per-project settings, and reading
        // one project's numbers under another's config is a quiet lie.
        const kcfg = r.source === 'query' ? loadConfig(root) : cfg;

        if (url.pathname === '/ui/map/data') {
          // The payload the page draws. Also the honest answer to "what does the
          // map know" for anything that is not a browser.
          if (!q.target && !q.path) {
            const refusal = oversizeRefusal(root, r.entry, kcfg, 'an unscoped map of the whole index');
            if (refusal) return send(413, { kb: r.id, ...refusal });
          }
          const { mapView } = require('./view');
          return send(200, mapView(root, engDir, kcfg, q));
        }
        if (url.pathname === '/ui/map/events') {
          return mapEvents(req, res, root, kcfg, q, {
            kb: r.id,
            // True only when this daemon is the one whose watcher re-indexes
            // this project. The page used to set live=true because the socket
            // opened, which for a knowledge base nothing indexes is a permanent
            // lie — and for the home knowledge base, whose indexStamp is 0
            // forever, a permanent lie that never even changes frame.
            watched_by_this_daemon: !hub && root === projectRoot && owner,
          });
        }
        if (url.pathname === '/ui/map/node') {
          const { fileDetail } = require('./view/data');
          const detail = fileDetail(engDir, q.file || '');
          return detail ? send(200, detail) : send(404, { error: 'not indexed', file: q.file || '', kb: r.id });
        }
        try {
          return uiApi(url.pathname, q, {
            root, engDir, cfg: kcfg, kb: r.id, kbSource: r.source, entry: r.entry, launchRoot: projectRoot,
          }, send);
        } catch (e) {
          dlog(`ui api failed on ${url.pathname}: ${e.message}`);
          return send(500, { error: e.message, route: url.pathname, kb: r.id });
        }
      }
      const { PAGES, renderShell } = require('./view/shell');
      if (PAGES.has(url.pathname)) return send(200, renderShell(url.pathname), 'text/html');
      return send(404, { error: 'no such page', pages: [...PAGES.keys()], api: UI_API_ROUTES });
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      // /rpc reaches every tool, including save_observation and workspace_setup,
      // and until now it accepted a cross-origin POST with content-type
      // text/plain — which is a CORS-simple request, so any page in the
      // reader's browser could fire it with no preflight and no consent.
      // Binding to 127.0.0.1 is not a defence: the browser is on 127.0.0.1 too.
      // Demanding application/json forces a preflight the Origin rule then
      // fails; the CLI and MCP clients send no Origin at all, so nothing
      // legitimate changes.
      // A hub owns no project, so there is nothing for a tool to run against.
      // Answering 400 is honest; picking a project for the caller is not.
      if (hub) return send(400, { ok: false, error: 'this daemon has no launch project (hub mode); run tools against a project daemon or use the CLI' });
      const denial = rpcDenial(req, boundPort());
      if (denial) {
        dlog(`rpc refused: ${denial}`);
        return send(403, { ok: false, error: `refused: ${denial}` });
      }
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { tool, arguments: args, session } = JSON.parse(body || '{}');
          const result = callTool(projectRoot, tool, args || {}, session || 'http');
          send(200, { ok: true, result });
        } catch (e) {
          dlog(`rpc error: ${e.message}`);
          send(400, { ok: false, error: e.message });
        }
      });
      return;
    }
    const { PAGES } = require('./view/shell');
    send(404, {
      error: 'not found',
      endpoints: ['/status', '/tools', '/rpc', ...PAGES.keys(), '/ui/status', '/ui/theme.css',
        '/ui/static/*', '/ui/map/data', '/ui/map/events', '/ui/map/node', ...UI_API_ROUTES],
    });
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      // Port taken (ERR-007): name the fix, don't crash silently.
      dlog(`port ${port} in use — set VNODES_PORT or .vnodes/config.json mcp.port and restart`);
      console.error(`vnodes daemon: port ${port} in use. Fix: set VNODES_PORT=<port> or "mcp": {"port": <port>} in .vnodes/config.json`);
      process.exit(1);
    }
    throw e;
  });
  let stopWatcher = null;
  /**
   * Take over indexing if nobody else holds it.
   *
   * Retried on a timer rather than decided once at boot, so a follower that
   * outlives the owner starts watching instead of serving a frozen index.
   * A hub never takes it: it has no project to index.
   */
  const takeIndexing = () => {
    if (hub || owner || !claimIndexing(projectRoot, actualPort)) return;
    owner = true;
    if (cfg.index.watch !== false) stopWatcher = startWatcher(projectRoot, cfg);
    dlog(`indexing owned by pid=${process.pid} watch=${cfg.index.watch !== false}`);
  };

  server.listen(port, '127.0.0.1', () => {
    actualPort = server.address().port;
    takeIndexing();
    // W2. The launch project is listed the first time its daemon runs, which is
    // also the whole migration path: a project indexed before the registry
    // existed self-registers here, so there is no scan job and no backfill.
    // Nothing is indexed by this — a project with no index.db is not listed.
    if (!hub) { try { ensureEntry(projectRoot, 'daemon', { cfg }); } catch {} }
    dlog(`daemon started pid=${process.pid} port=${actualPort} owner=${owner}`);
    console.log(`vnodes daemon running on http://127.0.0.1:${actualPort} (status: /status, ui: ${hub ? '/ui/bases' : '/ui'})`);
    if (hub) console.log('hub mode: no launch project — /ui is the knowledge-base picker; scoped pages need ?kb=<id>');
    // A hub's whole job is the list, and a list that only fills as projects
    // happen to be reindexed starts empty on a machine full of them. Deferred
    // off the listen callback so the port answers immediately: the scan is a
    // few thousand statSync calls and the picker must not wait on it.
    if (hub) {
      setTimeout(() => {
        try {
          const { discover } = require('./registry');
          lastDiscovery = discover({ cfg });
          console.log(`discovered ${lastDiscovery.found.length} knowledge base(s) in ${lastDiscovery.scanned} directories` +
            (lastDiscovery.registered.length ? `, ${lastDiscovery.registered.length} newly registered` : '') +
            (lastDiscovery.truncated ? ` (scan stopped early: ${lastDiscovery.stopped_by})` : ''));
        } catch (e) {
          lastDiscovery = { error: e.message };
        }
      }, 50).unref?.();
    }
    else if (!owner) console.log('another daemon owns indexing for this project; serving reads only');
  });
  const claimTimer = setInterval(takeIndexing, 5000);
  claimTimer.unref?.();

  const stop = () => {
    stopWatcher?.();
    stopWatcher = null;
    clearInterval(claimTimer);
    // Only the owner wrote the pidfile, so only the owner may remove it —
    // a follower unlinking it would leave `vnodes daemon stop` with nothing
    // to stop and the real indexer still running.
    if (owner) { try { fs.unlinkSync(pidFile(projectRoot)); } catch {} }
    try { server.close(); } catch {}
  };
  const shutdown = () => {
    dlog('daemon stopped');
    stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Returned so a caller that started this in-process — the tests do — can shut
  // it down and learn which port the kernel actually handed out. The CLI
  // ignores it and keeps running in the foreground exactly as before.
  return { server, close: stop, port: () => actualPort };
}

// A null projectRoot starts a hub: no project, no watcher, the registry and the
// picker only. cwd still has to be something real for spawn, so it is this
// package — which the hub never reads a config or an index out of.
function startDetached(projectRoot) {
  const args = [path.join(__dirname, '..', 'bin', 'vnodes.js'), 'daemon', 'run'];
  if (!projectRoot) args.push('--hub');
  const child = spawn(process.execPath, args,
    { cwd: projectRoot || path.join(__dirname, '..'), detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// Auto-restart contract (BR-024): call a tool over HTTP; if the daemon is down,
// start it and retry.
async function httpCall(projectRoot, tool, args, session) {
  const cfg = loadConfig(projectRoot);
  // The content-type is load-bearing, not decoration: /rpc refuses anything but
  // application/json, because text/plain is a CORS-simple type and accepting it
  // is what let a cross-origin page call the write tools. fetch() would default
  // this body to text/plain.
  const attempt = () => fetch(`http://127.0.0.1:${cfg.mcp.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args, session }),
  }).then(r => r.json());
  try { return await attempt(); }
  catch {
    startDetached(projectRoot);
    await new Promise(r => setTimeout(r, 700));
    return attempt();
  }
}

function stopDaemon(projectRoot) {
  const st = daemonState(projectRoot);
  if (!st.running) {
    if (st.stale_pidfile) fs.unlinkSync(pidFile(projectRoot));
    return { stopped: false, reason: st.stale_pidfile ? 'stale pidfile removed' : 'not running' };
  }
  process.kill(st.pid, 'SIGTERM');
  return { stopped: true, pid: st.pid };
}

// Read-only doctor (BR-026, ERR-006): diagnoses without a running daemon.
async function doctor(projectRoot) {
  const cfg = loadConfig(projectRoot);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, ok, detail });

  add('config', !cfg._config_error, cfg._config_error || 'defaults + .vnodes/config.json parsed');
  const st = indexStatus(projectRoot);
  // `incomplete` is its own failing check with its own reason. It used to be
  // reported as ready, because ready rested on index.db existing — which is how
  // the one knowledge base most in need of disowning is the one this page called
  // healthy.
  add('index', st.state === 'ready',
    st.state === 'incomplete'
      ? `state: incomplete — ${st.detail}${st.nodes ? ` (the store holds ${st.nodes} nodes / ${st.files} files / ${st.edges} edges from an unfinished run)` : ''}`
      : `state: ${st.state}${st.nodes ? `, ${st.nodes} nodes / ${st.files} files / ${st.edges} edges` : ''}`);

  // Index speed vs the configured targets (first_run_target_s for a from-scratch
  // build, manifest_rebuild_target_s for incremental runs).
  if (st.last_index_ms) {
    const targetS = st.last_index_first_run ? cfg.index.first_run_target_s : cfg.index.manifest_rebuild_target_s;
    const kind = st.last_index_first_run ? 'first run' : 'incremental';
    add('index-speed', st.last_index_ms <= targetS * 1000,
      `last ${kind} took ${(st.last_index_ms / 1000).toFixed(2)}s (target ${targetS}s)`);
  }

  const eng = path.join(projectRoot, '.vnodes');
  const manifest = path.join(eng, 'manifest.json');
  add('manifest', fs.existsSync(manifest), fs.existsSync(manifest) ? 'committed manifest present' : 'missing — run: vnodes index');

  // Workspace drift: workspace.json repos that don't exist on disk.
  const ws = loadWorkspace(projectRoot);
  if (ws) {
    const missing = ws.repos.filter(r => !fs.existsSync(path.resolve(ws.baseDir, r.path)));
    add('workspace', missing.length === 0,
      missing.length ? `drift: missing repos ${missing.map(r => r.alias).join(', ')}` : `workspace "${ws.name}" (${ws.repos.length} repos) resolves`);
  }

  const ds = daemonState(projectRoot);
  add('daemon', true, ds.running ? `running pid=${ds.pid} port=${ds.port}` : ds.stale_pidfile ? `stale pidfile (pid ${ds.pid} dead) — will auto-restart on next tool call` : 'stopped — auto-restarts on tool call');

  // Transport: is the configured port free, held by our daemon, or held by a
  // vnodes daemon serving another project? The last case is healthy — daemons
  // are per-project but share the default port, and stdio transport (the
  // default) doesn't touch the port at all.
  const portFree = await new Promise(res => {
    const s = net.createServer().once('error', () => res(false)).once('listening', () => { s.close(); res(true); });
    s.listen(cfg.mcp.port, '127.0.0.1');
  });
  let holder = null;
  if (!portFree && !ds.running) {
    try {
      const r = await fetch(`http://127.0.0.1:${cfg.mcp.port}/status`, { signal: AbortSignal.timeout(500) });
      const j = await r.json();
      if (j && j.daemon === 'running') holder = j;
    } catch {}
  }
  add('transport', ds.running ? !portFree : (portFree || !!holder),
    ds.running ? (portFree ? 'pidfile says running but port is free — kill stale daemon' : `port ${cfg.mcp.port} held by daemon`)
      : portFree ? `port ${cfg.mcp.port} free for HTTP transport (stdio is default)`
        // `project: null` is the hub, not an unknown project: the app's daemon
        // deliberately owns none, and saying "another project" there would
        // invent one.
        : holder ? `port ${cfg.mcp.port} held by vnodes daemon ${holder.project ? `for ${holder.project}` : '(no project — hub mode)'} (pid ${holder.pid}) — stdio unaffected; set VNODES_PORT for HTTP here`
          : `port ${cfg.mcp.port} taken by a non-vnodes process — set VNODES_PORT`);

  // LLM layer: state machine says enabled, but does the runtime CLI exist?
  const { llmState, runtimeInfo, runtimeCliFound } = require('./runtime');
  const llm = llmState(projectRoot);
  if (llm.state === 'running') {
    const rt = runtimeInfo(projectRoot);
    const found = runtimeCliFound(projectRoot);
    add('llm-runtime', found,
      found ? `runtime '${rt.provider}' (${rt.cli}) on PATH` : `llm enabled but runtime CLI '${rt.cli}' not on PATH — intent falls back to rule-based`);
  }

  // Agent config presence.
  const mcpJson = path.join(projectRoot, '.mcp.json');
  let registered = false;
  if (fs.existsSync(mcpJson)) {
    try { registered = !!JSON.parse(fs.readFileSync(mcpJson, 'utf8')).mcpServers?.vnodes; } catch {}
  }
  add('agent-config', true, registered ? 'vnodes registered in project .mcp.json' : 'not in project .mcp.json — run: vnodes setup (or rely on user-scope registration)');

  return { project: projectRoot, checks, healthy: checks.every(c => c.ok) };
}

/**
 * Live map frames.
 *
 * Pushed on index generation change, not on a timer: re-rendering an unchanged
 * graph every few seconds would burn CPU on a background tab and, with a
 * capsule task in the query, re-run the whole context pipeline to produce a
 * byte-identical frame. The keepalive comment holds the connection open through
 * proxies without carrying a payload.
 */
function mapEvents(req, res, projectRoot, cfg, query, hello = {}) {
  const { mapView } = require('./view');
  const { indexStamp } = require('./view/data');
  const engDir = engineDirPath(projectRoot);
  const everyMs = ((cfg.ui && cfg.ui.map_refresh_s) || 3) * 1000;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let stamp = indexStamp(engDir);

  /**
   * One `hello` frame, before any data frame.
   *
   * "Live" used to mean nothing more than that the socket opened, so a
   * knowledge base no daemon is watching rendered as live forever — and for the
   * home knowledge base, whose meta table is empty and whose indexStamp is
   * therefore 0 for all time, live and permanently frozen at once. This says
   * which of the three real states it is: watched by this daemon, watched by
   * another daemon (whose pid is in that project's own pidfile), or static.
   */
  let ownerPid = null;
  try { ownerPid = JSON.parse(fs.readFileSync(path.join(projectRoot, '.vnodes', 'daemon.pid'), 'utf8')).pid ?? null; } catch {}
  if (ownerPid !== null) {
    try { process.kill(ownerPid, 0); } catch { ownerPid = null; } // a dead pid is not an indexer
  }
  try {
    res.write(`event: hello\ndata: ${JSON.stringify({
      kb: hello.kb ?? null,
      watched_by_this_daemon: !!hello.watched_by_this_daemon,
      owner_pid: hello.watched_by_this_daemon ? process.pid : ownerPid,
      last_index: stamp || null,
      refresh_s: everyMs / 1000,
    })}\n\n`);
  } catch {}

  const timer = setInterval(() => {
    let next;
    try { next = indexStamp(engDir); } catch { return; }
    if (next === stamp) { res.write(': keepalive\n\n'); return; }
    stamp = next;
    // The same payload /ui/map/data returns. One shape, so a live frame and a
    // fresh load cannot drift into rendering differently.
    try { res.write(`data: ${JSON.stringify(mapView(projectRoot, engDir, cfg, query))}\n\n`); }
    catch (e) { log(projectRoot, 'daemon', `map frame failed: ${e.message}`); }
  }, everyMs);
  timer.unref?.();
  req.on('close', () => clearInterval(timer));
}

function uiHtml(cfg) {
  // The no-JS floor at /ui/status. This page exists precisely because the rest
  // of /ui is now a React bundle: when the bundle is missing, stale or throws
  // on boot, something still has to answer the question "is the daemon alive
  // and what does it think it has indexed", and it has to answer without
  // depending on any of the machinery that might be what broke. Plain HTML, one
  // fetch loop, no build step. It is also the only remaining reader of
  // cfg.ui.sidebar_refresh_s.
  return `<!doctype html><html><head><meta charset="utf-8"><title>vnodes — status</title>
<link rel="stylesheet" href="/ui/theme.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main>
<h1>vnodes</h1><p id="state">loading…</p>
<dl><dt>Files</dt><dd id="files">–</dd><dt>Nodes</dt><dd id="nodes">–</dd>
<dt>Edges</dt><dd id="edges">–</dd><dt>Repos</dt><dd id="repos">–</dd>
<dt>Last index</dt><dd id="last">–</dd></dl>
<p>This is the plain-HTML status page. It reports on this daemon's own launch
project only — the other pages can be pointed at any knowledge base with
<code>?kb=</code>, and this one cannot. The pages that explain the counts need
the built bundle:</p>
<ul>
<li><a href="/ui/bases">knowledge bases</a> — every indexed project this machine knows about</li>
<li><a href="/ui">overview</a> — doctor checks, language mix, logs</li>
<li><a href="/ui/map">dependency map</a></li>
<li><a href="/ui/capsule">capsule preview</a> — what an agent is handed for a task</li>
<li><a href="/ui/notes">notes &amp; staleness</a></li>
<li><a href="/ui/index">index composition</a> — what is actually indexed</li>
</ul>
<script>
async function tick(){try{const r=await fetch('/status');const s=await r.json();
if(s.index.state==='hub'){document.getElementById('state').textContent=
'hub — no launch project; pick a knowledge base at /ui/bases';
for(const k of ['files','nodes','edges','repos','last'])document.getElementById(k).textContent='– (no project)';
return;}
document.getElementById('state').textContent='daemon running · index '+s.index.state;
for(const k of ['files','nodes','edges'])document.getElementById(k).textContent=s.index[k]??'–';
document.getElementById('repos').textContent=(s.index.repos||[]).join(', ')||'–';
document.getElementById('last').textContent=s.index.last_index?new Date(s.index.last_index).toLocaleString():'–';
}catch(e){document.getElementById('state').textContent='daemon unreachable';}}
tick();setInterval(tick,${(cfg.ui.sidebar_refresh_s || 10) * 1000});
</script></main></body></html>`;
}

function uiThemeCss() {
  // Not the design-system seam any more — that moved into the bundle
  // (ui/src/theme.css) when the whole UI became one React shell. This
  // stylesheet dresses exactly two pages, and both of them are the ones that
  // have to render when the bundle does not: /ui/status and the missing-bundle
  // notice. Keep it small enough to never be the reason either fails.
  return `/* vnodes — the stylesheet for the pages that must work with no bundle:
   /ui/status and the missing-bundle notice. The design system lives in the
   bundle (ui/src/theme.css); nothing here is a seam for it. */
:root { color-scheme: light dark; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; line-height: 1.5; max-width: 46rem; }
dt { font-weight: 600; }
dd { margin: 0 0 0.5rem 0; }
code, pre { font-family: inherit; }`;
}

module.exports = {
  serve, startDetached, stopDaemon, daemonState, claimIndexing, doctor, httpCall,
  // Exported for the tests that pin the two guarantees this file now carries:
  // that /rpc refuses a cross-origin write, and that the UI's data routes are
  // computed without a tool call.
  rpcDenial, uiDenial, composition, capsuleForUi, observationCounts, tailLog,
  oversizeRefusal, UI_API_ROUTES,
};
