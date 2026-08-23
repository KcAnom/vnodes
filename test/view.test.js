'use strict';
// Pins the map surface's contracts — the ones a replacement renderer inherits.
//
// Scoped deliberately. `src/view/data.js` and `src/view/index.js` are the
// durable half: a new visualizer consumes their output whatever it draws with.
// From `model.js` only the two graph algorithms are pinned (`cyclesFor`,
// `levelsFor`) — those are claims about the dependency graph, not geometry, and
// a port that gets them wrong is wrong regardless of how it looks. Box sizes,
// wrapping and HTML are left untested on purpose; they are the part being
// replaced, and tests against them would be deleted with the code.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIndex } = require('../src/indexer');
const { loadConfig, engineDir } = require('../src/config');
const { subgraph, fileDetail, indexStamp } = require('../src/view/data');
const { mapView, clampDepth } = require('../src/view/index');
const { cyclesFor, levelsFor } = require('../src/view/model');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-view-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  runIndex(root, loadConfig(root));
  return root;
}

/** a → b → c, plus an unconnected file. Four nodes, two edges. */
function chainFixture() {
  return fixture({
    'src/alpha.ts': 'import { bravo } from "./bravo";\nexport function alpha() { return bravo(); }\n',
    'src/bravo.ts': 'import { charlie } from "./charlie";\nexport function bravo() { return charlie(); }\n',
    'src/charlie.ts': 'export function charlie() { return 1; }\n',
    'src/lonely.ts': 'export function lonely() { return 0; }\n',
  });
}

const eng = root => engineDir(root);
const paths = slice => slice.files.map(f => f.path).sort();

// ---------------------------------------------------------------- subgraph()

test('empty index yields a drawable empty slice, not a throw', () => {
  const root = fixture({ 'notes.txt': 'no code here\n' });
  const slice = subgraph(eng(root), {});
  assert.deepStrictEqual(slice.files, []);
  assert.deepStrictEqual(slice.edges, []);
  assert.deepStrictEqual(slice.roots, []);
  assert.strictEqual(slice.dropped, 0);
  assert.strictEqual(slice.unresolved, false);
});

test('slice carries the fields a renderer draws from', () => {
  const root = chainFixture();
  const slice = subgraph(eng(root), {});
  assert.strictEqual(slice.total_files, 4);
  for (const f of slice.files) {
    assert.deepStrictEqual(Object.keys(f).sort(), ['lang', 'path', 'repo', 'symbols']);
    assert.strictEqual(typeof f.symbols, 'number', `symbols must be a count: ${f.path}`);
    assert.strictEqual(typeof f.lang, 'string');
    assert.strictEqual(typeof f.repo, 'string');
  }
  for (const e of slice.edges) {
    assert.deepStrictEqual(Object.keys(e).sort(), ['dst', 'kind', 'src']);
    assert.ok(e.kind, 'kind is never empty — it defaults to import');
  }
});

test('edges never dangle: both endpoints are always drawn nodes', () => {
  const root = chainFixture();
  const slice = subgraph(eng(root), { target: 'src/bravo.ts', depth: 1 });
  const shown = new Set(paths(slice));
  for (const e of slice.edges) {
    assert.ok(shown.has(e.src), `edge source outside the slice: ${e.src}`);
    assert.ok(shown.has(e.dst), `edge target outside the slice: ${e.dst}`);
  }
});

test('an unresolved target says so instead of drawing the whole project', () => {
  const root = chainFixture();
  const slice = subgraph(eng(root), { target: 'src/nonexistent.ts' });
  assert.strictEqual(slice.unresolved, true);
  assert.deepStrictEqual(slice.files, []);
  assert.deepStrictEqual(slice.roots, []);
  assert.strictEqual(slice.total_files, 4, 'the project size is still reported');
});

test('targets resolve by path suffix and by symbol name, like the CLI', () => {
  const root = chainFixture();
  const bySuffix = subgraph(eng(root), { target: 'bravo.ts', depth: 0 });
  assert.deepStrictEqual(bySuffix.roots, ['src/bravo.ts']);
  const bySymbol = subgraph(eng(root), { target: 'charlie', depth: 0 });
  assert.deepStrictEqual(bySymbol.roots, ['src/charlie.ts']);
});

test('the neighbourhood is undirected: dependents come too, not just dependencies', () => {
  const root = chainFixture();
  const slice = subgraph(eng(root), { target: 'src/bravo.ts', depth: 1 });
  const shown = paths(slice);
  assert.ok(shown.includes('src/charlie.ts'), 'what bravo imports');
  assert.ok(shown.includes('src/alpha.ts'), 'what imports bravo — the blast radius');
  assert.ok(!shown.includes('src/lonely.ts'), 'depth 1 stops at the neighbours');
});

test('depth bounds the walk', () => {
  const root = chainFixture();
  const near = subgraph(eng(root), { target: 'src/alpha.ts', depth: 1 });
  assert.ok(!paths(near).includes('src/charlie.ts'), 'two hops away at depth 1');
  const far = subgraph(eng(root), { target: 'src/alpha.ts', depth: 2 });
  assert.ok(paths(far).includes('src/charlie.ts'), 'reached at depth 2');
});

test('trimming is never silent: dropped accounts for every omitted file', () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`src/f${i}.ts`] = `export function f${i}() { return ${i}; }\n`;
  const root = fixture(files);
  const slice = subgraph(eng(root), { maxNodes: 5 });
  assert.strictEqual(slice.files.length, 5);
  assert.strictEqual(slice.dropped, 7, 'a picture that omits files must say how many');
  assert.strictEqual(slice.files.length + slice.dropped, slice.total_files);
});

test('an untrimmed slice reports zero dropped', () => {
  const root = chainFixture();
  assert.strictEqual(subgraph(eng(root), { maxNodes: 150 }).dropped, 0);
});

test('anchors survive the trim: the target is never the file that gets cut', () => {
  const files = { 'src/lonely-target.ts': 'export function lonelyTarget() { return 1; }\n' };
  // Twenty well-connected files, so degree ordering would evict a zero-degree
  // target on merit if anchors were not privileged.
  for (let i = 0; i < 20; i++) {
    files[`src/hub${i}.ts`] = `import { hub${(i + 1) % 20} } from "./hub${(i + 1) % 20}";\nexport function hub${i}() { return hub${(i + 1) % 20}(); }\n`;
  }
  const root = fixture(files);
  const slice = subgraph(eng(root), { maxNodes: 3 });
  assert.ok(!paths(slice).includes('src/lonely-target.ts'), 'unanchored, it loses on degree');
  const anchored = subgraph(eng(root), { target: 'src/lonely-target.ts', depth: 0, maxNodes: 1 });
  assert.ok(paths(anchored).includes('src/lonely-target.ts'), 'as target it cannot be dropped');
});

test('pinned files survive the trim the same way a target does', () => {
  const files = {};
  for (let i = 0; i < 20; i++) {
    files[`src/hub${i}.ts`] = `import { hub${(i + 1) % 20} } from "./hub${(i + 1) % 20}";\nexport function hub${i}() { return hub${(i + 1) % 20}(); }\n`;
  }
  files['src/quiet.ts'] = 'export function quiet() { return 1; }\n';
  const root = fixture(files);
  const pinned = subgraph(eng(root), { pin: ['src/quiet.ts'], depth: 0, maxNodes: 1 });
  assert.ok(paths(pinned).includes('src/quiet.ts'), 'a capsule pivot is an anchor');
});

test('repo scoping filters the slice', () => {
  const root = chainFixture();
  const slice = subgraph(eng(root), { repo: 'no-such-repo' });
  assert.deepStrictEqual(slice.files, []);
});

// -------------------------------------------------------------- fileDetail()

test('fileDetail carries both edge directions and the symbol list', () => {
  const root = chainFixture();
  const detail = fileDetail(eng(root), 'src/bravo.ts');
  assert.deepStrictEqual(Object.keys(detail).sort(),
    ['dependencies', 'dependents', 'file', 'lang', 'repo', 'size', 'symbols']);
  assert.strictEqual(detail.file, 'src/bravo.ts');
  assert.ok(detail.size > 0);
  assert.deepStrictEqual(detail.dependencies.map(d => d.f), ['src/charlie.ts']);
  assert.deepStrictEqual(detail.dependents.map(d => d.f), ['src/alpha.ts']);
  assert.ok(detail.symbols.some(s => s.name === 'bravo'));
  for (const s of detail.symbols) {
    assert.deepStrictEqual(Object.keys(s).sort(), ['kind', 'line', 'name', 'signature']);
  }
});

test('symbols come back in source order', () => {
  const root = fixture({ 'src/many.ts': 'export function one() {}\nexport function two() {}\nexport function three() {}\n' });
  const lines = fileDetail(eng(root), 'src/many.ts').symbols.map(s => s.line);
  assert.deepStrictEqual([...lines].sort((a, b) => a - b), lines);
});

test('fileDetail on an unknown file is null, not an empty shell', () => {
  const root = chainFixture();
  assert.strictEqual(fileDetail(eng(root), 'src/nope.ts'), null);
});

// -------------------------------------------------------------- indexStamp()

test('indexStamp reports a generation that live frames can compare', () => {
  const root = chainFixture();
  const stamp = indexStamp(eng(root));
  assert.strictEqual(typeof stamp, 'number');
  assert.ok(stamp > 0, 'an indexed project has a generation');
});

// -------------------------------------------------------------- clampDepth()

test('depth is clamped to 1..6 and garbage falls back', () => {
  assert.strictEqual(clampDepth('3'), 3);
  assert.strictEqual(clampDepth(0), 1);
  assert.strictEqual(clampDepth(99), 6);
  assert.strictEqual(clampDepth(2.9), 2, 'truncated, not rounded');
  assert.strictEqual(clampDepth('abc'), 2, 'default fallback');
  assert.strictEqual(clampDepth(undefined, 4), 4);
});

// ----------------------------------------------------------------- mapView()

test('mapView without a task carries no capsule overlay', () => {
  const root = chainFixture();
  const view = mapView(root, eng(root), loadConfig(root), {});
  assert.strictEqual(view.task, '');
  assert.strictEqual(view.intent, '');
  assert.strictEqual(view.counts.focus, 0, 'nothing is lit when nothing was asked');
});

test('a task lights the real capsule: pivots and skeletons come back marked', () => {
  const root = fixture({
    'src/zebra.ts': 'export function zebra() { return 1; }\n',
    'src/caller.ts': 'import { zebra } from "./zebra";\nexport function caller() { return zebra(); }\n',
  });
  const view = mapView(root, eng(root), loadConfig(root), { task: 'how does zebra work' });
  assert.strictEqual(view.intent, 'explore', 'the overlay runs the real pipeline, not a lookalike');
  const lit = view.nodes.filter(n => n.focus).map(n => n.key);
  assert.ok(lit.includes('src/zebra.ts'), 'the pivot for this task is lit');
  assert.strictEqual(view.counts.focus, lit.length);
});

// The anchor set can be larger than the map's node budget all by itself. When
// it is, every candidate is an anchor and a single flag is no tiebreak — degree
// decides, and a zero-degree pivot loses to a well-connected skeleton. That
// trades away the files the capsule was drawn to show.
test('pivots outrank skeletons when the capsule overflows map_max_nodes', () => {
  const files = { 'src/zebra.ts': 'export function zebra() { return 1; }\n' };
  for (let i = 0; i < 20; i++) {
    files[`src/hub${i}.ts`] = `import { hub${(i + 1) % 20} } from "./hub${(i + 1) % 20}";\nexport function hub${i}() { return hub${(i + 1) % 20}(); }\n`;
  }
  const root = fixture(files);
  const cfg = loadConfig(root);
  cfg.ui = { ...(cfg.ui || {}), map_max_nodes: 2 };
  const view = mapView(root, eng(root), cfg, { task: 'how does zebra work', depth: 0 });
  assert.ok(view.nodes.some(n => n.key === 'src/zebra.ts'), 'a pivot is never traded for a skeleton');
});

test('mapView reports the target it could not resolve', () => {
  const root = chainFixture();
  const view = mapView(root, eng(root), loadConfig(root), { target: 'src/nope.ts' });
  assert.strictEqual(view.unresolved, true);
  assert.strictEqual(view.target, 'src/nope.ts');
});

test('mapView passes the trim report through to the page', () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`src/f${i}.ts`] = `export function f${i}() { return ${i}; }\n`;
  const root = fixture(files);
  const cfg = loadConfig(root);
  cfg.ui = { ...(cfg.ui || {}), map_max_nodes: 5 };
  const view = mapView(root, eng(root), cfg, {});
  assert.strictEqual(view.dropped, 7);
  assert.strictEqual(view.total_files, 12);
});

test('the map draws roots and dependency direction as the engine sees them', () => {
  const root = chainFixture();
  const view = mapView(root, eng(root), loadConfig(root), { target: 'src/bravo.ts', depth: 1 });
  const rootNode = view.nodes.find(n => n.isRoot);
  assert.strictEqual(rootNode.key, 'src/bravo.ts');
  assert.strictEqual(rootNode.focus, true, 'the target is always lit');
  const byId = new Map(view.nodes.map(n => [n.id, n.key]));
  // alpha imports bravo, so the arrow runs bravo → alpha: dependency first.
  const edge = view.edges.find(e => byId.get(e.to) === 'src/alpha.ts');
  assert.strictEqual(byId.get(edge.from), 'src/bravo.ts');
});

// ------------------------------------------- graph claims inherited by a port

test('a cycle is a strongly connected component larger than one', () => {
  const deps = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']], ['e', []]]);
  const cycles = cyclesFor(['a', 'b', 'c', 'd', 'e'], deps);
  assert.strictEqual(cycles.length, 1);
  assert.deepStrictEqual(cycles[0], ['a', 'b', 'c']);
});

test('a lone file is a component but not a cycle', () => {
  assert.deepStrictEqual(cyclesFor(['a', 'b'], new Map([['a', ['b']], ['b', []]])), []);
  assert.deepStrictEqual(cyclesFor(['a'], new Map([['a', ['a']]])), [], 'a self-import is not a cycle');
});

test('cycle detection survives a graph deep enough to blow a recursive stack', () => {
  const keys = [];
  const deps = new Map();
  for (let i = 0; i < 20000; i++) {
    keys.push(`n${i}`);
    deps.set(`n${i}`, i + 1 < 20000 ? [`n${i + 1}`] : []);
  }
  assert.deepStrictEqual(cyclesFor(keys, deps), [], 'iterative Tarjan, not recursive');
});

test('imports flow left to right: a file sits right of its deepest dependency', () => {
  const deps = new Map([['a', ['b']], ['b', ['c']], ['c', []]]);
  const levels = levelsFor(['a', 'b', 'c'], deps);
  assert.strictEqual(levels.get('c'), 0);
  assert.strictEqual(levels.get('b'), 1);
  assert.strictEqual(levels.get('a'), 2);
});

test('files in a cycle still get a finite level — the walk terminates', () => {
  const deps = new Map([['a', ['b']], ['b', ['a']], ['c', ['a']]]);
  const levels = levelsFor(['a', 'b', 'c'], deps);
  for (const key of ['a', 'b', 'c']) {
    assert.ok(Number.isFinite(levels.get(key)), `${key} landed nowhere`);
    assert.ok(levels.get(key) >= 0);
  }
});

test('every dependency the layout walks is a file the slice draws', () => {
  // levelsFor's doc says an absent dependency contributes no depth; the code
  // actually levels an unknown key at 0. Unreachable today because buildMapView
  // seeds deps from the drawn keys and adds an edge only when both endpoints
  // are present. This pins the reason it stays unreachable.
  const root = chainFixture();
  const view = mapView(root, eng(root), loadConfig(root), { target: 'src/bravo.ts', depth: 1 });
  const drawn = new Set(view.nodes.map(n => n.key));
  const ids = new Set(view.nodes.map(n => n.id));
  for (const e of view.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), 'an edge endpoint had no node');
  }
  assert.ok(drawn.size > 0);
});

test('a file with no local edges either way is marked isolated', () => {
  const root = chainFixture();
  const view = mapView(root, eng(root), loadConfig(root), {});
  const lonely = view.nodes.find(n => n.key === 'src/lonely.ts');
  assert.strictEqual(lonely.isolated, true);
  assert.strictEqual(view.nodes.find(n => n.key === 'src/bravo.ts').isolated, false);
  assert.strictEqual(view.counts.isolated, 1);
});

test('the resolved target outranks a capsule pivot for the last slot', () => {
  const files = { 'src/zebra.ts': 'export function zebra() { return 1; }\n' };
  for (let i = 0; i < 20; i++) {
    files[`src/hub${i}.ts`] = `import { hub${(i + 1) % 20} } from "./hub${(i + 1) % 20}";\nexport function hub${i}() { return hub${(i + 1) % 20}(); }\n`;
  }
  const root = fixture(files);
  const slice = subgraph(eng(root), {
    target: 'src/hub7.ts',
    depth: 0,
    maxNodes: 1,
    pin: ['src/zebra.ts'],
    prefer: ['src/hub3.ts'],
  });
  assert.deepStrictEqual(paths(slice), ['src/hub7.ts'], 'what was asked for wins');
});

test('a skeleton still outranks an unrelated file', () => {
  const files = {};
  for (let i = 0; i < 20; i++) {
    files[`src/hub${i}.ts`] = `import { hub${(i + 1) % 20} } from "./hub${(i + 1) % 20}";\nexport function hub${i}() { return hub${(i + 1) % 20}(); }\n`;
  }
  files['src/quiet.ts'] = 'export function quiet() { return 1; }\n';
  const root = fixture(files);
  const slice = subgraph(eng(root), { prefer: ['src/quiet.ts'], depth: 1, maxNodes: 1 });
  assert.deepStrictEqual(paths(slice), ['src/quiet.ts'], 'preferred beats degree');
});
