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
    if (req.method === 'GET' && req.url.startsWith('/ui')) {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
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
      if (url.pathname === '/ui/map') {
        const { renderShell } = require('./view/shell');
        return send(200, renderShell(), 'text/html');
      }
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
      return send(200, uiHtml(cfg), 'text/html');
    }
    if (req.method === 'POST' && req.url === '/rpc') {
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
    send(404, { error: 'not found', endpoints: ['/status', '/tools', '/rpc', '/ui', '/ui/map', '/ui/map/data'] });
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
  const attempt = () => fetch(`http://127.0.0.1:${cfg.mcp.port}/rpc`, {
    method: 'POST', body: JSON.stringify({ tool, arguments: args, session }),
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
  // M9 minimal surface. Styling deliberately absent: /ui/theme.css is the
  // design-system insertion seam (owner build directive 2).
  return `<!doctype html><html><head><meta charset="utf-8"><title>vnodes</title>
<link rel="stylesheet" href="/ui/theme.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main>
<h1>vnodes</h1><p id="state">loading…</p>
<dl><dt>Files</dt><dd id="files">–</dd><dt>Nodes</dt><dd id="nodes">–</dd>
<dt>Edges</dt><dd id="edges">–</dd><dt>Repos</dt><dd id="repos">–</dd>
<dt>Last index</dt><dd id="last">–</dd></dl>
<p><a href="/ui/map">dependency map →</a></p>
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
  return `/* vnodes UI theme — design-system insertion seam.
   Intentionally unstyled per owner build directive 2: drop a design-dna
   package's tokens/styles here (e.g. from a ~/Documents/<system>/DESIGN_SYSTEM.md). */
body { font-family: monospace; margin: 2rem; }`;
}

module.exports = { serve, startDetached, stopDaemon, daemonState, doctor, httpCall };
