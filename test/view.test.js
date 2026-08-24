'use strict';
require('./_registry_home'); // isolates the knowledge-base registry from the developer's real ~/.config
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

// -------------------------------------------------------- the served bundle

test('the shell page loads the committed bundle', () => {
  const { renderShell, bundleReady } = require('../src/view/shell');
  assert.strictEqual(bundleReady(), true, 'src/view/static/map.js is committed — build ui/ if this fails');
  const html = renderShell();
  assert.match(html, /<link rel="stylesheet" href="\/ui\/static\/map\.css">/);
  assert.match(html, /<script type="module" src="\/ui\/static\/map\.js"><\/script>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html), 'the page reaches no host but this one');
});

test('static serving refuses anything outside the bundle directory', () => {
  const { readAsset } = require('../src/view/shell');
  for (const attempt of [
    '../../package.json',
    '../data.js',
    '/etc/passwd',
    '..%2f..%2fpackage.json',
    '....//package.json',
  ]) {
    assert.strictEqual(readAsset(attempt), null, `traversal not refused: ${attempt}`);
  }
});

test('static serving refuses file types a build does not emit', () => {
  const { readAsset } = require('../src/view/shell');
  assert.strictEqual(readAsset('map.json'), null);
  assert.strictEqual(readAsset('map'), null);
  assert.strictEqual(readAsset(''), null);
});

test('the bundle is served with the type a browser needs to run it', () => {
  const { readAsset } = require('../src/view/shell');
  const js = readAsset('map.js');
  assert.ok(js, 'map.js must be committed');
  assert.strictEqual(js.type, 'text/javascript; charset=utf-8');
  assert.ok(js.body.length > 0);
  assert.strictEqual(readAsset('map.css').type, 'text/css; charset=utf-8');
});

// ------------------------------------------------- geometry as a DOM contract
//
// The header above says box sizes are left untested because they were the part
// being replaced. They were replaced — by a React client whose node component
// pins itself to a number this file declares, with no compiler between the two
// halves. That is a contract, not a style choice, and the last time it went
// unpinned the two sides disagreed by 15.25px and clipped 44 of 49 boxes.

test('node height is one declared number, the same in both densities', () => {
  const { geometry, NODE_HEIGHT } = require('../src/view/model');
  // The other half of this contract is ui/src/kit/NodeShell.tsx: h-[49px]
  // header + h-[31px] body + 1px border top and bottom.
  assert.strictEqual(NODE_HEIGHT, 82);
  assert.strictEqual(geometry(true).nodeHeight, 82, 'compact may narrow a box, never shorten it');
  assert.strictEqual(geometry(false).nodeHeight, 82);
  const root = chainFixture();
  const view = mapView(root, eng(root), loadConfig(root), {});
  assert.strictEqual(view.nodeHeight, 82, 'what the page is handed matches what the DOM renders');
  assert.strictEqual(view.geom.nodeHeight, 82);
});

test('geometry carries no typography the DOM does not implement', () => {
  const { geometry } = require('../src/view/model');
  assert.deepStrictEqual(Object.keys(geometry(false)).sort(),
    ['colGap', 'compact', 'margin', 'maxRows', 'nodeHeight', 'nodeWidth', 'rowGap']);
});

// ----------------------------------------------------------- the content filter

/** One code file, one document, one config — three languages, one of them code. */
function mixedFixture() {
  return fixture({
    'src/a.ts': 'export function a() { return 1; }\n',
    'docs/notes.md': '# Notes\n\nSome prose.\n',
    'config/x.json': '{"name":"x"}\n',
  });
}

test('the map draws code by default and says what it withheld', () => {
  const root = mixedFixture();
  const slice = subgraph(eng(root), {});
  assert.deepStrictEqual(paths(slice), ['src/a.ts']);
  assert.strictEqual(slice.show, 'code');
  assert.strictEqual(slice.filtered.count, 2, 'a filtered file is never silently gone');
  assert.deepStrictEqual(slice.filtered.langs, { markdown: 1, json: 1 });
});

test('show:all draws the documents too, and reports nothing filtered', () => {
  const root = mixedFixture();
  const slice = subgraph(eng(root), { show: 'all' });
  assert.strictEqual(slice.files.length, 3);
  assert.strictEqual(slice.show, 'all');
  assert.deepStrictEqual(slice.filtered, { count: 0, langs: {} });
});

test('the filter is by language, not by degree: isolated code still draws', () => {
  const root = chainFixture();
  const slice = subgraph(eng(root), {});
  assert.ok(paths(slice).includes('src/lonely.ts'), 'a zero-degree rule would delete this');
  assert.strictEqual(slice.filtered.count, 0, 'a code-only project filters nothing');
});

// -------------------------------------------------------------- the path scope

/** src/ imports itself and is imported from outside — one edge each way. */
function scopedFixture() {
  return fixture({
    'src/core.ts': 'export function core() { return 1; }\n',
    'src/edge.ts': 'import { core } from "./core";\nimport { helper } from "../lib/helper";\nexport function edge() { return core() + helper(); }\n',
    'lib/helper.ts': 'export function helper() { return 2; }\n',
    'app/main.ts': 'import { edge } from "../src/edge";\nexport function main() { return edge(); }\n',
  });
}

test('a path scope draws the subtree whole, not a neighbourhood of it', () => {
  const root = scopedFixture();
  const slice = subgraph(eng(root), { path: 'src' });
  assert.deepStrictEqual(paths(slice), ['src/core.ts', 'src/edge.ts']);
  assert.strictEqual(slice.path, 'src');
  for (const e of slice.edges) {
    assert.ok(e.src.startsWith('src/') && e.dst.startsWith('src/'), 'both endpoints are inside');
  }
});

test('a path scope says the subtree is not self-contained', () => {
  const root = scopedFixture();
  const slice = subgraph(eng(root), { path: 'src/' });
  assert.strictEqual(slice.path, 'src', 'a trailing slash is a signal, not part of the prefix');
  assert.strictEqual(slice.out_of_scope, 2, 'lib/helper.ts and app/main.ts');
  assert.strictEqual(slice.crossing.in, 1, 'app/main.ts imports src/edge.ts');
  assert.strictEqual(slice.crossing.out, 1, 'src/edge.ts imports lib/helper.ts');
});

test('a directory target is promoted to a scope instead of failing to resolve', () => {
  const root = scopedFixture();
  const view = mapView(root, eng(root), loadConfig(root), { target: 'src' });
  assert.strictEqual(view.unresolved, false, 'vnodes map src forwards the bare word');
  assert.strictEqual(view.path, 'src');
  assert.deepStrictEqual(view.nodes.map(n => n.key).sort(), ['src/core.ts', 'src/edge.ts']);
});

test('a target that is no file, symbol or directory is still unresolved', () => {
  const root = scopedFixture();
  const view = mapView(root, eng(root), loadConfig(root), { target: 'no-such' });
  assert.strictEqual(view.unresolved, true);
});

// --------------------------------------------------------------- the accounting

test('every omitted file is accounted for by exactly one field', () => {
  const files = { 'README.md': '# readme\n', 'package.json': '{"name":"p"}\n' };
  for (let i = 0; i < 12; i++) files[`src/f${i}.ts`] = `export function f${i}() { return ${i}; }\n`;
  const root = fixture(files);
  const cfg = loadConfig(root);
  cfg.ui = { ...(cfg.ui || {}), map_max_nodes: 5 };
  const view = mapView(root, eng(root), cfg, {});
  assert.strictEqual(
    view.counts.files + view.dropped + view.filtered.count + view.out_of_scope,
    view.total_files,
    'a file the map does not draw is trimmed, filtered or out of scope — never nowhere');
});

test('the accounting holds under a path scope too', () => {
  const root = scopedFixture();
  const view = mapView(root, eng(root), loadConfig(root), { path: 'src' });
  assert.strictEqual(
    view.counts.files + view.dropped + view.filtered.count + view.out_of_scope,
    view.total_files);
});

test('nodes carry the top-level group the client tints by', () => {
  const root = scopedFixture();
  const view = mapView(root, eng(root), loadConfig(root), { show: 'all' });
  const groups = new Set(view.nodes.map(n => n.group));
  assert.ok(groups.has('src') && groups.has('lib') && groups.has('app'));
  const rootFile = view.nodes.find(n => !n.key.includes('/'));
  if (rootFile) assert.strictEqual(rootFile.group, '(root)');
});

test('an anchored document is drawn: the content filter never eats a pivot', () => {
  const root = mixedFixture();
  const anchored = subgraph(eng(root), { pin: ['docs/notes.md'], depth: 0 });
  assert.ok(paths(anchored).includes('docs/notes.md'), 'a capsule pivot outranks the language rule');
  // The walk already scoped this to the pin, so nothing reached the filter —
  // an anchor that survives was never withheld, and `filtered` does not claim
  // it was.
  assert.strictEqual(anchored.filtered.count, 0);
  const target = subgraph(eng(root), { target: 'docs/notes.md', depth: 0 });
  assert.deepStrictEqual(paths(target), ['docs/notes.md'], 'and so does an explicit target');
});

// ------------------------------------------------- the rest of the /ui surface
//
// /ui stopped being one map page and one <dl>. What follows pins the parts a
// renderer cannot check for itself: which URLs exist, what the shell says it is
// before React boots, what the read-only data routes are allowed to hand over,
// and the two hardening rules that only look like configuration.

test('every page the daemon dispatches has a title of its own', () => {
  const { PAGES, renderShell } = require('../src/view/shell');
  assert.deepStrictEqual([...PAGES.keys()],
    ['/ui', '/ui/bases', '/ui/map', '/ui/capsule', '/ui/notes', '/ui/index']);
  for (const [pathname, title] of PAGES) {
    const html = renderShell(pathname);
    assert.match(html, new RegExp(`<title>${title.replace(/[—]/g, '.')}</title>`),
      `${pathname} did not render its own title`);
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html), 'the page reaches no host but this one');
  }
  // Four routes drew "dependency map" in the tab before React booted. The
  // zero-argument call is what the old test and the old daemon both used.
  assert.match(renderShell(), /<title>vnodes — dependency map<\/title>/);
});

test('only the map preloads the React Flow chunk', () => {
  const { renderShell, STATIC_DIR } = require('../src/view/shell');
  const split = fs.existsSync(path.join(STATIC_DIR, 'map-App.js'));
  for (const pathname of ['/ui', '/ui/bases', '/ui/capsule', '/ui/notes', '/ui/index']) {
    assert.ok(!renderShell(pathname).includes('modulepreload'),
      `${pathname} preloads a chunk it does not draw`);
  }
  assert.strictEqual(renderShell('/ui/map').includes('modulepreload'), split,
    'the map preloads its chunk exactly when the split build has emitted one');
});

test('a missing asset is named, not implied', () => {
  const { renderMissingBundle } = require('../src/view/shell');
  const html = renderMissingBundle(['map-App.js']);
  assert.match(html, /map-App\.js/, 'the page must say which file is missing');
  assert.match(html, /\/ui\/status/, 'and point at the page that needs no bundle');
  assert.match(html, /\/ui\/map\/data/);
});

test('/rpc refuses the cross-origin write hole and nothing else', () => {
  const { rpcDenial } = require('../src/daemon');
  const req = (headers) => ({ headers });
  const json = { host: '127.0.0.1:7821', 'content-type': 'application/json' };

  // The CLI and the MCP client: no Origin at all.
  assert.strictEqual(rpcDenial(req(json), 7821), null);
  assert.strictEqual(rpcDenial(req({ ...json, host: 'localhost:7821' }), 7821), null);
  assert.strictEqual(rpcDenial(req({ ...json, origin: 'http://127.0.0.1:7821' }), 7821), null);
  assert.strictEqual(rpcDenial(req({ ...json, 'content-type': 'application/json; charset=utf-8' }), 7821), null);

  // The hole: text/plain is CORS-simple, so a page anywhere could POST it with
  // no preflight, and /rpc reaches save_observation and workspace_setup.
  assert.match(rpcDenial(req({ ...json, 'content-type': 'text/plain' }), 7821), /content-type/);
  assert.match(rpcDenial(req({ ...json, origin: 'https://evil.example' }), 7821), /origin/);
  assert.match(rpcDenial(req({ ...json, host: 'evil.example' }), 7821), /host/);
  assert.match(rpcDenial(req({ host: '127.0.0.1:7821' }), 7821), /content-type/);
});

test('the capsule the UI is handed carries costs, not file bodies', () => {
  const { capsuleForUi } = require('../src/daemon');
  const cfg = loadConfig(process.cwd());
  const raw = {
    intent: 'debug', intent_reason: 'regex', budget_tokens: 8000, used_tokens: 100,
    pivots: [
      { file: 'src/a.js', tokens: 40, content: 'x'.repeat(9000) },
      { file: 'src/b.js', tokens: 60, content: 'y'.repeat(9000), clipped: true, full_tokens: 2850 },
    ],
    skeletons: [{ file: 'src/c.js', tokens: 10, detail: 'standard', content: 'z'.repeat(5000) }],
    memories: [], truncated: true, omitted: [{ file: 'src/d.js', est_tokens: 12, reason: 'budget' }],
  };
  const ui = capsuleForUi(raw, 'why does it fail', cfg);
  assert.strictEqual(ui.pivots[0].content, undefined, 'an unclipped pivot ships no body');
  assert.strictEqual(ui.pivots[0].tokens, 40, 'but keeps its cost');
  assert.strictEqual(ui.pivots[1].content.length, 2000, 'a clipped pivot ships the head of the clip only');
  assert.strictEqual(ui.pivots[1].full_tokens, 2850, 'and what it would have cost whole');
  assert.strictEqual(ui.skeletons[0].content, undefined);
  assert.strictEqual(ui.skeletons[0].tokens, 10);
  assert.ok(ui.stripped, 'the page has to be able to say the bodies are not here');
  assert.strictEqual(ui.baseline, cfg.capsule.savings_baseline);
  assert.strictEqual(ui.command, 'vnodes pipeline "why does it fail"');
  assert.deepStrictEqual(ui.omitted, raw.omitted, 'omissions survive the strip');
});

test('composition sees where files are and how big they are', () => {
  const root = fixture({
    'src/one.ts': 'import { two } from "./two";\nexport function one() { return two(); }\n',
    'src/two.ts': 'export function two() { return 2; }\n',
    'ui/.shots/.chrome/a.json': '{"a":1}\n',
    'ui/.shots/.chrome/b.json': '{"b":2}\n',
    'notes.md': '# notes\n',
  });
  const { composition } = require('../src/daemon');
  const c = composition(eng(root));

  assert.strictEqual(c.total_files, 5);
  assert.ok(c.total_bytes > 0);
  const dirs = c.by_dir.map(d => d.dir);
  // Two segments, not one: `ui/.shots` hiding inside `ui` is how 78% of an
  // index became invisible to every check the project had.
  assert.ok(dirs.includes('ui/.shots'), `expected ui/.shots as its own row, got ${dirs.join(', ')}`);
  assert.ok(dirs.includes('src'));
  assert.ok(dirs.includes('(root)'), 'a file at the top of the tree still belongs somewhere');
  assert.strictEqual(c.by_dir.find(d => d.dir === 'src').files, 2);
  assert.ok(c.largest.length > 0 && c.largest[0].size >= c.largest[c.largest.length - 1].size);
  assert.ok(c.no_edges.includes('notes.md'), 'a file with no edges is named');
  assert.strictEqual(c.no_edges_total, c.no_edges.length, 'the cap has to report how much it cut');
  assert.strictEqual(c.no_symbols_total, c.no_symbols.length);
  assert.ok(c.ignore_suggestion.every(s => typeof s === 'string'),
    'a remedy is a line to copy — the daemon never writes .vnodesignore itself');
});

test('a nested .gitignore is read one level down', () => {
  // ui/.gitignore already said `.shots/` and the indexer never looked at it,
  // because ignore-file names were joined against the project root alone.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-nested-ignore-'));
  fs.mkdirSync(path.join(root, 'ui', '.shots'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ui', '.gitignore'), '.shots/\n');
  fs.writeFileSync(path.join(root, 'ui', '.shots', 'cache.js'), 'export const junk = 1;\n');
  fs.writeFileSync(path.join(root, 'ui', 'real.js'), 'export const real = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'shots.js'), 'export const shots = 1;\n');

  const { buildIgnore } = require('../src/ignore');
  const isIgnored = buildIgnore(root);
  assert.strictEqual(isIgnored('ui/.shots/cache.js'), true);
  assert.strictEqual(isIgnored('ui/real.js'), false);
  // Scoped to the directory that declared it, the way git scopes it: a rule in
  // ui/.gitignore must not reach across the tree and eat src/.
  assert.strictEqual(isIgnored('src/.shots/cache.js'), false);
  assert.strictEqual(isIgnored('src/shots.js'), false);
});

// ------------------------------------------------- one writer, many readers

test('a second daemon on the same project does not claim indexing', () => {
  const { claimIndexing } = require('../src/daemon');
  const root = fixture({ 'src/one.ts': 'export function one() { return 1; }\n' });
  const pidPath = path.join(root, '.vnodes', 'daemon.pid');

  assert.strictEqual(claimIndexing(root, 7821), true, 'an unclaimed project is claimable');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(pidPath, 'utf8')), { pid: process.pid, port: 7821 });

  // A live daemon that is not us. Our own pid stands in for one, because it is
  // the only pid this test can be certain is running.
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: 7821 }));
  const original = process.pid;
  Object.defineProperty(process, 'pid', { value: original + 1, configurable: true });
  try {
    assert.strictEqual(claimIndexing(root, 41003), false, 'a live owner must not be displaced');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(pidPath, 'utf8')).port, 7821,
      'the follower must not overwrite the owner pidfile — `daemon stop` reads it',
    );
  } finally {
    Object.defineProperty(process, 'pid', { value: original, configurable: true });
  }
});

test('a dead owner is taken over, not deferred to forever', () => {
  const { claimIndexing } = require('../src/daemon');
  const root = fixture({ 'src/one.ts': 'export function one() { return 1; }\n' });
  const pidPath = path.join(root, '.vnodes', 'daemon.pid');
  // A pid high enough to be unallocated: the owner is gone and its pidfile is stale.
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 999999, port: 7821 }));
  assert.strictEqual(claimIndexing(root, 41003), true, 'a stale pidfile must not block indexing forever');
  assert.strictEqual(JSON.parse(fs.readFileSync(pidPath, 'utf8')).port, 41003);
});

// The plain status page is reached from the rail's "plain" link, and the rail
// is inside the bundle it deliberately does not depend on. Whatever navigation
// it has, it has to carry itself — these pin that it does, and that every
// destination is a page the daemon actually serves.

test('the plain status page carries its own way back', () => {
  const { uiHtml } = require('../src/daemon');
  const html = uiHtml({ ui: { sidebar_refresh_s: 10 } });
  assert.match(html, /<nav\b/, 'no nav on the one page the rail cannot reach');
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.match(nav, /href="\/ui"/, 'no link back to the app');
  // Above the fold matters here: the reason this page reads as a dead end is
  // navigation placed under the content, not the absence of links.
  assert.ok(html.indexOf('<nav') < html.indexOf('<h1'), 'nav is not first');
});

test('every link on the plain page is a page the daemon serves', () => {
  const { uiHtml, UI_API_ROUTES } = require('../src/daemon');
  const { PAGES } = require('../src/view/shell');
  const html = uiHtml({ ui: { sidebar_refresh_s: 10 } });
  const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1]);
  assert.ok(hrefs.length > 0);
  for (const href of hrefs) {
    const known = href === '/ui/status' || href === '/ui/theme.css' ||
      PAGES.has(href) || UI_API_ROUTES?.has?.(href);
    assert.ok(known, `plain page links to ${href}, which nothing serves`);
  }
});

test('the no-bundle stylesheet styles the nav it now has', () => {
  const { uiThemeCss } = require('../src/daemon');
  assert.match(uiThemeCss(), /\bnav\b/);
});

// A mistyped /ui path is a browser event, not a script one. It answered with
// raw JSON — the page names arrived as quoted strings nobody can click, which
// is the plain page's dead end reached by typo instead of by button.

test('a browser gets a page for an unknown /ui path, curl still gets JSON', () => {
  const { uiNotFound } = require('../src/daemon');
  const { PAGES } = require('../src/view/shell');
  const html = uiNotFound('/ui/nope');
  assert.match(html, /<nav\b/);
  for (const page of PAGES.keys()) {
    assert.match(html, new RegExp(`href="${page}"`), `404 page omits ${page}`);
  }
  assert.match(html, /href="\/ui\/status"/, 'no link to the page that needs no bundle');
});

test('the 404 page escapes the path it echoes', () => {
  const { uiNotFound } = require('../src/daemon');
  const html = uiNotFound('/ui/<script>alert(1)</script>');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'path echoed unescaped');
  assert.match(html, /&lt;script&gt;/);
});
