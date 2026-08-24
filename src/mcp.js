'use strict';
// M3 MCP Server — stdio transport (default, BR-012). Newline-delimited
// JSON-RPC 2.0 implementing the MCP handshake + tools/list + tools/call.
// Zero SDK deps.
const { TOOL_DEFS, callTool } = require('./tools');
const { findProjectRoot } = require('./config');
const { log } = require('./logs');
const { stalenessNotice } = require('./staleness');

/**
 * Whether an MCP tools/call result should be flagged isError.
 *
 * Gate refusals (`state: refused | not_a_knowledge_base`) used to arrive as a
 * successful MCP result whose JSON said no. `{error}` with no other payload is
 * the same shape. Keep the JSON in content[0].text either way.
 */
function toolCallIsError(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.state === 'refused' || result.state === 'not_a_knowledge_base') return true;
  if (result.error == null) return false;
  const keys = Object.keys(result).filter(k => k !== 'vnodes_stale');
  return keys.length === 1 && keys[0] === 'error';
}

function startMcpStdio(projectRootArg) {
  const projectRoot = findProjectRoot(projectRootArg);
  const session = `mcp-${process.pid}`;
  // When this process loaded its code. Everything it answers with is that
  // vintage, however long it then runs — see src/staleness.js.
  const startedMs = Date.now();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  });

  function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        // W3. params.clientInfo = {name, version} is the only place in the whole
        // system where "which agent" exists — the sessions in memory.db are
        // `mcp-<pid>`, `cli` and `http`, and a PID is not an agent. It was read
        // for its protocolVersion and thrown away. This fires once per session,
        // writes nothing unless the project is already registered (an MCP
        // handshake in an unindexed directory must not create an entry — that
        // is the mechanism behind the $HOME accident), and can never fail the
        // handshake.
        try { require('./registry').recordAgent(projectRoot, params && params.clientInfo); } catch {}
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'vnodes', version: require('../package.json').version },
        } });
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        // notification — no response
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } });
      } else if (method === 'tools/call') {
        const result = callTool(projectRoot, params.name, params.arguments || {}, session);
        // Attached to the answer, not logged. A caller reading a stale answer is
        // the one who has to know it is stale, and the log is not where they are
        // looking — this failure was found by comparing a process start time to
        // a commit time by hand, hours after it started mattering.
        const stale = stalenessNotice(startedMs);
        const payload = (stale && result && typeof result === 'object' && !Array.isArray(result))
          ? { ...result, vnodes_stale: stale }
          : result;
        const mcpResult = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        // Gate refusals are still JSON in content[0].text (newline JSON-RPC,
        // not LSP Content-Length). isError tells MCP clients not to treat them
        // as a successful tool payload.
        if (toolCallIsError(payload)) mcpResult.isError = true;
        send({ jsonrpc: '2.0', id, result: mcpResult });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (e) {
      log(projectRoot, 'daemon', `mcp error on ${method}: ${e.message}`);
      if (id !== undefined)
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
    }
  }
}

module.exports = { startMcpStdio, toolCallIsError };
