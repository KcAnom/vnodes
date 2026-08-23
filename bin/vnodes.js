#!/usr/bin/env node
'use strict';
// vnodes CLI — local-first code-graph context engine for AI agents.
process.removeAllListeners('warning');
process.on('warning', () => {}); // node:sqlite emits ExperimentalWarning on Node 22
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, findProjectRoot, engineDir } = require('../src/config');
const { log, logPath } = require('../src/logs');

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  } else args.push(a);
}
const cmd = args.shift() || 'help';
const projectRoot = findProjectRoot(flags.project || process.cwd());
const out = o => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

(async () => {
  switch (cmd) {
    case 'index': {
      const { runIndex } = require('../src/indexer');
      const cfg = loadConfig(projectRoot);
      const r = runIndex(projectRoot, cfg, m => log(projectRoot, 'index', m));
      out(`indexed ${projectRoot}: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges in ${r.ms}ms`);
      break;
    }
    case 'reindex': { // force re-index: full restart + rebuild (ERR-002)
      const { stopDaemon, startDetached } = require('../src/daemon');
      const eng = engineDir(projectRoot);
      stopDaemon(projectRoot);
      for (const f of ['index.db', 'index.db-wal', 'index.db-shm']) {
        try { fs.unlinkSync(path.join(eng, f)); } catch {}
      }
      const { runIndex } = require('../src/indexer');
      const r = runIndex(projectRoot, loadConfig(projectRoot), m => log(projectRoot, 'index', m));
      out(`force re-index: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges in ${r.ms}ms (daemon restarts on next tool call)`);
      break;
    }
    case 'status': {
      const { indexStatus } = require('../src/indexer');
      const { daemonState } = require('../src/daemon');
      out({ project: projectRoot, index: indexStatus(projectRoot), daemon: daemonState(projectRoot) });
      break;
    }
    case 'mcp': // stdio MCP server — the default agent transport
      require('../src/mcp').startMcpStdio(args[0] || projectRoot);
      break;
    case 'daemon': {
      const sub = args.shift() || 'status';
      const d = require('../src/daemon');
      // --hub: serve the registry and no project at all. This is what the macOS
      // app runs. A hub indexes nothing, watches nothing and claims no pidfile,
      // so it has no project it could be showing you by mistake.
      const hub = !!flags.hub;
      if (sub === 'run') d.serve(hub ? null : projectRoot);  // foreground (internal)
      else if (sub === 'start') {
        if (hub) {
          const pid = d.startDetached(null);
          out(`hub daemon starting pid=${pid} (http://127.0.0.1:${loadConfig(null).mcp.port}/ui/bases)`);
          break;
        }
        const st = d.daemonState(projectRoot);
        if (st.running) out(`already running pid=${st.pid} port=${st.port}`);
        else { const pid = d.startDetached(projectRoot); out(`daemon starting pid=${pid} (http://127.0.0.1:${loadConfig(projectRoot).mcp.port})`); }
      } else if (sub === 'stop') out(d.stopDaemon(projectRoot));
      else out(d.daemonState(projectRoot));
      break;
    }
    case 'call': { // HTTP tool call with auto-restart (BR-024)
      const { httpCall } = require('../src/daemon');
      const tool = args.shift();
      const a = flags.args ? JSON.parse(flags.args) : {};
      out(await httpCall(projectRoot, tool, a, 'cli'));
      break;
    }
    case 'pipeline':
    case 'capsule': {
      const { callTool } = require('../src/tools');
      const task = args.join(' ') || String(flags.task || '');
      if (!task) { out('usage: vnodes pipeline <task description> [--preset debug] [--max-tokens 8000] [--repos a,b]'); break; }
      const r = callTool(projectRoot, 'run_pipeline', {
        task, preset: flags.preset,
        max_tokens: flags['max-tokens'] ? Number(flags['max-tokens']) : undefined,
        repos: flags.repos ? String(flags.repos).split(',') : undefined,
      }, 'cli');
      if (flags.json) out(r);
      else {
        const cfg = require('../src/config').loadConfig(projectRoot);
        out(`intent=${r.intent} used=${r.used_tokens}/${r.budget_tokens} tokens savings=${r.savings_pct}% (baseline ${cfg.capsule.savings_baseline})`);
        out(`pivots: ${r.pivots.map(p => p.file + (p.clipped ? ` (clipped ${p.tokens}/${p.full_tokens})` : '')).join(', ') || '(none)'}`);
        const trunc = r.over_budget_tokens
          ? ` · OVER budget by ${r.over_budget_tokens} (safety-net breach — report this)`
          : r.truncated ? ' · TRUNCATED to budget' : '';
        out(`skeletons: ${r.skeletons.length} files · memories: ${r.memories.length}${trunc}`);
        out('(add --json for full content)');
      }
      break;
    }
    case 'skeleton': {
      const { callTool } = require('../src/tools');
      const r = callTool(projectRoot, 'get_skeleton', { file: args[0], detail: flags.detail, repo: flags.repo }, 'cli');
      out(r.skeleton || r);
      break;
    }
    case 'impact': {
      const { callTool } = require('../src/tools');
      out(callTool(projectRoot, 'get_impact_graph', { target: args[0], depth: flags.depth ? Number(flags.depth) : 3, cross_repo: flags['cross-repo'] !== 'false', repo: flags.repo }, 'cli'));
      break;
    }
    case 'flow': {
      const { callTool } = require('../src/tools');
      out(callTool(projectRoot, 'search_logic_flow', { from: args[0], to: args[1] }, 'cli'));
      break;
    }
    case 'memory': {
      const sub = args.shift() || 'recent';
      const { callTool } = require('../src/tools');
      if (sub === 'search') out(callTool(projectRoot, 'search_memory', { query: args.join(' ') }, 'cli'));
      else if (sub === 'save') out(callTool(projectRoot, 'save_observation', { summary: args.join(' '), file: flags.file, symbol: flags.symbol }, 'cli'));
      else out(callTool(projectRoot, 'get_session_context', { limit: flags.limit ? Number(flags.limit) : 20 }, 'cli'));
      break;
    }
    case 'workspace': {
      const sub = args.shift();
      if (sub === 'setup') {
        const { callTool } = require('../src/tools');
        const repos = String(flags.repos || '').split(',').filter(Boolean).map(pair => {
          const [alias, p] = pair.split('=');
          return { alias, path: p };
        });
        if (!repos.length) { out('usage: vnodes workspace setup --name myws --repos api=../api,web=../web'); break; }
        out(callTool(projectRoot, 'workspace_setup', { name: flags.name || flags.workspace_id || 'workspace', repos }, 'cli'));
      } else {
        const { loadWorkspace } = require('../src/workspace');
        out(loadWorkspace(projectRoot) || { workspace: null, hint: 'no workspace.json — single-repo mode' });
      }
      break;
    }
    /**
     * The registry, by hand.
     *
     * Every destructive verb lives here and nowhere else. The UI is read-only,
     * so hiding and forgetting a knowledge base are lines the reader copies —
     * the same pattern `ignore_suggestion` already establishes for
     * .vnodesignore. `forget` in particular removes the registry row and prints
     * the `rm -rf` for the index without running it: vnodes does not delete a
     * project's data on anyone's behalf.
     */
    case 'kb': {
      const reg = require('../src/registry');
      const sub = args.shift() || 'list';
      if (sub === 'list') {
        const l = reg.listKbs({ launchRoot: null });
        out(`registry: ${l.registry_dir}`);
        if (!l.kbs.length) out('(no knowledge bases yet — a project is listed the first time it finishes an index run)');
        for (const k of l.kbs) {
          out(`${k.id}  ${k.state.padEnd(15)} ${k.path || '(no path)'}`);
          out(`${' '.repeat(18)}${k.name}${k.branch ? ` · ${k.branch}` : ''} · ${k.verdict}`);
          if (k.flags.length) out(`${' '.repeat(18)}flags: ${k.flags.join(', ')}`);
          if (k.agents.length) out(`${' '.repeat(18)}agents: ${k.agents.map(a => a.name).join(', ')}`);
        }
        for (const n of l.notes) out(`note: ${n}`);
        break;
      }
      if (sub === 'register') {
        const target = path.resolve(args[0] || flags.project || process.cwd());
        if (!fs.existsSync(path.join(target, '.vnodes', 'index.db'))) {
          out(`not indexed: ${target}\nrun: cd ${target} && vnodes index`);
          break;
        }
        const r = reg.ensureEntry(target, 'cli');
        out(r ? { registered: r.id, path: target, already: !r.written } : { error: 'could not register', path: target });
        break;
      }
      if (sub === 'hide') { out(reg.hide(args[0])); break; }
      if (sub === 'show') { out(reg.show(args[0])); break; }
      if (sub === 'forget') { out(reg.forget(args[0])); break; }
      out(`vnodes kb: no subcommand "${sub}". Use: list | register [path] | forget <id> | hide <id> | show <id>`);
      break;
    }
    case 'setup': { // agent setup (M5)
      const { setupAgents, detectAgents } = require('../src/agents');
      if (flags.detect) { out(detectAgents().map(a => ({ id: a.id, name: a.name, installed: a.installed }))); break; }
      const cfg = loadConfig(projectRoot);
      const r = setupAgents(projectRoot, {
        only: flags.only ? String(flags.only).split(',') : null,
        personalMode: !!flags.personal || cfg.personal_mode,
      });
      out(r);
      break;
    }
    case 'doctor': {
      out(await require('../src/daemon').doctor(projectRoot));
      break;
    }
    case 'logs': {
      const channel = args[0] === 'index' ? 'index' : 'daemon';
      const p = logPath(projectRoot, channel);
      if (!fs.existsSync(p)) { out(`no ${channel} log yet at ${p}`); break; }
      if (flags.follow || flags.f) {
        out(fs.readFileSync(p, 'utf8'));
        fs.watchFile(p, { interval: 500 }, () => {
          try { out(fs.readFileSync(p, 'utf8').split('\n').slice(-5).join('\n')); } catch {}
        });
      } else out(fs.readFileSync(p, 'utf8').split('\n').slice(-50).join('\n'));
      break;
    }
    case 'llm': {
      const sub = args.shift() || 'status';
      const rt = require('../src/runtime');
      if (sub === 'install' || sub === 'enable') out(rt.llmEnable(projectRoot));
      else if (sub === 'disable') out(rt.llmDisable(projectRoot));
      else if (sub === 'runtime') out(rt.runtimeInfo(projectRoot, { runtime: flags.runtime, pi_model: flags['pi-model'] }));
      else if (sub === 'ask') out(rt.runtimeAsk(projectRoot, args.join(' '), { runtime: flags.runtime, pi_model: flags['pi-model'] }));
      else {
        // Truthful status: the state machine records intent; mode + cli check
        // say what actually answers — the configured runtime CLI, not a
        // downloaded local model.
        out({ ...rt.llmState(projectRoot), mode: 'runtime-cli',
          runtime: rt.runtimeInfo(projectRoot), runtime_cli_found: rt.runtimeCliFound(projectRoot) });
      }
      break;
    }
    case 'ui':
    case 'map': {
      const { daemonState, startDetached } = require('../src/daemon');
      const cfg = loadConfig(projectRoot);
      if (!daemonState(projectRoot).running) { startDetached(projectRoot); await new Promise(r => setTimeout(r, 700)); }
      // `vnodes map <target>` scopes the map the same way `vnodes impact` does.
      const qs = [];
      if (cmd === 'map' && args[0]) qs.push(`target=${encodeURIComponent(args.join(' '))}`);
      if (cmd === 'map' && flags.depth) qs.push(`depth=${encodeURIComponent(flags.depth)}`);
      if (cmd === 'map' && flags.task) qs.push(`task=${encodeURIComponent(flags.task)}`);
      // The two new controls belong in the URL, not only in the browser
      // toolbar: a flag the CLI cannot set means every reader hand-edits the
      // query, and the link that gets pasted somewhere shows something else.
      if (cmd === 'map' && flags.path) qs.push(`path=${encodeURIComponent(flags.path)}`);
      if (cmd === 'map' && flags.all) qs.push('show=all');
      // Same argument one level up: /ui is five pages now, and a page reachable
      // only by typing its path into a browser is a page nobody links to.
      // `vnodes ui capsule "<task>"` is the one that carries an argument,
      // because the capsule page with no task is an empty form.
      let uiPath = '';
      if (cmd === 'ui') {
        const page = args.shift();
        const PAGES = { overview: '', status: '/status', map: '/map', capsule: '/capsule', notes: '/notes', index: '/index' };
        if (page !== undefined && !(page in PAGES)) {
          out(`vnodes ui: no page "${page}". Pages: ${Object.keys(PAGES).join(', ')}`);
          break;
        }
        uiPath = page === undefined ? '' : PAGES[page];
        if (page === 'capsule' && args.length) qs.push(`task=${encodeURIComponent(args.join(' '))}`);
        if (page === 'capsule' && flags.preset) qs.push(`preset=${encodeURIComponent(flags.preset)}`);
        if (page === 'notes' && flags.q) qs.push(`q=${encodeURIComponent(flags.q)}`);
      }
      /**
       * Name the project in the URL, instead of relying on which directory the
       * daemon happened to be launched in.
       *
       * That reliance is the original bug stated in CLI form: `vnodes ui` run
       * inside project A, against a daemon started in project B, opened B. With
       * ?kb= the link says which knowledge base it is for, so it survives being
       * pasted somewhere — and bare /ui is now the picker, which is why the
       * CLI has to say.
       *
       * /ui/status is the exception: it is the plain-HTML floor and reports on
       * the daemon's own project only, so attaching a selector there would be a
       * URL that promises something the page cannot do.
       */
      const scoped = !(cmd === 'ui' && uiPath === '/status');
      if (scoped) {
        const kb = require('../src/registry').idForPath(projectRoot);
        const registered = kb && fs.existsSync(path.join(require('../src/registry').registryDir(), kb, 'kb.json'));
        if (registered) qs.push(`kb=${kb}`);
        else {
          out(`note: ${projectRoot} is not in the knowledge-base registry yet, so this URL falls back to whatever project the daemon was launched in.`);
          out(`      run: vnodes index --project ${projectRoot}   (indexing is what registers a project)`);
        }
      }
      const url = `http://127.0.0.1:${cfg.mcp.port}/ui${cmd === 'map' ? '/map' : uiPath}${qs.length ? `?${qs.join('&')}` : ''}`;
      out(url);
      try { require('node:child_process').execFileSync('open', [url]); } catch {}
      break;
    }
    case 'help':
    default:
      out(`vnodes — local-first code-graph context engine for AI agents

usage: vnodes <command> [args] [--flags]

  index                       build/update the graph (incremental via committed manifest)
  reindex                     force full re-index (stops daemon, rebuilds store)
  status                      index + daemon state
  pipeline <task...>          one-call context capsule (--preset auto|explore|debug|modify|refactor, --max-tokens N, --repos a,b, --json)
  skeleton <file>             signatures-only view (--detail minimal|standard|detailed)
  impact <file-or-symbol>     who depends on this (--depth N)
  flow <from> <to>            dependency path between two files/symbols
  memory [recent|search <q>|save <text> [--file f] [--symbol s]]
  workspace [setup --name N --repos alias=path,...]
  kb [list|register [path]|forget <id>|hide <id>|show <id>]
                              the knowledge-base registry: every project this machine has indexed.
                              a project is registered by INDEXING it; forget removes the row and
                              prints (never runs) the rm -rf that would remove the index itself
  setup [--detect] [--only claude-code,cursor] [--personal]
  daemon [start|stop|status] [--hub]
                              HTTP transport on cfg.mcp.port (stdio is default).
                              --hub serves the registry with no project of its own: it indexes
                              nothing, watches nothing, and opens on the picker
  call <tool> --args '{...}'  HTTP tool call (auto-starts daemon)
  mcp [project-root]          stdio MCP server (what agents launch)
  doctor                      read-only diagnostics, works with daemon down
  logs [daemon|index] [--follow]
  llm [status|enable|disable|runtime|ask <q>] [--runtime claude-code|pi] [--pi-model grok-4.5-latest|gpt-5.6-sol]
  ui [page] [args]            open the operator UI for THIS project (the URL carries ?kb=<id>).
                              bare http://127.0.0.1:<port>/ui with no ?kb= is the knowledge-base
                              picker — every indexed project on this machine — and so is /ui/bases.
                              pages: overview (default), map, capsule "<task>" [--preset p],
                              notes [--q text], index, status (plain HTML, no bundle needed,
                              reports on the daemon's own project only)
  map [target|dir] [--path DIR] [--all] [--depth N] [--task "..."]
                              open the live dependency map (scoped to target if given)
                              draws code by default; --all includes markdown, json and config

project: resolved upward from cwd (--project <path> to override)`);
  }
})().catch(e => { console.error(`vnodes: ${e.message}`); process.exit(1); });
