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
const { loadConfig, findProjectRoot, engineDir } = require('./config');
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

const UI_API_ROUTES = ['/ui/api/health', '/ui/api/capsule', '/ui/api/notes', '/ui/api/composition'];

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

/** How many observations there are, and of what kind. Lets the notes page say what it is looking at. */
function observationCounts(engDir) {
  const { openMemory } = require('./store');
  try {
    const db = openMemory(engDir);
    const r = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN kind = 'manual' THEN 1 ELSE 0 END) manual,
      SUM(CASE WHEN kind <> 'manual' THEN 1 ELSE 0 END) auto,
      SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END) stale FROM observations`).get();
    db.close();
    return { total: Number(r.total || 0), manual: Number(r.manual || 0), auto: Number(r.auto || 0), stale: Number(r.stale || 0) };
  } catch {
    return { total: 0, manual: 0, auto: 0, stale: 0 };
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
function capsuleForUi(capsule, task, cfg) {
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
    command: `vnodes pipeline ${JSON.stringify(task)}`,
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
function composition(engDir) {
  const { openStore } = require('./store');
  const db = openStore(engDir);
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

  return {
    total_files: files.length,
    total_bytes: files.reduce((a, f) => a + Number(f.size || 0), 0),
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
function uiApi(pathname, q, projectRoot, cfg, send) {
  const engDir = engineDir(projectRoot);
  if (pathname === '/ui/api/health') {
    const { llmState, runtimeInfo, runtimeCliFound } = require('./runtime');
    // doctor() is async (it probes the port) and createServer's callback is not,
    // so the response is written from the promise rather than returned.
    doctor(projectRoot).then(d => send(200, {
      doctor: d,
      llm: { ...llmState(projectRoot), mode: 'runtime-cli', runtime: runtimeInfo(projectRoot), runtime_cli_found: runtimeCliFound(projectRoot) },
      config: loadConfig(projectRoot),
      logs: { daemon: tailLog(projectRoot, 'daemon'), index: tailLog(projectRoot, 'index'), tail_lines: 50 },
    })).catch(e => send(500, { error: e.message }));
    return;
  }
  if (pathname === '/ui/api/capsule') {
    const task = String(q.task || '').trim();
    if (!task) return send(400, { error: 'no task' });
    const { buildCapsule } = require('./capsule');
    const capsule = buildCapsule(projectRoot, engDir, cfg, {
      task,
      preset: q.preset || undefined,
      max_tokens: clamp(q.max_tokens, 500, 200000, undefined),
      session: 'ui',
    });
    return send(200, capsuleForUi(capsule, task, cfg));
  }
  if (pathname === '/ui/api/notes') {
    const { searchMemory, sessionContext } = require('./memory');
    const limit = clamp(q.limit, 1, 100, 20);
    const counts = observationCounts(engDir);
    // No `session` on either call: this daemon is not an agent session, and
    // passing one would sort the browser's own reads to the top of a feed whose
    // whole point is what the agents did.
    const query = String(q.q || '').trim();
    return query
      ? send(200, { query, results: searchMemory(engDir, query, { limit }), counts })
      : send(200, { observations: sessionContext(engDir, { limit }), counts });
  }
  if (pathname === '/ui/api/composition') return send(200, composition(engDir));
  return send(404, { error: 'no such api route', api: UI_API_ROUTES });
}

function serve(projectRoot) {
  const cfg = loadConfig(projectRoot);
  const port = cfg.mcp.port;
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
    };
    if (req.method === 'GET' && req.url === '/status') {
      // UI must distinguish daemon-stopped from empty-index (ERR-005) — this
      // endpoint answering at all means the daemon is up; body carries index state.
      return send(200, { daemon: 'running', pid: process.pid, port, project: projectRoot, index: indexStatus(projectRoot), workspace: loadWorkspace(projectRoot)?.name || null });
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
      // The payload the page draws. Also the honest answer to "what does the map
      // know" for anything that is not a browser.
      if (url.pathname === '/ui/map/data') {
        const { mapView } = require('./view');
        return send(200, mapView(projectRoot, engineDir(projectRoot), cfg, q));
      }
      if (url.pathname === '/ui/map/events') return mapEvents(req, res, projectRoot, cfg, q);
      if (url.pathname === '/ui/map/node') {
        const { fileDetail } = require('./view/data');
        const detail = fileDetail(engineDir(projectRoot), q.file || '');
        return detail ? send(200, detail) : send(404, { error: 'not indexed', file: q.file || '' });
      }
      if (url.pathname.startsWith('/ui/api/')) return uiApi(url.pathname, q, projectRoot, cfg, send);
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
      const denial = rpcDenial(req, port);
      if (denial) {
        log(projectRoot, 'daemon', `rpc refused: ${denial}`);
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
          log(projectRoot, 'daemon', `rpc error: ${e.message}`);
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
      log(projectRoot, 'daemon', `port ${port} in use — set VNODES_PORT or .vnodes/config.json mcp.port and restart`);
      console.error(`vnodes daemon: port ${port} in use. Fix: set VNODES_PORT=<port> or "mcp": {"port": <port>} in .vnodes/config.json`);
      process.exit(1);
    }
    throw e;
  });
  let stopWatcher = null;
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(pidFile(projectRoot), JSON.stringify({ pid: process.pid, port }));
    if (cfg.index.watch !== false) stopWatcher = startWatcher(projectRoot, cfg);
    log(projectRoot, 'daemon', `daemon started pid=${process.pid} port=${port} watch=${cfg.index.watch !== false}`);
    console.log(`vnodes daemon running on http://127.0.0.1:${port} (status: /status, ui: /ui)`);
  });
  const shutdown = () => {
    log(projectRoot, 'daemon', 'daemon stopped');
    stopWatcher?.();
    try { fs.unlinkSync(pidFile(projectRoot)); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function startDetached(projectRoot) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'vnodes.js'), 'daemon', 'run'],
    { cwd: projectRoot, detached: true, stdio: 'ignore' });
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
  add('index', st.state === 'ready', `state: ${st.state}${st.nodes ? `, ${st.nodes} nodes / ${st.files} files / ${st.edges} edges` : ''}`);

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
        : holder ? `port ${cfg.mcp.port} held by vnodes daemon for ${holder.project || 'another project'} (pid ${holder.pid}) — stdio unaffected; set VNODES_PORT for HTTP here`
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
function mapEvents(req, res, projectRoot, cfg, query) {
  const { mapView } = require('./view');
  const { indexStamp } = require('./view/data');
  const engDir = engineDir(projectRoot);
  const everyMs = ((cfg.ui && cfg.ui.map_refresh_s) || 3) * 1000;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let stamp = indexStamp(engDir);
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
<p>This is the plain-HTML status page — it shows the counts and nothing else.
The pages that explain them need the built bundle:</p>
<ul>
<li><a href="/ui">overview</a> — doctor checks, language mix, logs</li>
<li><a href="/ui/map">dependency map</a></li>
<li><a href="/ui/capsule">capsule preview</a> — what an agent is handed for a task</li>
<li><a href="/ui/notes">notes &amp; staleness</a></li>
<li><a href="/ui/index">index composition</a> — what is actually indexed</li>
</ul>
<script>
async function tick(){try{const r=await fetch('/status');const s=await r.json();
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
  serve, startDetached, stopDaemon, daemonState, doctor, httpCall,
  // Exported for the tests that pin the two guarantees this file now carries:
  // that /rpc refuses a cross-origin write, and that the UI's data routes are
  // computed without a tool call.
  rpcDenial, composition, capsuleForUi, observationCounts, tailLog, UI_API_ROUTES,
};
