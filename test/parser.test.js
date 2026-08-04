'use strict';
// Pins per-language import extraction and symbol capture. Every case here was
// verified against a real repo before being frozen into a test.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFile } = require('../src/parser');

test('js/ts: es modules, side-effect, cjs, aliases', () => {
  const r = parseFile('src/a.ts', [
    "import { x } from './util';",
    "import '@/styles.css';",
    "const y = require('./y');",
    'export function go() {}',
    'export interface Shape {}',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, ['./util', '@/styles.css', './y']);
  assert.ok(r.nodes.some(n => n.kind === 'function' && n.name === 'go'));
  assert.ok(r.nodes.some(n => n.kind === 'interface' && n.name === 'Shape'));
});

test('python: from/import forms with alias', () => {
  const r = parseFile('a.py', 'from app.util import x\nimport helper as h\ndef run():\n  pass\n');
  assert.deepStrictEqual(r.imports, ['app.util', 'helper']);
  assert.ok(r.nodes.some(n => n.kind === 'function' && n.name === 'run'));
});

test('rust: use, pub use, mod declaration, grouped use expansion', () => {
  const r = parseFile('src/app.rs', [
    'use crate::config::Config;',
    'pub use crate::exports::Thing;',
    'mod helpers;',
    'use crate::tui::{history, chat as c, self};',
    'use std::fmt;',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, [
    'crate::config::Config', 'crate::exports::Thing', 'helpers',
    'crate::tui::history', 'crate::tui::chat', 'crate::tui', 'std::fmt',
  ]);
});

test('go: grouped blocks, aliased and single imports', () => {
  const r = parseFile('cmd/main.go', [
    'package main', 'import (', '\t"fmt"', '\tsrv "example.com/app/internal/server"', ')',
    'import lone "example.com/app/internal/util"',
  ].join('\n'));
  assert.deepStrictEqual(r.imports,
    ['fmt', 'example.com/app/internal/server', 'example.com/app/internal/util']);
});

test('php: use forms, requires, class references, type declarations', () => {
  const r = parseFile('app/x.php', [
    '<?php', 'use Minz\\Request;', 'use App\\Models\\{Feed, Entry as E};',
    "require_once(__DIR__ . '/lib/rss.php');", "include 'constants.php';",
    'class Handler extends BaseHandler {}', 'interface FeedInterface {}',
    'trait Cache {}', '$x = new Widget();', 'Registry::get();',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, [
    'Minz\\Request', 'App\\Models\\Feed', 'App\\Models\\Entry',
    './lib/rss.php', 'constants.php', 'BaseHandler', 'Widget', 'Registry',
  ]);
  for (const name of ['Handler', 'FeedInterface', 'Cache'])
    assert.ok(r.nodes.some(n => n.kind === 'class' && n.name === name), name);
});

test('swift: plain, @testable, and item imports', () => {
  const r = parseFile('Sources/App/main.swift',
    'import Foundation\n@testable import ExtractKit\nimport struct PrismaKit.Schema\n');
  assert.deepStrictEqual(r.imports, ['Foundation', 'ExtractKit', 'PrismaKit.Schema']);
});

test('java: plain, static (member dropped), wildcard (trailing dot)', () => {
  const r = parseFile('src/A.java', [
    'import com.app.util.Helper;', 'import static com.app.Config.DEBUG;',
    'import com.app.models.*;',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, ['com.app.util.Helper', 'com.app.Config', 'com.app.models.']);
});

test('kotlin: alias import and wildcard', () => {
  const r = parseFile('src/A.kt', 'import com.app.Db as Database\nimport com.app.models.*\n');
  assert.deepStrictEqual(r.imports, ['com.app.Db', 'com.app.models.']);
});

test('csharp: using forms captured, using-statements not, namespace as node', () => {
  const r = parseFile('src/A.cs', [
    'global using App.Shared;', 'using App.Services;', 'using static App.Core.Util;',
    'using S = App.Sessions.Store;', 'using (var f = open()) {}', 'using var g = open();',
    'namespace App.Web;', 'class Recorder {}',
  ].join('\n'));
  assert.deepStrictEqual(r.imports,
    ['App.Shared', 'App.Services', 'App.Core.Util', 'App.Sessions.Store']);
  assert.ok(r.nodes.some(n => n.kind === 'module' && n.name === 'App.Web'));
  assert.ok(r.nodes.some(n => n.kind === 'class' && n.name === 'Recorder'));
});

test('lua: both function forms and requires', () => {
  const r = parseFile('src/client.lua', [
    'local json = require("json")',
    'local function call(path) end',
    'function M.chat(msg) end',
    'handler = function(x) end',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, ['json']);
  const names = r.nodes.filter(n => n.kind === 'function').map(n => n.name);
  assert.deepStrictEqual(names, ['call', 'M.chat', 'handler']);
});

test('markdown: headings and links, fenced code ignored', () => {
  const r = parseFile('README.md', '# Title\n```\n# not a heading\n```\n## Real\n[doc](./doc.md)\n');
  const kinds = r.nodes.map(n => `${n.kind}:${n.name}`);
  assert.ok(kinds.includes('section:Title') && kinds.includes('section:Real'));
  assert.ok(!kinds.includes('section:not a heading'));
  assert.ok(r.nodes.some(n => n.kind === 'link' && n.name === 'doc'));
});
