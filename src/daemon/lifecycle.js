'use strict';
/**
 * The daemon as a process: is one running, may this one index, start it, stop
 * it, reach it, and tell the operator what is wrong.
 *
 * Third and last split out of daemon.js, which had grown to 1,023 lines and
 * could not be handed to an agent at all. What remains beside this file is the
 * daemon as a SERVER — the router, the two request guards, the watcher, the SSE
 * stream. Those answer a request. These answer for the process.
 *
 * Nothing here reaches back into the server: no function in this file
 * references serve, the router, or anything under /ui. That is what made the
 * split free of a cycle, and it is worth keeping true — a lifecycle that has to
 * know about routing is a lifecycle that cannot be reasoned about while the
 * server is down, which is exactly when doctor() is asked to work.
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../config');
const { indexStatus } = require('../indexer');
const { loadWorkspace } = require('../workspace');
const { registryDir } = require('../registry');

function pidFile(projectRoot) {
  if (projectRoot == null) return path.join(registryDir(), 'hub.pid');
  return path.join(projectRoot, '.vnodes', 'daemon.pid');
}

function daemonState(projectRoot) {
  const pf = pidFile(projectRoot);
  if (!fs.existsSync(pf)) return { running: false };
  const { pid, port } = JSON.parse(fs.readFileSync(pf, 'utf8'));
  try { process.kill(pid, 0); return { running: true, pid, port }; }
  catch { return { running: false, stale_pidfile: true, pid, port }; }
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
  if (projectRoot == null) return false; // a hub indexes nothing
  const state = daemonState(projectRoot);
  if (state.running && state.pid !== process.pid) return false;
  fs.writeFileSync(pidFile(projectRoot), JSON.stringify({ pid: process.pid, port }));
  return true;
}
// A null projectRoot starts a hub: no project, no watcher, the registry and the
// picker only. cwd still has to be something real for spawn, so it is this
// package — which the hub never reads a config or an index out of.
function startDetached(projectRoot) {
  // '../..' because this file sits in src/daemon/, not src/. __dirname moves
  // with the file and nothing checks it: a wrong root here spawns a child
  // that cannot exist, and `daemon start` still prints a pid before the
  // child dies unseen. Caught only by starting one.
  const REPO = path.join(__dirname, '..', '..');
  const args = [path.join(REPO, 'bin', 'vnodes.js'), 'daemon', 'run'];
  if (!projectRoot) args.push('--hub');
  const child = spawn(process.execPath, args,
    { cwd: projectRoot || REPO, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// Auto-restart: call a tool over HTTP; if the daemon is down,
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

// Read-only doctor: diagnoses without a running daemon.
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
  const { llmState, runtimeInfo, runtimeCliFound } = require('../runtime');
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

module.exports = { pidFile, daemonState, claimIndexing, startDetached, httpCall, stopDaemon, doctor };
