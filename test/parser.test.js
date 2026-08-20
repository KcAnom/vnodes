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

test('dart: declarations, members, getters, factories', () => {
  const r = parseFile('lib/src/badge.dart', [
    "import 'package:flutter/widgets.dart';",
    "import 'package:phluts_framework/phluts_framework.dart' as fw;",
    'typedef Builder = Widget Function();',
    'const kDefaultSize = 8.0;',
    'abstract class PhlutsParser<T> {',
    '  const PhlutsParser();',
    '  String get type;',
    '  T getModel(Map<String, dynamic> json);',
    '  Widget parse(BuildContext context, T model);',
    '}',
    'mixin Loggable on Object {}',
    'extension ColorX on Color {}',
    'extension on int {}',
    'enum Mode { light, dark }',
    'class BadgeParser extends PhlutsParser<Badge> {',
    "  @override",
    "  String get type => 'customBadge';",
    '  factory BadgeParser.fromJson(Map<String, dynamic> j) => BadgeParser();',
    '  static Widget? build(BuildContext context) {',
    '    return Container();',
    '  }',
    '}',
  ].join('\n'));
  assert.deepStrictEqual(r.imports,
    ['package:flutter/widgets.dart', 'package:phluts_framework/phluts_framework.dart']);
  const named = k => r.nodes.filter(n => n.kind === k).map(n => n.name);
  assert.deepStrictEqual(named('class'), ['PhlutsParser', 'BadgeParser']);
  assert.deepStrictEqual(named('mixin'), ['Loggable']);
  assert.deepStrictEqual(named('extension'), ['ColorX']); // anonymous one skipped
  assert.deepStrictEqual(named('enum'), ['Mode']);
  assert.deepStrictEqual(named('type'), ['Builder']);
  assert.deepStrictEqual(named('const'), ['kDefaultSize']);
  assert.deepStrictEqual(named('getter'), ['type', 'type']);
  assert.deepStrictEqual(named('constructor'), ['PhlutsParser', 'BadgeParser.fromJson']);
  assert.deepStrictEqual(named('function'), ['getModel', 'parse', 'build']);
});

test('dart: flutter widget-tree calls are not mistaken for declarations', () => {
  const r = parseFile('lib/screen.dart', [
    'class Screen extends StatelessWidget {',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    final label = compute();',
    '    return Column(',
    '      children: [',
    '        Container(',
    "          child: Text('hi'),",
    '        ),',
    '        const SizedBox(height: 8),',
    '      ],',
    '    );',
    '  }',
    '}',
  ].join('\n'));
  const names = r.nodes.map(n => n.name);
  assert.deepStrictEqual(names, ['Screen', 'build']);
  for (const junk of ['Column', 'Container', 'Text', 'SizedBox', 'label', 'compute'])
    assert.ok(!names.includes(junk), `${junk} leaked into the index`);
});

// Both cases below were real false positives found by indexing a Flutter repo.
test('dart: ternary branches and Function types are not declarations', () => {
  const r = parseFile('lib/avatar.dart', [
    'class AvatarParser {',
    '  Widget parse(BuildContext context, Avatar model) {',
    '    final image = model.background != null',
    '        ? NetworkImage(model.background!)',
    '        : null;',
    '  }',
    '}',
    'typedef ErrorBuilder = Widget Function(',
    '  BuildContext context, dynamic error);',
  ].join('\n'));
  const names = r.nodes.map(n => n.name);
  assert.deepStrictEqual(names, ['AvatarParser', 'parse', 'ErrorBuilder']);
  assert.ok(!names.includes('NetworkImage'), 'ternary branch read as a declaration');
  assert.ok(!names.includes('Function'), 'Function type read as a declaration');
});

test('dart: constructor calls in top-level literals are not declarations', () => {
  const r = parseFile('lib/entries.dart', [
    'const entries = [',
    '  PlaygroundEntry(title: "a"),',
    '  const PlaygroundEntry(title: "b"),',
    '];',
    'class HomeCubit {',
    '  HomeCubit();',
    '  const HomeCubit.seeded(this.value);',
    '  void load() {',
    '    emit(const PlaygroundEntry(title: "c"));',
    '  }',
    '}',
  ].join('\n'));
  const ctors = r.nodes.filter(n => n.kind === 'constructor').map(n => n.name);
  assert.deepStrictEqual(ctors, ['HomeCubit', 'HomeCubit.seeded']);
  assert.ok(!r.nodes.some(n => n.name === 'PlaygroundEntry'),
    'constructor call captured as a declaration');
});

test('dart: private and generated constructors are declarations too', () => {
  const r = parseFile('lib/card.dart', [
    'class _Card extends StatelessWidget {',
    '  const _Card({this.label});',
    '  _Card.raw(this.label);',
    '}',
    'class $Model {',
    '  factory $Model.fromJson(Map<String, dynamic> json) => $Model();',
    '}',
  ].join('\n'));
  const ctors = r.nodes.filter(n => n.kind === 'constructor').map(n => n.name);
  assert.deepStrictEqual(ctors, ['_Card', '_Card.raw', '$Model.fromJson']);
});

test('dart: code inside a multi-line string is data, not code', () => {
  const r = parseFile('lib/init_command.dart', [
    "import 'dart:io';",
    'class InitCommand {',
    '  String template() {',
    "    return '''",
    "import 'package:phluts/phluts_core.dart';",
    'class HelloWorld extends StatelessWidget {',
    '  const HelloWorld();',
    '}',
    "''';",
    '  }',
    '}',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, ['dart:io'],
    'an import inside a template string became a real dependency');
  assert.ok(!r.nodes.some(n => n.name === 'HelloWorld'),
    'a class inside a template string became a real node');
});

test('dart: operator overloads are captured, call sites are not', () => {
  const r = parseFile('lib/access.dart', [
    'class ProjectAccess {',
    '  @override',
    '  bool operator ==(Object other) => other is ProjectAccess;',
    '  @override',
    '  int get hashCode => 0;',
    '  ProjectAccess operator +(ProjectAccess other) => this;',
    '  String operator [](int i) => "x";',
    '}',
    'void use() {',
    '  if (a == b) print(a[0]);',
    '}',
  ].join('\n'));
  const ops = r.nodes.filter(n => n.signature.includes('operator ')).map(n => n.name);
  assert.deepStrictEqual(ops, ['==', '+', '[]']);
  assert.ok(r.nodes.some(n => n.kind === 'getter' && n.name === 'hashCode'),
    'the getter that pairs with == stopped being captured');
});

test('dart: configurable import alternatives are captured', () => {
  const r = parseFile('lib/log.dart', [
    "import 'package:phluts_logger/src/log_interface.dart';",
    "import 'log_stub.dart'",
    "    if (dart.library.io) 'log_io.dart'",
    "    if (dart.library.js_interop) 'log_web.dart';",
    "export 'shim_stub.dart' if (dart.library.io) 'shim_io.dart';",
    // A collection-if in a map literal is the near-miss the `dart.library.`
    // anchor exists to reject.
    'const routes = {',
    "  if (kIsWeb) 'web': WebRoute(),",
    '};',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, [
    'package:phluts_logger/src/log_interface.dart',
    'log_stub.dart',
    'log_io.dart',
    'log_web.dart',
    'shim_io.dart',
    'shim_stub.dart',
  ]);
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

test('shell: source and dot-source captured, dynamic and env paths skipped', () => {
  const r = parseFile('run.sh', [
    'source lib/common.sh', '. ./helpers.sh', 'source "$HOME/conf.sh"',
    'source ~/.zshrc', 'deploy() {', '}',
  ].join('\n'));
  assert.deepStrictEqual(r.imports, ['lib/common.sh', './helpers.sh', '~/.zshrc']);
  assert.ok(r.nodes.some(n => n.kind === 'function' && n.name === 'deploy'));
});

test('markdown: headings and links, fenced code ignored', () => {
  const r = parseFile('README.md', '# Title\n```\n# not a heading\n```\n## Real\n[doc](./doc.md)\n');
  const kinds = r.nodes.map(n => `${n.kind}:${n.name}`);
  assert.ok(kinds.includes('section:Title') && kinds.includes('section:Real'));
  assert.ok(!kinds.includes('section:not a heading'));
  assert.ok(r.nodes.some(n => n.kind === 'link' && n.name === 'doc'));
});
