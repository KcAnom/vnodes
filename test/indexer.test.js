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
