'use strict';
require('./_registry_home'); // isolates the knowledge-base registry from the developer's real ~/.config
// End-to-end resolution: build fixture repos on disk, run the real index, and
// assert the edges that land in the store. Each language block mirrors a
// verified real-repo behavior.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIndex } = require('../src/indexer');
const { loadConfig, engineDir } = require('../src/config');
const { openStore } = require('../src/store');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function readEdges(root) {
  const db = openStore(engineDir(root));
  const rows = db.prepare('SELECT src_file, dst_file FROM edges ORDER BY src_file, dst_file').all();
  db.close();
  return rows.map(r => `${r.src_file} -> ${r.dst_file}`);
}

function edgesOf(root) {
  runIndex(root, loadConfig(root));
  return readEdges(root);
}

test('incremental: the edge set always equals a cold rebuild', () => {
  // Whether an import resolves depends on the whole file set, not on the
  // importing file's bytes, so a file that never changes still has to be
  // re-resolved when its targets appear, vanish or come back. Skipping it on a
  // content hash loses edges permanently and silently — impact then answers
  // found:true, dependents:0 for a file that genuinely has dependents.
  const base = {
    'src/a.ts': "import './b';\nimport './c';\nexport const a = 1;\n",
    'src/b.ts': 'export const b = 1;\n',
  };
  const withC = { ...base, 'src/c.ts': 'export const c = 1;\n' };
  const root = fixture(base);
  const cold = tree => edgesOf(fixture(tree));
  const warm = () => { runIndex(root, loadConfig(root)); return readEdges(root); };
  const cPath = path.join(root, 'src/c.ts');

  assert.deepStrictEqual(warm(), cold(base));

  // a.ts is byte-identical through every step below.
  fs.writeFileSync(cPath, withC['src/c.ts']);
  assert.deepStrictEqual(warm(), cold(withC), 'a target that appeared never reached its importer');

  fs.unlinkSync(cPath);
  assert.deepStrictEqual(warm(), cold(base), 'a removed target left a stale edge');

  fs.writeFileSync(cPath, withC['src/c.ts']);
  assert.deepStrictEqual(warm(), cold(withC), 'the edge never came back');
});

test('workspace: aliased edges are rebuilt, not lost, on an incremental run', () => {
  // Edges are cleared per repo and re-derived every run, and in a workspace
  // both sides of that are alias-prefixed. Nothing else covers multi-repo.
  const root = fixture({
    'main/src/app.ts': "import './util';\nexport const app = 1;\n",
    'main/src/util.ts': 'export const util = 1;\n',
    'lib/src/helper.ts': "import './shared';\nexport const helper = 1;\n",
    'lib/src/shared.ts': 'export const shared = 1;\n',
    'main/.vnodes/workspace.json': JSON.stringify({
      name: 'ws', primary_alias: 'main', repos: [{ alias: 'lib', path: '../lib' }],
    }),
  });
  const primary = path.join(root, 'main');
  const first = edgesOf(primary);
  assert.ok(first.includes('main/src/app.ts -> main/src/util.ts'), 'primary repo edge missing');
  assert.ok(first.includes('lib/src/helper.ts -> lib/src/shared.ts'), 'secondary repo edge missing');
  assert.deepStrictEqual(edgesOf(primary), first, 'an incremental run dropped aliased edges');
});

test('js/ts: relative imports and tsconfig aliases', () => {
  const root = fixture({
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    'src/a.ts': "import { u } from './util';\nimport { v } from '@/deep/v';\n",
    'src/util.ts': 'export const u = 1;\n',
    'src/deep/v.ts': 'export const v = 1;\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('src/a.ts -> src/util.ts'));
  assert.ok(edges.includes('src/a.ts -> src/deep/v.ts'));
});

test('python: sibling resolves, stdlib does not', () => {
  const root = fixture({
    'main.py': 'import helper\nimport os\n',
    'helper.py': 'def h():\n  pass\n',
  });
  assert.deepStrictEqual(edgesOf(root), ['main.py -> helper.py']);
});

test('rust: crate::, mod declarations, grouped use', () => {
  const root = fixture({
    'src/main.rs': 'mod config;\nmod ui;\nuse crate::ui::{panel, style};\nfn main() {}\n',
    'src/config.rs': 'pub struct Config;\n',
    'src/ui/mod.rs': 'pub mod panel;\npub mod style;\n',
    'src/ui/panel.rs': 'pub fn draw() {}\n',
    'src/ui/style.rs': 'pub fn color() {}\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('src/main.rs -> src/config.rs'));
  assert.ok(edges.includes('src/main.rs -> src/ui/panel.rs'));
  assert.ok(edges.includes('src/main.rs -> src/ui/style.rs'));
  assert.ok(edges.includes('src/ui/mod.rs -> src/ui/panel.rs'));
});

test('dart: package: URIs via pubspec names, relative, export, part', () => {
  const root = fixture({
    'packages/app/pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.0.0"\n',
    'packages/core/pubspec.yaml': "name: core\n",
    'packages/app/lib/app.dart': [
      "import 'dart:async';",
      "import 'package:core/core.dart';",
      "import 'package:flutter/material.dart';",
      "import 'src/screen.dart';",
      "export 'src/screen.dart';",
      'class App {}',
    ].join('\n'),
    'packages/app/lib/src/screen.dart': "part 'screen.g.dart';\nclass Screen {}\n",
    'packages/app/lib/src/screen.g.dart': "part of 'screen.dart';\n",
    'packages/core/lib/core.dart': 'class Core {}\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('packages/app/lib/app.dart -> packages/core/lib/core.dart'),
    'package: URI did not resolve through the pubspec name');
  assert.ok(edges.includes('packages/app/lib/app.dart -> packages/app/lib/src/screen.dart'),
    'bare relative import did not resolve');
  assert.ok(edges.includes('packages/app/lib/src/screen.dart -> packages/app/lib/src/screen.g.dart'),
    'part directive did not resolve');
  // `part of` restates the parent's `part`; emitting it too would put every
  // generated file in a 2-cycle with its source for no added reachability.
  assert.ok(!edges.includes('packages/app/lib/src/screen.g.dart -> packages/app/lib/src/screen.dart'),
    'part-of fabricated a reverse edge');
  // dart: is the SDK and flutter is not in this tree — neither is a graph node.
  assert.ok(!edges.some(e => e.includes('async') || e.includes('material')),
    'external or SDK import fabricated an edge');
});

test('dart: a root pubspec outranks a nested one with the same name', () => {
  // Vendored copies duplicate a package name, and the shallowest pubspec is
  // documented to win. The root's dir is '', whose segment count is 1 — the
  // same as 'app' — so a naive comparison ties and lets walk order decide.
  const root = fixture({
    'pubspec.yaml': 'name: shared\n',
    'lib/one.dart': 'class One {}\n',
    'app/pubspec.yaml': 'name: shared\n',
    'app/lib/one.dart': 'class AppOne {}\n',
    'app/lib/main.dart': "import 'package:shared/one.dart';\nclass Main {}\n",
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('app/lib/main.dart -> lib/one.dart'),
    'package: URI resolved to the nested pubspec; the root one is shallower');
  assert.ok(!edges.includes('app/lib/main.dart -> app/lib/one.dart'),
    'resolution depended on walk order');
});

test('go: go.mod module paths anchor on <dir>/<dirname>.go', () => {
  const root = fixture({
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'cmd/main.go': 'package main\nimport (\n\t"fmt"\n\tu "example.com/app/internal/util"\n)\n',
    'internal/util/util.go': 'package util\n',
    'internal/util/aaa.go': 'package util\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('cmd/main.go -> internal/util/util.go'), edges.join('\n'));
});

test('php: PSR-4, unique class reference, ambiguous class stays unresolved', () => {
  const root = fixture({
    'composer.json': '{"autoload":{"psr-4":{"App\\\\":"src/"}}}',
    'index.php': "<?php\nuse App\\Models\\Feed;\n$u = new Uniq();\n$d = new Dup();\n",
    'src/Models/Feed.php': '<?php\nclass Feed {}\n',
    'lib/Uniq.php': '<?php\nclass Uniq {}\n',
    'lib/Dup.php': '<?php\nclass Dup {}\n',
    'other/Dup.php': '<?php\nclass Dup {}\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('index.php -> src/Models/Feed.php'));
  assert.ok(edges.includes('index.php -> lib/Uniq.php'));
  assert.ok(!edges.some(e => e.includes('Dup')), 'ambiguous class must not edge');
});

test('swift: module imports anchor on Sources/<Module>/<Module>.swift', () => {
  const root = fixture({
    'Sources/App/main.swift': 'import Core\n',
    'Sources/Core/Core.swift': 'public struct Core {}\n',
    'Sources/Core/Aux.swift': 'struct Aux {}\n',
  });
  assert.ok(edgesOf(root).includes('Sources/App/main.swift -> Sources/Core/Core.swift'));
});

test('java: package-path suffix match and wildcard package anchor', () => {
  const root = fixture({
    'src/com/app/Main.java': 'package com.app;\nimport com.app.util.Helper;\nimport com.app.models.*;\nclass Main {}\n',
    'src/com/app/util/Helper.java': 'package com.app.util;\nclass Helper {}\n',
    'src/com/app/models/Feed.java': 'package com.app.models;\nclass Feed {}\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('src/com/app/Main.java -> src/com/app/util/Helper.java'));
  assert.ok(edges.includes('src/com/app/Main.java -> src/com/app/models/Feed.java'));
});

test('csharp: using resolves via namespace declarations', () => {
  const root = fixture({
    'A/Service.cs': 'namespace App.Services;\nclass Service {}\n',
    'B/Client.cs': 'using App.Services;\nclass Client {}\n',
  });
  assert.ok(edgesOf(root).includes('B/Client.cs -> A/Service.cs'));
});

test('lua: dotted path, root-relative, and unique-basename requires', () => {
  const root = fixture({
    'main.lua': 'local u = require("lib.util")\nlocal c = require("client")\nlocal s = require("socket.http")\n',
    'lib/util.lua': 'return {}\n',
    'src/client.lua': 'return {}\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('main.lua -> lib/util.lua'));
  assert.ok(edges.includes('main.lua -> src/client.lua'));
  assert.ok(!edges.some(e => e.includes('socket')), 'external require must not edge');
});

test('shell: source resolves script-relative and root-relative, externals do not', () => {
  const root = fixture({
    'bin/run.sh': 'source ../lib/common.sh\nsource scripts/env.sh\nsource ~/.zshrc\n',
    'lib/common.sh': 'common() { :; }\n',
    'scripts/env.sh': 'setup() { :; }\n',
  });
  const edges = edgesOf(root);
  assert.ok(edges.includes('bin/run.sh -> lib/common.sh'));
  assert.ok(edges.includes('bin/run.sh -> scripts/env.sh'));
  assert.strictEqual(edges.length, 2, 'externals must not edge');
});

test('secrets and oversized files are skipped', () => {
  const root = fixture({
    '.env': 'SECRET=1\n',
    'big.js': `// ${'x'.repeat(2048)}\n`,
    'ok.js': 'const a = 1;\n',
  });
  fs.mkdirSync(path.join(root, '.vnodes'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vnodes', 'config.json'), '{"index":{"max_file_size_kb":1}}');
  runIndex(root, loadConfig(root));
  const db = openStore(engineDir(root));
  const files = db.prepare('SELECT path FROM files').all().map(r => r.path);
  db.close();
  assert.ok(files.includes('ok.js'));
  assert.ok(!files.includes('.env'), 'secret file must be skipped');
  assert.ok(!files.includes('big.js'), 'oversized file must be skipped');
});

// --------------------------------------- what is excluded, and by which rule

const { excludedSummary } = require('../src/exclusions');
const { indexStatus } = require('../src/indexer');

test('an exclusion names the file that made it', () => {
  const root = fixture({
    'src/kept.ts': 'export function kept() { return 1; }\n',
    'src/generated.ts': 'export function generated() { return 1; }\n',
    'scratch/junk.ts': 'export function junk() { return 1; }\n',
    '.gitignore': 'src/generated.ts\n',
    '.vnodesignore': 'scratch/\n',
  });
  const report = excludedSummary(root);
  const byPath = new Map([...report.subtrees, ...report.files].map(i => [i.path, i]));

  assert.strictEqual(byPath.get('src/generated.ts')?.source, '.gitignore');
  assert.strictEqual(byPath.get('src/generated.ts')?.pattern, 'src/generated.ts');
  assert.strictEqual(byPath.get('scratch/')?.source, '.vnodesignore');
  assert.ok(!byPath.has('src/kept.ts'), 'an indexed file is not reported as excluded');
});

test('a nested ignore file is named as the rule, not the root one', () => {
  const root = fixture({
    'ui/src/app.ts': 'export function app() { return 1; }\n',
    'ui/build/out.ts': 'export function out() { return 1; }\n',
    'ui/.gitignore': 'build/\n',
  });
  const report = excludedSummary(root);
  const build = [...report.subtrees].find(s => s.path === 'ui/build/');
  assert.ok(build, 'a subdirectory .gitignore must still exclude');
  assert.strictEqual(build.source, 'ui/.gitignore',
    'attributing it to the root .gitignore would send someone to the wrong file to fix it');
});

test('an excluded directory is reported as a subtree, not walked', () => {
  const files = { 'src/app.ts': 'export function app() { return 1; }\n', '.gitignore': 'vendor/\n' };
  for (let i = 0; i < 40; i++) files[`vendor/dep${i}.ts`] = `export function dep${i}() {}\n`;
  const root = fixture(files);
  const report = excludedSummary(root);
  assert.ok(report.subtrees.some(s => s.path === 'vendor/'));
  assert.strictEqual(report.files.filter(f => f.path.startsWith('vendor/')).length, 0,
    'listing every file under an excluded tree buries the answer it is meant to give');
});

test('files with no recognised language are not reported as excluded', () => {
  const root = fixture({
    'src/app.ts': 'export function app() { return 1; }\n',
    'notes.bin': 'binary-ish\n',
    '.gitignore': 'notes.bin\n',
  });
  const report = excludedSummary(root);
  assert.ok(!report.files.some(f => f.path === 'notes.bin'),
    'it was never a candidate, so calling it excluded is noise');
});

test('a relative workspace secondary path is resolved against the workspace, not cwd', () => {
  // excludedSummary used to walk `r.path` as-is. A secondary `../lib` then
  // became a relative-from-cwd junk path, so the report silently omitted
  // whatever the indexer actually skipped in that repo.
  const root = fixture({
    'main/src/app.ts': 'export function app() { return 1; }\n',
    'lib/ok.ts': 'export function ok() { return 1; }\n',
    'lib/secret.ts': 'export function secret() { return 1; }\n',
    'lib/.gitignore': 'secret.ts\n',
    'main/.vnodes/workspace.json': JSON.stringify({
      name: 'ws', primary_alias: 'main',
      repos: [
        { alias: 'lib', path: '../lib' },
        { alias: 'gone', path: '../does-not-exist' },
      ],
    }),
  });
  const primary = path.join(root, 'main');
  const report = excludedSummary(primary);
  const names = [...report.files, ...report.subtrees].map(i => i.path);
  assert.ok(names.includes('lib/secret.ts'),
    `relative secondary must resolve against workspace.baseDir; got ${names.join(', ') || '(none)'}`);
  assert.strictEqual(names.filter(p => p.includes('does-not-exist')).length, 0,
    'a missing secondary repo must be skipped, not walked');
});

test('index_status carries the exclusions, so an agent can ask why', () => {
  const root = fixture({
    'src/app.ts': 'export function app() { return 1; }\n',
    'src/hidden.ts': 'export function hidden() { return 1; }\n',
    '.gitignore': 'src/hidden.ts\n',
  });
  // This file's fixture() writes the tree without indexing it, and
  // indexStatus returns 'uninitialized' before it reaches the exclusions.
  runIndex(root, loadConfig(root));
  const status = indexStatus(root);
  assert.ok(status.excluded, 'index_status must report what it left out');
  assert.strictEqual(status.excluded.by_source['.gitignore'], 1);
  assert.ok(status.excluded.sample.some(s => s.startsWith('src/hidden.ts')),
    'the sample names the path, because "why is X missing" is answered by seeing X');
});
