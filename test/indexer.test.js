'use strict';
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

function edgesOf(root) {
  runIndex(root, loadConfig(root));
  const db = openStore(engineDir(root));
  const rows = db.prepare('SELECT src_file, dst_file FROM edges ORDER BY src_file, dst_file').all();
  db.close();
  return rows.map(r => `${r.src_file} -> ${r.dst_file}`);
}

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
