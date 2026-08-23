'use strict';
// The tool catalog (BR-011) — one dispatch shared by the stdio MCP server and
// the HTTP daemon. All tools unconditionally available (BR-029). Every
// invocation is auto-captured as an observation (BR-013).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, engineDir, engineDirPath } = require('./config');
const { runIndex, indexStatus } = require('./indexer');
const { buildCapsule } = require('./capsule');
const { buildSkeleton } = require('./skeleton');
const { impactGraph, logicFlow } = require('./graph');
const { captureObservation, searchMemory, sessionContext } = require('./memory');
const { setupWorkspace, loadWorkspace } = require('./workspace');
const { openStore } = require('./store');
const { idForPath } = require('./registry');

const TOOL_DEFS = [
  { name: 'run_pipeline', description: 'One-call task orientation: intent preset → graph traversal → context capsule (pivot files in full, supporting skeletons, relevant memories with rationale), fitted to the token budget. Presets: auto (default), explore, debug (auto-includes tests), modify, refactor.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'what you are trying to do' }, preset: { type: 'string', enum: ['auto', 'explore', 'debug', 'modify', 'refactor'] }, max_tokens: { type: 'number' }, repos: { type: 'array', items: { type: 'string' }, description: 'limit to these workspace repo aliases' } }, required: ['task'] } },
  { name: 'get_context_capsule', description: 'Assemble a context capsule for a task without intent narration — same engine as run_pipeline.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, preset: { type: 'string' }, max_tokens: { type: 'number' }, repos: { type: 'array', items: { type: 'string' } } }, required: ['task'] } },
  { name: 'get_impact_graph', description: 'Who depends on this file or symbol — reverse-dependency BFS, depth-limited.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, depth: { type: 'number' }, cross_repo: { type: 'boolean' }, repo: { type: 'string' } }, required: ['target'] } },
  { name: 'search_logic_flow', description: 'Shortest dependency path between two files or symbols.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, cross_repo: { type: 'boolean' } }, required: ['from', 'to'] } },
  { name: 'get_skeleton', description: 'Signatures-only view of a file at minimal | standard | detailed.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, detail: { type: 'string', enum: ['minimal', 'standard', 'detailed'] }, repo: { type: 'string' } }, required: ['file'] } },
  { name: 'get_session_context', description: 'Recent observations from this and previous sessions (stale ones flagged, never dropped).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'search_memory', description: 'Search stored observations; each hit carries a rationale for why it matched.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'save_observation', description: 'Save a manual observation, optionally linked to a symbol/file for staleness tracking.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, symbol: { type: 'string' }, file: { type: 'string' } }, required: ['summary'] } },
  { name: 'index_status', description: 'Index health: state, file/node/edge counts, repos, languages, last index time.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'create_knowledge_base', description: 'Make this directory (or `path`) a vnodes knowledge base and index it. This is how a knowledge base is created — every other tool refuses a directory that is not one yet, and points here. Creates the directory if it does not exist, so an agent in an empty terminal can name a new folder and get a knowledge base about it in one call. Safe to call twice: an existing knowledge base is re-indexed, not duplicated.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'absolute, or relative to the current project root; defaults to the current project root' } } } },
  { name: 'workspace_setup', description: 'Define a multi-repo workspace ({name|workspace_id, repos:[{alias,path}]}) and write parent pointers into secondary repos.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, workspace_id: { type: 'string' }, repos: { type: 'array', items: { type: 'object', properties: { alias: { type: 'string' }, path: { type: 'string' } }, required: ['alias', 'path'] } } }, required: ['repos'] } },
];

/**
 * Whether this directory has agreed to be a knowledge base — and if not, why.
 *
 * Returns a refusal to hand straight back to the caller, or null to proceed.
 * Every entry point asks this FIRST, before anything that could touch the
 * directory, because two of the things that touch it create it: `engineDir`
 * mkdirs `<root>/.vnodes/logs` and writes a .gitignore, and both callTool and
 * dispatch call it on the way in. A gate placed after either one inspects a
 * directory that the same request just created, and always passes.
 *
 * Two ways a directory has not agreed:
 *
 * $HOME is not a project, and auto-indexing it is how vnodes indexed 541,275
 * files and 3.67M nodes without anyone being told. findProjectRoot walks up
 * looking for .vnodes or .git, so an agent standing anywhere under the home
 * directory with neither in its ancestry resolves to the home directory
 * itself, and one index_status call was enough to start the walk. Worse, it is
 * self-reinforcing: once ~/.vnodes exists, every future walk-up terminates
 * there.
 *
 * A directory with no `.vnodes/` never opted in at all. BR-002 removed the
 * init step so a project would index on first use, which is right for a
 * project the owner chose and wrong for every directory an agent happens to
 * stand in: the registrations `vnodes setup` writes outside a repo carry no
 * project root by design (src/agents.js serverArgs), so they resolve upward
 * from the working directory — one tool call in any repo built a knowledge
 * base there, unasked, and the owner found out by reading the picker.
 * `.vnodes/` is the consent that already exists, created by `vnodes index` and
 * by nothing that runs unasked. Requiring it restores what BR-002 meant — a
 * project that has opted in stays current on its own — and leaves a directory
 * that never opted in exactly as it was found.
 *
 * Detection, not deletion. Nothing here removes an index, and explicit
 * `vnodes index` / `vnodes index --project ~` still create one, because the
 * CLI calls runIndex directly and never comes through here.
 */
function knowledgeBaseGate(projectRoot) {
  if (path.resolve(projectRoot) === path.resolve(os.homedir())) {
    return {
      state: 'refused',
      reason: 'this is your home directory, not a project — vnodes resolved it by walking up from a directory with no .git. Index a real project: vnodes index --project <path>',
    };
  }
  if (!fs.existsSync(engineDirPath(projectRoot))) {
    return {
      state: 'not_a_knowledge_base',
      reason: `${projectRoot} has no knowledge base, and vnodes does not create one for a directory it was merely opened in. Create it by calling the create_knowledge_base tool, or from a shell: cd ${projectRoot} && vnodes index`,
    };
  }
  return null;
}

function ensureIndexed(projectRoot, cfg) {
  /**
   * The gate is checked before indexStatus, not after: indexStatus opens the
   * store, and against the home knowledge base that alone was measured at 5.8
   * seconds.
   */
  const refusal = knowledgeBaseGate(projectRoot);
  if (refusal) return refusal;
  // A project that has opted in indexes on first use — no explicit init (BR-002).
  const st = indexStatus(projectRoot);
  if (st.state === 'uninitialized') runIndex(projectRoot, cfg);
  return indexStatus(projectRoot);
}

/**
 * The tools that may run where there is no knowledge base yet.
 *
 * Exactly one, and it is the one that makes them. The gate refuses every other
 * tool with "run vnodes index", which assumes a shell the caller may not have —
 * an agent reaching vnodes over MCP has tools, not a terminal. Without a tool
 * that creates a knowledge base, such an agent can read the refusal and do
 * nothing about it.
 *
 * The exemption is safe because calling this tool IS the consent the gate looks
 * for: it is never reached by a caller that was merely opened somewhere, only
 * by one that asked for a knowledge base by name.
 */
const GATE_EXEMPT_TOOLS = new Set(['create_knowledge_base']);

/**
 * Make a directory a knowledge base, and index it.
 *
 * Handled before `dispatch` computes engineDir, because engineDir mkdirs
 * `<root>/.vnodes/logs` — and this is the one call that may be about to reject
 * the very directory that engineDir would create in.
 *
 * `path` is resolved against the project root rather than the process cwd: the
 * daemon serves many projects from one process, and its cwd is its own, not the
 * caller's. An absolute path is used as given.
 *
 * The home directory stays refused. That guard is about size and blast radius,
 * not consent — indexing $HOME produced 541,275 files and never finished, and
 * an explicit request does not make that a good outcome. `vnodes index
 * --project ~` remains the deliberate way through, from a shell, by a human.
 */
function createKnowledgeBase(projectRoot, args, session) {
  const target = path.resolve(projectRoot, args.path || '.');
  if (target === path.resolve(os.homedir())) {
    return {
      created: false,
      state: 'refused',
      path: target,
      reason: 'your home directory is too large to be one knowledge base — indexing it produced 541,275 files and never finished. Name a project inside it instead, or run `vnodes index --project ~` from a shell if you truly mean it.',
    };
  }
  const directoryExisted = fs.existsSync(target);
  if (!directoryExisted) fs.mkdirSync(target, { recursive: true });
  const alreadyKb = fs.existsSync(engineDirPath(target));

  const cfg = loadConfig(target);
  const r = runIndex(target, cfg);
  const st = indexStatus(target);
  // The observation belongs to the knowledge base that was made, not to
  // whatever directory the caller happened to be standing in.
  captureObservation(engineDir(target), {
    session,
    tool: 'create_knowledge_base',
    summary: `${alreadyKb ? 're-indexed' : 'created'} knowledge base at ${target}: ${r.files} files, ${r.edges} edges`,
  });
  return {
    created: !alreadyKb,
    already_a_knowledge_base: alreadyKb,
    created_directory: !directoryExisted,
    path: target,
    id: idForPath(target),
    files: r.files,
    nodes: r.nodes,
    edges: r.edges,
    ms: r.ms,
    state: st.state,
    next: 'run_pipeline "<what you are trying to do>" for a context capsule from it',
  };
}

/**
 * The tools that only read.
 *
 * Not a comment, a gate. Every /rpc call inserts an observation (below), so a
 * browser panel polling tools through /rpc would fill the memory feed agents
 * actually read with rows whose summary is the literal argument JSON — seven
 * curl probes produced exactly seven such rows, and at six a minute a panel
 * owns the whole 500-row relevance window inside an hour. The read-only UI
 * surface is enforced here rather than in the React client, because the client
 * is not the thing that decides: the server accepts whatever it is sent.
 */
const READ_ONLY_TOOLS = new Set([
  'run_pipeline', 'get_context_capsule', 'get_impact_graph', 'search_logic_flow',
  'get_skeleton', 'get_session_context', 'search_memory', 'index_status',
]);

function dispatch(projectRoot, name, args, session) {
  // Before engineDir on purpose — see createKnowledgeBase.
  if (name === 'create_knowledge_base') return createKnowledgeBase(projectRoot, args, session);
  const cfg = loadConfig(projectRoot);
  const engDir = engineDir(projectRoot);
  let result;
  switch (name) {
    case 'run_pipeline':
    case 'get_context_capsule': {
      ensureIndexed(projectRoot, cfg);
      result = buildCapsule(projectRoot, engDir, cfg, { ...args, session });
      break;
    }
    case 'get_impact_graph':
      ensureIndexed(projectRoot, cfg);
      result = impactGraph(engDir, args);
      break;
    case 'search_logic_flow':
      ensureIndexed(projectRoot, cfg);
      result = logicFlow(engDir, args);
      break;
    case 'get_skeleton': {
      ensureIndexed(projectRoot, cfg);
      const db = openStore(engDir);
      const key = args.repo ? `${args.repo}/${args.file}` : args.file;
      const sk = buildSkeleton(db, key, args.detail || cfg.capsule.skeleton_detail);
      db.close();
      result = sk ? { file: key, skeleton: sk } : { file: key, error: 'file not in index' };
      break;
    }
    case 'get_session_context':
      result = { observations: sessionContext(engDir, { session, limit: args.limit || 20 }) };
      break;
    case 'search_memory':
      result = { results: searchMemory(engDir, args.query, { session, limit: args.limit || 8 }) };
      break;
    case 'save_observation':
      captureObservation(engDir, { session, tool: 'save_observation', kind: 'manual', summary: args.summary, symbol: args.symbol, file: args.file });
      result = { saved: true };
      break;
    case 'index_status':
      result = ensureIndexed(projectRoot, cfg);
      break;
    case 'workspace_setup': {
      // Schema only requires repos; an unnamed workspace renders as null in
      // /status and doctor, so fall back to the project directory name.
      const def = { name: args.name || args.workspace_id || path.basename(projectRoot), repos: args.repos };
      result = setupWorkspace(projectRoot, def);
      break;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return result;
}

function callTool(projectRoot, name, args = {}, session = 'default') {
  // The tool that creates a knowledge base cannot require one. It captures its
  // own observation, into the knowledge base it made, so it also returns before
  // the auto-capture below — which would write into projectRoot's engine dir,
  // a directory that may not be a knowledge base at all.
  if (GATE_EXEMPT_TOOLS.has(name)) return dispatch(projectRoot, name, args, session);
  // Before engineDir, which would create the very directory the gate reads.
  const refusal = knowledgeBaseGate(projectRoot);
  if (refusal) return refusal;
  const engDir = engineDir(projectRoot);
  const result = dispatch(projectRoot, name, args, session);
  // Auto-capture (BR-013) — skip save_observation itself (already stored as manual).
  if (name !== 'save_observation') {
    const brief = name.startsWith('run_') || name.includes('capsule')
      ? `task: ${args.task || ''} → intent=${result.intent}, ${result.pivots?.length || 0} pivots, ${result.skeletons?.length || 0} skeletons, ${result.used_tokens || 0} tokens`
      : JSON.stringify(args).slice(0, 200);
    const linkedFile = result?.pivots?.[0]?.file || (typeof args.file === 'string' ? args.file : null);
    captureObservation(engDir, { session, tool: name, summary: brief, file: linkedFile });
  }
  return result;
}

/**
 * Same dispatch, no write, no observation row.
 *
 * A caller that is only allowed to look — the /ui surface — asks through here.
 * The name check runs before dispatch, so a write tool never reaches its case
 * even by accident, and nothing on this path can reach the auto-capture block.
 */
function callToolReadOnly(projectRoot, name, args = {}, session = 'readonly') {
  if (!READ_ONLY_TOOLS.has(name)) {
    throw new Error(`tool '${name}' is not read-only; the UI surface may not call it`);
  }
  // After the name check, before dispatch — dispatch calls engineDir, and a
  // GET that materialises .vnodes/ in a directory is the thing engineDirPath
  // exists to prevent.
  const refusal = knowledgeBaseGate(projectRoot);
  if (refusal) return refusal;
  return dispatch(projectRoot, name, args, session);
}

module.exports = { TOOL_DEFS, callTool, callToolReadOnly, READ_ONLY_TOOLS, ensureIndexed, knowledgeBaseGate };
