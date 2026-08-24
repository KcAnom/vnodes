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
const { resolveKb, listKbs, ensureEntry, registryCfg, forget } = require('./registry');
const { TOOL_DEFS, callTool } = require('./tools');
const { indexStatus } = require('./indexer');
const { loadWorkspace } = require('./workspace');
const { log, logPath } = require('./logs');
const { stalenessNotice } = require('./staleness');
const { uiHtml, uiThemeCss, uiNotFound } = require('./daemon/pages');
const { UI_API_ROUTES, uiApi, composition, cachedComposition, capsuleForUi,
        observationCounts, oversizeRefusal, tailLog } = require('./daemon/ui-api');
const { pidFile, daemonState, claimIndexing, startDetached, httpCall, stopDaemon,
        doctor } = require('./daemon/lifecycle');

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


/** Status.workspace: `{ name, repos: [{alias,path}] }` or null. Never a name string. */
function workspaceStatus(projectRoot) {
  const ws = loadWorkspace(projectRoot);
  if (!ws) return null;
  return {
    name: ws.name,
    repos: (ws.repos || []).map(r => ({ alias: r.alias, path: r.path })),
  };
}

/**
 * Vite's dev server sends Origin `http://127.0.0.1:5173` (or localhost:5173)
 * while the proxy rewrites Host to this daemon. Allow any loopback http Origin
 * port so the UI can load from :5173; Host must still be this daemon. Writes
 * still go through rpcDenial, which stays strict.
 */
function isLoopbackHttpOrigin(origin) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:') return false;
  // WHATWG hostname for IPv6 is `::1` (no brackets). The mac app and browsers
  // on some stacks speak [::1] as localhost.
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost'
    && u.hostname !== '::1' && u.hostname !== '[::1]') return false;
  if (u.username || u.password) return false;
  if (u.search || u.hash) return false;
  if (u.pathname && u.pathname !== '/') return false;
  return true;
}

function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/**
 * Why this /ui data request is refused, or null if it is allowed.
 *
 * The operator UI is /Applications/vnodes.app: mkmacapp WKWebView on
 * http://127.0.0.1:{boundPort}/ui/bases (hub, preferred_port auto). That
 * page is same-origin with the daemon. Host must still be this daemon's
 * bound port. Origin may be any loopback http port so a contributor Vite
 * tab (not the product) can read /ui/api/*; missing Origin is the WebView
 * or curl. rpcDenial stays strict: writes are not the app's job.
 */
function uiDenial(req, port) {
  const hosts = allowedHosts(port);
  const origin = req.headers.origin;
  if (origin !== undefined && !isLoopbackHttpOrigin(origin)) return `origin ${origin}`;
  if (!hosts.includes(req.headers.host || '')) return `host ${req.headers.host || '(none)'}`;
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'sec-fetch-site cross-site';
  return null;
}

/** Why this /rpc request is refused, or null if it is allowed. */
function rpcDenial(req, port) {
  const hosts = allowedHosts(port);
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
  // When this process loaded its code — see src/staleness.js.
  const startedMs = Date.now();
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
      // `port` is the bound port (actualPort after listen; the configured port
      // before). `workspace` matches the UI Status type: {name, repos} or null,
      // never a bare name string.
      return send(200, hub
        ? { daemon: 'running', pid: process.pid, port: boundPort(), project: null, index: { state: 'hub' }, workspace: null }
        : { daemon: 'running', pid: process.pid, port: boundPort(), project: projectRoot, index: indexStatus(projectRoot), workspace: workspaceStatus(projectRoot) });
    }
    if (req.method === 'GET' && req.url === '/tools') return send(200, { tools: TOOL_DEFS });
    // Parsing moved up here from inside the /ui branch, which means it now runs
    // on every request — and `new URL('//', base)` throws, which in a request
    // listener takes the whole daemon down. Answer it as the bad request it is.
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); }
    catch { return send(400, { error: 'malformed url', url: req.url }); }

    // Registry forget — the one write the operator UI is allowed. It removes
    // registry rows (the picker). It never indexes, never opens a project
    // sqlite, never runs rm -rf on .vnodes. Same contract as `vnodes kb forget`.
    if (req.method === 'POST' && url.pathname === '/ui/api/kbs/forget') {
      const denial = uiDenial(req, boundPort());
      if (denial) {
        dlog(`ui forget refused: ${denial}`);
        return send(403, { error: `refused: ${denial}`, detail: 'the /ui data routes answer this daemon\'s own pages only' });
      }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(403, { error: 'refused: application/json required' });
      }
      const maxBody = Number(cfg.mcp && cfg.mcp.max_body_bytes) > 0
        ? Number(cfg.mcp.max_body_bytes) : 1048576;
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', c => {
        if (tooBig) return;
        size += c.length;
        if (size > maxBody) {
          tooBig = true;
          send(413, { error: 'payload too large', limit: maxBody });
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8') || '{}');
          const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
          if (!ids.length) return send(400, { error: 'ids required' });
          if (ids.length > 200) return send(400, { error: 'too many ids', limit: 200 });
          const results = ids.map(id => forget(String(id)));
          return send(200, {
            forgotten: results.filter(r => r.ok).map(r => r.id),
            results,
          });
        } catch (e) {
          return send(400, { error: e.message });
        }
      });
      return;
    }

    // Gate on the parsed pathname, not on the raw URL's prefix. `startsWith('/ui')`
    // matched /uifoo and /ui-anything, and the branch ended in a catch-all that
    // returned 200 plus the status page for every unknown path under it. With
    // five real pages, that turns a typo in a shared link into a successful
    // response drawing the wrong screen — the exact failure "omission is never
    // silent" exists to rule out.
    if (req.method === 'GET' && (url.pathname === '/ui' || url.pathname.startsWith('/ui/'))) {
      const q = Object.fromEntries(url.searchParams);
      // A typed /ui/map/ is the map. Exact PAGES.has used to 404 it on first
      // load (the SPA cannot strip the slash until the bundle has run).
      // Static assets keep their trailing slash so a missing file stays missing.
      if (url.pathname.length > 1 && url.pathname.endsWith('/') && !url.pathname.startsWith('/ui/static/')) {
        url.pathname = url.pathname.replace(/\/+$/, '');
      }
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
          // Same oversize gate as /ui/map/data. An unscoped SSE stream would
          // re-run mapView on every index stamp and hold the event loop; a 413
          // JSON answer is the honest refusal, not a hello frame that then
          // never delivers a drawable graph.
          if (!q.target && !q.path) {
            const refusal = oversizeRefusal(root, r.entry, kcfg, 'an unscoped map of the whole index');
            if (refusal) return send(413, { kb: r.id, ...refusal });
          }
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
            doctor,
          }, send);
        } catch (e) {
          dlog(`ui api failed on ${url.pathname}: ${e.message}`);
          return send(500, { error: e.message, route: url.pathname, kb: r.id });
        }
      }
      const { PAGES, renderShell } = require('./view/shell');
      if (PAGES.has(url.pathname)) return send(200, renderShell(url.pathname), 'text/html');
      // A mistyped /ui path arrives from a browser's address bar far more often
      // than from a script, and a browser rendering this as raw JSON gets the
      // page names as quoted strings it cannot click — the same dead end the
      // plain status page had, reached by typo instead of by button. Negotiated
      // rather than switched outright: /ui/api callers and curl still want the
      // JSON, and it is the same list either way.
      if (String(req.headers.accept || '').includes('text/html')) {
        return send(404, uiNotFound(url.pathname), 'text/html');
      }
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
      const maxBody = Number(cfg.mcp && cfg.mcp.max_body_bytes) > 0
        ? Number(cfg.mcp.max_body_bytes) : 1048576;
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', c => {
        if (tooBig) return;
        size += c.length;
        if (size > maxBody) {
          tooBig = true;
          send(413, { ok: false, error: 'payload too large', limit: maxBody });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const body = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8');
          const { tool, arguments: args, session } = JSON.parse(body || '{}');
          const result = callTool(projectRoot, tool, args || {}, session || 'http');
          // Same vintage problem as the stdio server: this process has been
          // running since it was started and answers with the code it loaded
          // then. See src/staleness.js.
          const stale = stalenessNotice(startedMs);
          send(200, stale ? { ok: true, result, vnodes_stale: stale } : { ok: true, result });
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
    // Hub pidfile lives next to the registry, not inside a project .vnodes —
    // a hub has no project, and path.join(null, …) is how this used to crash.
    // It does not claim indexing: there is nothing to index.
    if (hub) {
      try {
        const pf = pidFile(null);
        fs.mkdirSync(path.dirname(pf), { recursive: true });
        fs.writeFileSync(pf, JSON.stringify({ pid: process.pid, port: actualPort }));
      } catch {}
    }
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
    // Only the owner wrote the project pidfile, so only the owner may remove
    // it — a follower unlinking it would leave `vnodes daemon stop` with
    // nothing to stop and the real indexer still running. A hub wrote
    // registryDir()/hub.pid instead (and never claimed indexing).
    if (hub || owner) { try { fs.unlinkSync(pidFile(projectRoot)); } catch {} }
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
module.exports = {
  serve, startDetached, stopDaemon, daemonState, claimIndexing, pidFile, doctor, httpCall,
  // Exported for the tests that pin the two guarantees this file now carries:
  // that /rpc refuses a cross-origin write, and that the UI's data routes are
  // computed without a tool call.
  rpcDenial, uiDenial, composition, capsuleForUi, observationCounts, tailLog,
  oversizeRefusal, UI_API_ROUTES,
  // The no-JS floor. Pinned because it is the one page that carries its own
  // navigation: the rail lives in the bundle, so a reader who follows the
  // rail's "plain" link arrives somewhere the rail cannot reach them.
  uiHtml, uiThemeCss, uiNotFound,
};
