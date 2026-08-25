'use strict';
require('./_registry_home');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runIndex, expectedManifest } = require('../src/indexer');
const { loadConfig, engineDir } = require('../src/config');
const { callTool } = require('../src/tools');
const { searchMemory, hasFoundationSeed, FOUNDATION_PREFIX } = require('../src/memory');
const { checkIndex, installHook, runPreCommit } = require('../src/freshness');
const { instructionText } = require('../src/agents');

const BIN = path.join(__dirname, '..', 'bin', 'vnodes.js');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-fresh-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return fs.realpathSync(root);
}

function gitInit(root) {
  const run = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  let r = run(['init']);
  assert.equal(r.status, 0, r.stderr);
  run(['config', 'user.email', 't@t.test']);
  run(['config', 'user.name', 't']);
  run(['add', '.']);
  r = run(['commit', '-m', 'init']);
  assert.equal(r.status, 0, r.stderr);
}

test('the first index writes one durable foundation finding', () => {
  const root = fixture({
    'package.json': '{"name":"seeded-app"}',
    'src/a.js': 'export function a() { return 1; }\n',
    'src/b.js': "import { a } from './a';\nexport function b() { return a(); }\n",
  });
  const r = callTool(root, 'create_knowledge_base', {});
  assert.equal(r.created, true);
  assert.ok(hasFoundationSeed(engineDir(root)));
  const hits = searchMemory(engineDir(root), 'foundation', { findingsOnly: true });
  assert.ok(hits.some(h => h.summary.startsWith(FOUNDATION_PREFIX)), JSON.stringify(hits));
  assert.ok(hits.some(h => /seeded-app/.test(h.summary)));
  assert.ok(hits.some(h => h.kind === 'manual'));
});

test('a second index does not duplicate the foundation finding', () => {
  const root = fixture({ 'src/a.js': 'export const a = 1;\n' });
  callTool(root, 'create_knowledge_base', {});
  callTool(root, 'create_knowledge_base', {});
  const hits = searchMemory(engineDir(root), 'vnodes foundation', { findingsOnly: true, limit: 20 });
  const seeds = hits.filter(h => h.summary.startsWith(FOUNDATION_PREFIX));
  assert.equal(seeds.length, 1, JSON.stringify(seeds));
});

test('vnodes check fails when a source file changes without reindexing', () => {
  const root = fixture({ 'src/a.js': 'export const a = 1;\n' });
  runIndex(root, loadConfig(root));
  const ok = checkIndex(root);
  assert.equal(ok.ok, true, ok.reason);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
  const stale = checkIndex(root);
  assert.equal(stale.ok, false);
  assert.equal(stale.state, 'stale');
  assert.ok(stale.mismatches.some(m => m.path === 'src/a.js' && m.kind === 'hash_mismatch'), JSON.stringify(stale.mismatches));
  runIndex(root, loadConfig(root));
  assert.equal(checkIndex(root).ok, true);
});

test('expectedManifest agrees with the committed manifest after an index', () => {
  const root = fixture({
    'src/a.js': 'export const a = 1;\n',
    'README.md': '# hello\n',
  });
  runIndex(root, loadConfig(root));
  const recorded = JSON.parse(fs.readFileSync(path.join(root, '.vnodes', 'manifest.json'), 'utf8')).files;
  assert.deepStrictEqual(expectedManifest(root, loadConfig(root)), recorded);
});

test('the pre-commit hook reindexes and stages the manifest', () => {
  const root = fixture({ 'src/a.js': 'export const a = 1;\n' });
  gitInit(root);
  runIndex(root, loadConfig(root));
  spawnSync('git', ['-C', root, 'add', '.vnodes/manifest.json']);
  spawnSync('git', ['-C', root, 'commit', '-m', 'index']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
  spawnSync('git', ['-C', root, 'add', 'src/a.js']);
  const hook = runPreCommit(root);
  assert.equal(hook.ok, true, JSON.stringify(hook));
  assert.equal(hook.staged, true);
  const staged = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout;
  assert.match(staged, /\.vnodes\/manifest\.json/);
  assert.equal(checkIndex(root).ok, true);
});

test('hook install writes an executable pre-commit that calls this bin', () => {
  const root = fixture({ 'src/a.js': 'export const a = 1;\n' });
  gitInit(root);
  const r = installHook(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  const hook = fs.readFileSync(r.hook, 'utf8');
  assert.match(hook, /vnodes:begin/);
  assert.match(hook, /hook pre-commit/);
  const st = fs.statSync(r.hook);
  assert.ok(st.mode & 0o100, 'hook is not executable');
});

test('CLI check exits 1 on a stale tree', () => {
  const root = fixture({ 'src/a.js': 'export const a = 1;\n' });
  runIndex(root, loadConfig(root));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
  const r = spawnSync(process.execPath, [BIN, 'check', '--project', root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /"state": "stale"/);
});

test('instruction block tells agents to take impact and keep the index current', () => {
  const block = instructionText('/tmp/example-project');
  assert.match(block, /get_impact_graph/);
  assert.match(block, /save_observation/);
  assert.match(block, /vnodes check/);
  assert.match(block, /hook install/);
  assert.match(block, /create_knowledge_base/);
});
