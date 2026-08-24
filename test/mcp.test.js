'use strict';
require('./_registry_home');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { toolCallIsError } = require('../src/mcp');

test('toolCallIsError flags gate refusals and bare {error}, nothing else', () => {
  assert.strictEqual(toolCallIsError({ state: 'refused', reason: 'home' }), true);
  assert.strictEqual(toolCallIsError({ state: 'not_a_knowledge_base', reason: 'index' }), true);
  assert.strictEqual(toolCallIsError({ created: false, state: 'refused', path: '/x', reason: 'home' }), true);
  assert.strictEqual(toolCallIsError({ error: 'nope' }), true);
  assert.strictEqual(toolCallIsError({ error: 'nope', vnodes_stale: { since: 1 } }), true);
  assert.strictEqual(toolCallIsError({ error: 'nope', files: [] }), false, 'an error plus payload is not a bare refusal');
  assert.strictEqual(toolCallIsError({ state: 'ready', files: 3 }), false);
  assert.strictEqual(toolCallIsError({ ok: true }), false);
  assert.strictEqual(toolCallIsError('nope'), false);
  assert.strictEqual(toolCallIsError(null), false);
});

function unopted() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-mcp-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  return fs.realpathSync(dir);
}

function mcpCall(dir, msg, { expectLines = 1, timeoutMs = 5000 } = {}) {
  const bin = path.join(__dirname, '..', 'bin', 'vnodes.js');
  const child = spawn(process.execPath, [bin, 'mcp', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timed out. stdout=${out} stderr=${err}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => {
      out += c;
      const lines = out.split('\n').filter(Boolean);
      if (lines.length >= expectLines) {
        clearTimeout(t);
        child.kill();
        resolve({ lines, stderr: err });
      }
    });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

test('tools/call sets isError on a gate refusal and stays newline JSON-RPC', async () => {
  const dir = unopted();
  const { lines } = await mcpCall(dir, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'index_status', arguments: {} },
  });
  assert.strictEqual(lines.length, 1, 'one newline-delimited JSON-RPC reply');
  const msg = JSON.parse(lines[0]);
  assert.strictEqual(msg.jsonrpc, '2.0');
  assert.strictEqual(msg.id, 1);
  assert.strictEqual(msg.result.isError, true);
  const payload = JSON.parse(msg.result.content[0].text);
  assert.strictEqual(payload.state, 'not_a_knowledge_base');
  assert.ok(!lines[0].includes('Content-Length'), 'must not switch to LSP Content-Length');
});
