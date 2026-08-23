'use strict';
// The tool catalog (BR-011) — one dispatch shared by the stdio MCP server and
// the HTTP daemon. All tools unconditionally available (BR-029). Every
// invocation is auto-captured as an observation (BR-013).
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, engineDir } = require('./config');
const { runIndex, indexStatus } = require('./indexer');
const { buildCapsule } = require('./capsule');
const { buildSkeleton } = require('./skeleton');
const { impactGraph, logicFlow } = require('./graph');
const { captureObservation, searchMemory, sessionContext } = require('./memory');
const { setupWorkspace, loadWorkspace } = require('./workspace');
const { openStore } = require('./store');

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
  { name: 'workspace_setup', description: 'Define a multi-repo workspace ({name|workspace_id, repos:[{alias,path}]}) and write parent pointers into secondary repos.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, workspace_id: { type: 'string' }, repos: { type: 'array', items: { type: 'object', properties: { alias: { type: 'string' }, path: { type: 'string' } }, required: ['alias', 'path'] } } }, required: ['repos'] } },
];

function ensureIndexed(projectRoot, cfg) {
  // Indexing starts automatically — no explicit init step (BR-002).
  const st = indexStatus(projectRoot);
  if (st.state === 'uninitialized') runIndex(projectRoot, cfg);
  return indexStatus(projectRoot);
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
  return dispatch(projectRoot, name, args, session);
}

module.exports = { TOOL_DEFS, callTool, callToolReadOnly, READ_ONLY_TOOLS, ensureIndexed };
