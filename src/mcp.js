'use strict';
// M3 MCP Server — stdio transport (default, BR-012). Newline-delimited
// JSON-RPC 2.0 implementing the MCP handshake + tools/list + tools/call.
// Zero SDK deps.
const { TOOL_DEFS, callTool } = require('./tools');
const { findProjectRoot } = require('./config');
const { log } = require('./logs');

function startMcpStdio(projectRootArg) {
  const projectRoot = findProjectRoot(projectRootArg);
  const session = `mcp-${process.pid}`;
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
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'vnodes', version: '1.0.0' },
        } });
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        // notification — no response
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } });
      } else if (method === 'tools/call') {
        const result = callTool(projectRoot, params.name, params.arguments || {}, session);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
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

module.exports = { startMcpStdio };
