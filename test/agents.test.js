'use strict';
// Pins the agent-instruction contract: the generated block describes the whole
// live tool catalog, and generating it never disturbs hand-written prose around
// the markers (BR-016, BR-018). Before this was generated, the block listed a
// hand-picked six of ten tools and silently fell further behind on every
// addition — these tests are what make that regression impossible.
const { test } = require('node:test');
const assert = require('node:assert');
const { instructionText, inRepo, AGENTS } = require('../src/agents');
const { TOOL_DEFS } = require('../src/tools');

test('instruction block names every tool in the live catalog', () => {
  const block = instructionText('/tmp/example-project');
  for (const def of TOOL_DEFS) {
    assert.ok(block.includes(`\`${def.name}\``), `missing tool: ${def.name}`);
  }
});

test('instruction block lists nothing that is not a real tool', () => {
  const block = instructionText('/tmp/example-project');
  const names = new Set(TOOL_DEFS.map(d => d.name));
  const listed = [...block.matchAll(/^- `([a-z_]+)`/gm)].map(m => m[1]);
  assert.deepStrictEqual(listed.length, TOOL_DEFS.length);
  for (const name of listed) assert.ok(names.has(name), `not a real tool: ${name}`);
});

// A config file outside the repo is shared by every project the agent opens.
// Pinning an absolute project root into one made the last `vnodes setup` win
// globally: Codex ended up serving whichever repo setup last ran in, for every
// repo. Configs outside the repo must resolve the project by cwd instead.
test('configs outside the repo are never treated as per-project', () => {
  const root = '/tmp/some-project';
  for (const a of AGENTS) {
    for (const p of [a.file, a.instructions].filter(Boolean)) {
      const isGlobal = p.startsWith('~');
      assert.strictEqual(inRepo(p, root), !isGlobal,
        `${a.id}: ${p} classified wrong (global configs must not pin a root)`);
    }
  }
});

test('every agent with a config outside the repo resolves by cwd', () => {
  const globals = AGENTS.filter(a => a.file && a.file.startsWith('~'));
  assert.ok(globals.length > 0, 'expected at least one globally-scoped agent config');
  for (const a of globals) {
    assert.strictEqual(inRepo(a.file, '/tmp/some-project'), false, `${a.id} must not pin`);
  }
});

test('instruction block is marker-delimited so hand-written prose survives', () => {
  const block = instructionText('/tmp/example-project');
  assert.ok(block.startsWith('<!-- vnodes:begin'), 'block must open with the begin marker');
  assert.ok(block.trimEnd().endsWith('<!-- vnodes:end -->'), 'block must close with the end marker');
});
