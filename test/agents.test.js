'use strict';
// Pins the agent-instruction contract: the generated block describes the whole
// live tool catalog, and generating it never disturbs hand-written prose around
// the markers (BR-016, BR-018). Before this was generated, the block listed a
// hand-picked six of ten tools and silently fell further behind on every
// addition — these tests are what make that regression impossible.
const { test } = require('node:test');
const assert = require('node:assert');
const { instructionText } = require('../src/agents');
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

test('instruction block is marker-delimited so hand-written prose survives', () => {
  const block = instructionText('/tmp/example-project');
  assert.ok(block.startsWith('<!-- vnodes:begin'), 'block must open with the begin marker');
  assert.ok(block.trimEnd().endsWith('<!-- vnodes:end -->'), 'block must close with the end marker');
});
