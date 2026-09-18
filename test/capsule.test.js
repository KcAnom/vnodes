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

test('readOnly capsule does not create index.db when none exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-capsule-ro-'));
  const engDir = path.join(root, '.vnodes');
  fs.mkdirSync(engDir, { recursive: true });
  const c = buildCapsule(root, engDir, loadConfig(root), { task: 'zebra', readOnly: true });
  assert.deepStrictEqual(c.pivots, []);
  assert.deepStrictEqual(c.skeletons, []);
  assert.strictEqual(fs.existsSync(path.join(engDir, 'index.db')), false);
  assert.strictEqual(fs.existsSync(path.join(engDir, 'memory.db')), false);
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

/**
 * The memory reserve.
 *
 * The capsule is built for a headless agent, and it was spending the agent's
 * whole budget on the one thing the agent can already get for free. Measured on
 * this repo at the 8000 default: the pivot took 7381 tokens, one pivot cost 43x
 * one memory, and all three stored findings were dropped — with no receipt,
 * because this loop broke where the loops above it kept one. Source rebuilds
 * from disk; observations rebuild from nothing.
 */
const { captureObservation } = require('../src/memory');

function withMemories(n, task) {
  const body = Array.from({ length: 400 }, (_, i) => `export function zebra${i}() { return ${i}; }`).join('\n');
  const root = fixture({ 'src/zebra.ts': body });
  for (let i = 0; i < n; i++) {
    captureObservation(engineDir(root), {
      session: 'prior', tool: 'save_observation', kind: 'manual', file: 'src/zebra.ts',
      summary: `${task} — finding ${i}: ${'a durable detail that cost a session to learn. '.repeat(3)}`,
    });
  }
  return root;
}

test('a pivot big enough to eat the budget no longer starves the findings', () => {
  const task = 'zebra';
  const root = withMemories(3, task);
  const c = capsule(root, { task });
  assert.ok(c.memories.length > 0, 'findings were dropped for a file the agent could have opened itself');
  assert.ok(c.memory_reserve_tokens > 0);
  assert.ok(c.used_tokens <= c.budget_tokens, 'the reserve broke the budget contract');
});

test('the reserve costs the content nothing when nothing is stored', () => {
  const body = Array.from({ length: 400 }, (_, i) => `export function zebra${i}() { return ${i}; }`).join('\n');
  const root = fixture({ 'src/zebra.ts': body });
  const c = capsule(root, { task: 'zebra' });
  assert.equal(c.memory_reserve_tokens, 0);
  assert.equal(c.memories.length, 0);
});

test('the reserve is bounded by a share of the budget, not by what memory wants', () => {
  const task = 'zebra';
  const root = withMemories(6, task);
  const c = capsule(root, { task, max_tokens: 400 });
  assert.ok(c.memory_reserve_tokens <= Math.floor(400 * 0.25), `reserve ${c.memory_reserve_tokens} exceeded its share`);
  assert.ok(c.used_tokens <= c.budget_tokens);
});

test('a memory that does not fit is named, not dropped in silence', () => {
  const task = 'zebra';
  const root = withMemories(6, task);
  const c = capsule(root, { task, max_tokens: 400 });
  const dropped = c.omitted.filter(o => o.reason === 'budget-memory');
  assert.ok(dropped.length > 0, 'memories were cut with no receipt');
  for (const d of dropped) {
    assert.ok(d.est_tokens > 0, 'a receipt that does not say what it cost');
    assert.equal(typeof d.file, 'string');
  }
  assert.equal(c.truncated, true);
});

/**
 * Clipping does not depend on where a file ranked.
 *
 * A pivot is a file the graph says the task is about. It used to get the head
 * of its real source if it ranked first and none of it at all otherwise —
 * signatures only — so whether an agent saw the code depended on what happened
 * to outrank it. Measured on this repo: src/daemon.js ranked second, did not
 * fit, and came back as 35 function names with 12,676 tokens of the code the
 * question was about dropped.
 */
function twoBigLinkedFiles() {
  const big = (n, tag) => Array.from({ length: n }, (_, i) =>
    `export function ${tag}${i}() { /* ${'x'.repeat(60)} */ return ${i}; }`).join('\n');
  return fixture({
    'src/alpha.ts': `import { beta0 } from './beta'\n` + big(220, 'alpha'),
    'src/beta.ts': big(220, 'beta'),
  });
}

test('a pivot that ranked second is clipped, not reduced to signatures', () => {
  const root = twoBigLinkedFiles();
  // Sized so the second pivot genuinely does not fit: a budget where both fit
  // whole proves nothing about what happens when one does not.
  const c = capsule(root, { task: 'alpha beta', max_tokens: 12000 });
  assert.ok(c.pivots.length >= 2, `expected two pivots, got ${c.pivots.length}`);
  const second = c.pivots[1];
  assert.equal(second.clipped, true, 'the second pivot fitted whole — this budget tests nothing');
  assert.ok(second.content && second.content.length > 0, 'the second pivot carried no source');
  assert.ok(c.used_tokens <= c.budget_tokens, 'clipping broke the budget contract');
});

test('below the floor it degrades: a scrap of a file is worse than its signatures', () => {
  const root = twoBigLinkedFiles();
  // A budget with room for one pivot and no meaningful room after it.
  const c = capsule(root, { task: 'alpha beta', max_tokens: 4200 });
  assert.equal(c.pivots.length, 1);
  assert.ok(c.omitted.some(o => o.reason === 'pivot-degraded-to-skeleton'),
    'nothing degraded, so a scrap was sent instead of signatures');
  assert.ok(c.used_tokens <= c.budget_tokens);
});

test('the first pivot clips regardless of the floor — no pivot answers nothing', () => {
  const root = twoBigLinkedFiles();
  const c = capsule(root, { task: 'alpha beta', max_tokens: 300 });
  assert.equal(c.pivots.length, 1, 'a budget under the floor left the capsule with no pivot at all');
  assert.equal(c.pivots[0].clipped, true);
  assert.ok(c.used_tokens <= c.budget_tokens);
});

test('a clipped pivot still gets its skeleton, so the cut symbols are visible', () => {
  const root = twoBigLinkedFiles();
  const c = capsule(root, { task: 'alpha beta', max_tokens: 12000 });
  const clipped = c.pivots.filter(p => p.clipped);
  assert.ok(clipped.length > 0, 'nothing clipped in this fixture');
  for (const p of clipped) {
    assert.ok(p.full_tokens > p.tokens, 'a clipped pivot must say what it would have cost');
    // The skeleton is what makes a clip honest — it lists the symbols the clip
    // cut off. It is queued ahead of every other supporter for that reason, but
    // it is not exempt from the budget: a skeleton of a very large file can
    // itself be too big to fit. What is NOT allowed is losing it in silence.
    const shown = c.skeletons.some(s => s.file === p.file);
    const said = c.omitted.some(o => o.file === p.file && o.reason === 'budget');
    assert.ok(shown || said,
      `${p.file} was clipped, got no skeleton, and nothing recorded why`);
  }
});

test('an underscore in the task matches the real symbol, not any character', () => {
  // SQL LIKE treats _ as any-single-char: unescaped, a task naming foo_bar
  // scored every fooXbar in the tree exactly as high as foo_bar itself.
  const root = fixture({
    'src/real.ts': 'export function foo_bar() { return 1; }\n',
    'src/decoy.ts': 'export function fooabar() { return 2; }\n',
  });
  const c = capsule(root, { task: 'fix foo_bar', readOnly: true });
  const picked = [...c.pivots, ...c.skeletons].map(p => p.file);
  assert.ok(picked.includes('src/real.ts'), 'the real symbol must rank');
  assert.ok(!picked.includes('src/decoy.ts'),
    'fooabar must not match a foo_bar query through the _ wildcard');
});
