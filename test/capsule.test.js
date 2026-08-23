'use strict';
require('./_registry_home'); // isolates the knowledge-base registry from the developer's real ~/.config
// Pins the capsule contracts: the token budget is a hard cap (oversized pivots
// clip, never overflow), and test files cannot win pivot selection outside
// debug intent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIndex } = require('../src/indexer');
const { loadConfig, engineDir } = require('../src/config');
const { buildCapsule, resolveIntent } = require('../src/capsule');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  runIndex(root, loadConfig(root));
  return root;
}

function capsule(root, opts) {
  return buildCapsule(root, engineDir(root), loadConfig(root), opts);
}

test('budget is a hard cap: oversized first pivot clips, never overflows', () => {
  const body = Array.from({ length: 400 }, (_, i) => `export function zebra${i}() { return ${i}; }`).join('\n');
  const root = fixture({ 'src/zebra.ts': body });
  const c = capsule(root, { task: 'how does zebra work', max_tokens: 1000 });
  assert.ok(c.used_tokens <= 1000, `used ${c.used_tokens} > budget 1000`);
  assert.strictEqual(c.over_budget_tokens, undefined, 'must never overflow');
  assert.strictEqual(c.pivots.length, 1);
  assert.strictEqual(c.pivots[0].clipped, true);
  assert.ok(c.pivots[0].full_tokens > c.pivots[0].tokens);
  assert.strictEqual(c.truncated, true);
});

test('pivot fitting within budget stays unclipped', () => {
  const root = fixture({ 'src/zebra.ts': 'export function zebra() { return 1; }\n' });
  const c = capsule(root, { task: 'how does zebra work', max_tokens: 4000 });
  assert.strictEqual(c.pivots[0].file, 'src/zebra.ts');
  assert.strictEqual(c.pivots[0].clipped, undefined);
});

test('test files cannot pivot outside debug intent, still pivot inside it', () => {
  const files = {
    'src/zebra.ts': 'export function zebra() { return 1; }\n',
    'src/zebra.test.ts': 'import { zebra } from "./zebra";\ntest("zebra one", () => zebra());\ntest("zebra two", () => zebra());\n',
    'tests.rs': 'fn zebra_case() {}\n', // bare tests.<ext> naming (Rust convention)
  };
  const root = fixture(files);
  const explore = capsule(root, { task: 'how does zebra work', preset: 'explore' });
  assert.ok(explore.pivots.length > 0);
  for (const p of explore.pivots)
    assert.ok(!/(^|\/)(tests?\.)|\.test\./.test(p.file), `test file pivoted in explore: ${p.file}`);
  const debug = capsule(root, { task: 'why does the zebra test fail', preset: 'debug' });
  assert.ok(debug.pivots.some(p => /\.test\.|(^|\/)tests?\./.test(p.file)),
    'debug intent should allow test pivots');
});

test('intent resolution: rule-based classification', () => {
  assert.strictEqual(resolveIntent('fix the crash in parser', null), 'debug');
  assert.strictEqual(resolveIntent('refactor the config loader', null), 'refactor');
  assert.strictEqual(resolveIntent('add a new export command', null), 'modify');
  assert.strictEqual(resolveIntent('how does indexing work', null), 'explore');
  assert.strictEqual(resolveIntent('anything else entirely', 'refactor'), 'refactor');
});

test('a truncated capsule names what it dropped', () => {
  // The supporter loop used to `break` and say only `truncated: true`, which
  // left no reader able to tell a file that scored nothing from one that scored
  // well and lost to the last two hundred tokens.
  const files = { 'src/zebra.ts': 'export function zebra() { return 1; }\n' };
  for (let i = 0; i < 25; i++) {
    files[`src/zebra${i}.ts`] = 'import { zebra } from "./zebra";\n'
      + Array.from({ length: 40 }, (_, j) => `export function zebraHelper${i}_${j}(a, b, c) { return zebra() + ${j}; }`).join('\n');
  }
  const root = fixture(files);
  const c = capsule(root, { task: 'how does zebra work', max_tokens: 1200 });
  assert.strictEqual(c.truncated, true);
  assert.ok(Array.isArray(c.omitted) && c.omitted.length > 0, 'a truncated capsule must list its omissions');
  for (const o of c.omitted) {
    assert.strictEqual(typeof o.file, 'string');
    assert.ok(o.est_tokens > 0, 'an omission that cannot say what it would have cost explains nothing');
    assert.ok(['budget', 'pivot-degraded-to-skeleton'].includes(o.reason));
  }
  const kept = new Set(c.skeletons.map(s => s.file));
  for (const o of c.omitted) {
    if (o.reason === 'budget') assert.ok(!kept.has(o.file), `${o.file} is both kept and omitted`);
  }
});

test('an untruncated capsule omits nothing and says so', () => {
  const root = fixture({ 'src/zebra.ts': 'export function zebra() { return 1; }\n' });
  const c = capsule(root, { task: 'how does zebra work' });
  assert.strictEqual(c.truncated, false);
  assert.deepStrictEqual(c.omitted, []);
});

test('intent carries its provenance', () => {
  const { intentSource } = require('../src/capsule');
  assert.strictEqual(intentSource('anything at all', 'refactor'), 'preset');
  assert.strictEqual(intentSource('fix the crash in parser', null), 'regex');
  // No preset, no keyword, and the LLM layer off: 'auto' is a fallback, and a
  // reader deserves to know it was a fallback rather than a decision.
  assert.strictEqual(intentSource('zebra', null), 'default');
  const root = fixture({ 'src/zebra.ts': 'export function zebra() { return 1; }\n' });
  assert.strictEqual(capsule(root, { task: 'fix the zebra crash' }).intent_reason, 'regex');
  assert.strictEqual(capsule(root, { task: 'zebra', preset: 'explore' }).intent_reason, 'preset');
});
