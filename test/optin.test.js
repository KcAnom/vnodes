'use strict';
// Pins the rule that a knowledge base is created on purpose.
//
// The registrations `vnodes setup` writes outside a repo carry no project root
// by design, so they resolve upward from the agent's working directory. Before
// this gate, one tool call from such an agent indexed whatever repo it was
// standing in — and the two entry points both call engineDir, which mkdirs
// `<root>/.vnodes/logs`, so a gate placed after either one would have read a
// directory the same request had just created and passed every time. These
// tests fail on both halves of that: the refusal, and the untouched directory.
require('./_registry_home'); // first: these tests index, and indexing registers
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callTool, callToolReadOnly, ensureIndexed, knowledgeBaseGate, TOOL_DEFS } = require('../src/tools');
const { loadConfig } = require('../src/config');
const { instructionText } = require('../src/agents');

// A plausible repo an agent could be opened in: real files, no .vnodes.
function unopted() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-optin-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  return fs.realpathSync(dir);
}

test('a directory with no .vnodes is refused, not indexed', () => {
  const dir = unopted();
  const r = ensureIndexed(dir, loadConfig(dir));
  assert.equal(r.state, 'not_a_knowledge_base');
  assert.match(r.reason, /vnodes index/);
});

test('the home directory keeps its own refusal', () => {
  const r = knowledgeBaseGate(os.homedir());
  assert.equal(r.state, 'refused');
});

test('every tool entry point refuses before touching the directory', () => {
  for (const name of ['index_status', 'get_skeleton', 'run_pipeline', 'get_impact_graph']) {
    const dir = unopted();
    const r = callTool(dir, name, { file: 'src/a.js', task: 'x' });
    assert.equal(r.state, 'not_a_knowledge_base', `${name} did not refuse`);
    // The whole point: engineDir must never have run.
    assert.ok(!fs.existsSync(path.join(dir, '.vnodes')), `${name} created .vnodes/`);
  }
});

test('the read-only surface refuses on the same rule', () => {
  const dir = unopted();
  const r = callToolReadOnly(dir, 'index_status', {});
  assert.equal(r.state, 'not_a_knowledge_base');
  assert.ok(!fs.existsSync(path.join(dir, '.vnodes')));
});

test('the read-only name check still runs first', () => {
  const dir = unopted();
  assert.throws(() => callToolReadOnly(dir, 'save_observation', {}), /not read-only/);
});

test('an opted-in project passes the gate', () => {
  const dir = unopted();
  fs.mkdirSync(path.join(dir, '.vnodes'));
  assert.equal(knowledgeBaseGate(dir), null);
});

// The gate refuses with an instruction, and an agent reaching vnodes over MCP
// has tools rather than a shell to follow it with. These pin the one tool that
// may run where the gate would otherwise refuse.

test('the refusal names the tool, not only a shell command', () => {
  const dir = unopted();
  const r = callTool(dir, 'index_status', {});
  assert.match(r.reason, /create_knowledge_base/);
});

test('create_knowledge_base runs where every other tool is refused', () => {
  const dir = unopted();
  const r = callTool(dir, 'create_knowledge_base', {});
  assert.equal(r.created, true);
  assert.equal(r.path, dir);
  assert.ok(fs.existsSync(path.join(dir, '.vnodes')));
  // And the gate now lets the rest of the catalog through.
  assert.equal(callTool(dir, 'index_status', {}).state, 'ready');
});

test('it creates a directory that does not exist yet', () => {
  const dir = unopted();
  const r = callTool(dir, 'create_knowledge_base', { path: 'brand-new' });
  assert.equal(r.created_directory, true);
  assert.equal(r.path, path.join(dir, 'brand-new'));
  assert.ok(fs.existsSync(path.join(dir, 'brand-new', '.vnodes')));
});

test('calling it twice re-indexes instead of duplicating', () => {
  const dir = unopted();
  const first = callTool(dir, 'create_knowledge_base', {});
  const second = callTool(dir, 'create_knowledge_base', {});
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.already_a_knowledge_base, true);
  assert.equal(first.id, second.id);
});

test('the home directory is refused even when asked for by name', () => {
  const r = callTool(os.homedir(), 'create_knowledge_base', {});
  assert.equal(r.state, 'refused');
  assert.equal(r.created, false);
  assert.ok(!fs.existsSync(path.join(os.homedir(), '.vnodes')), 'created ~/.vnodes');
});

test('a refused create leaves no engine directory behind', () => {
  const dir = unopted();
  callTool(os.homedir(), 'create_knowledge_base', {});
  assert.ok(!fs.existsSync(path.join(dir, '.vnodes')));
});

test('the read-only surface may not create a knowledge base', () => {
  const dir = unopted();
  assert.throws(() => callToolReadOnly(dir, 'create_knowledge_base', {}), /not read-only/);
  assert.ok(!fs.existsSync(path.join(dir, '.vnodes')));
});

test('every agent is told the tool exists', () => {
  // The block vnodes setup writes into CLAUDE.md / AGENTS.md / .cursor is
  // generated from this catalog, so a tool added here reaches every wired agent
  // without a per-agent edit. That is the whole reason it is a tool.
  assert.ok(TOOL_DEFS.some(d => d.name === 'create_knowledge_base'));
  assert.match(instructionText('/tmp/example-project'), /create_knowledge_base/);
});
