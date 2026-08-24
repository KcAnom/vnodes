'use strict';
require('./_registry_home'); // first: these tests index, and indexing registers
/**
 * Pins the two halves of "vnodes is used, not merely installed".
 *
 * Both exist because of a measured failure on this repo, 2026-08-23: a full
 * working session — two features, three commits — ran entirely on grep and file
 * reads, made zero code queries, and left 25 observations whose summaries were
 * all argument JSON. The instruction block had said to orient first the whole
 * time. Advisory guidance that nothing checks is guidance that loses, and a
 * memory feed of `{}` rows is a memory that records calls instead of findings.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { callTool, sessionNotice, _sessions } = require('../src/tools');

function kb() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-session-')));
  fs.writeFileSync(path.join(dir, 'a.js'), 'import {b} from "./b.js";\nexport function a(){return b();}\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'export function b(){return 1;}\n');
  callTool(dir, 'create_knowledge_base', {});
  return dir;
}
const observations = dir =>
  new DatabaseSync(path.join(dir, '.vnodes', 'memory.db'))
    .prepare('SELECT tool, kind, summary FROM observations ORDER BY id').all();

test('a session that never orients is told so, and not before it has a habit', () => {
  const dir = kb();
  const s = `never-orients-${Date.now()}`;
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(callTool(dir, 'get_skeleton', { file: 'a.js' }, s).vnodes_notice);
  assert.equal(seen[0], undefined, 'nagged on the first call');
  assert.equal(seen[1], undefined, 'nagged on the second call');
  assert.match(seen[2], /run_pipeline/);
  assert.match(seen[3], /run_pipeline/);
});

test('orienting silences it, and the notice never blocks the result', () => {
  const dir = kb();
  const s = `orients-${Date.now()}`;
  callTool(dir, 'run_pipeline', { task: 'understand a' }, s);
  for (let i = 0; i < 3; i++) {
    const r = callTool(dir, 'get_skeleton', { file: 'a.js' }, s);
    assert.equal(r.vnodes_notice, undefined);
    assert.ok(r.skeleton, 'the tool stopped answering its own question');
  }
});

test('a session that learned nothing down is told that too, and saving stops it', () => {
  const dir = kb();
  const s = `no-saves-${Date.now()}`;
  callTool(dir, 'run_pipeline', { task: 'understand a' }, s);
  let last;
  for (let i = 0; i < 8; i++) last = callTool(dir, 'get_skeleton', { file: 'a.js' }, s);
  assert.match(last.vnodes_notice, /save_observation/);
  callTool(dir, 'save_observation', { summary: 'a depends on b' }, s);
  assert.equal(callTool(dir, 'get_skeleton', { file: 'a.js' }, s).vnodes_notice, undefined);
});

test('only rows that carry a finding are written', () => {
  const dir = kb();
  const s = `capture-${Date.now()}`;
  callTool(dir, 'run_pipeline', { task: 'understand a' }, s);
  callTool(dir, 'get_skeleton', { file: 'a.js' }, s);
  callTool(dir, 'get_impact_graph', { target: 'b.js' }, s);
  callTool(dir, 'index_status', {}, s);
  callTool(dir, 'save_observation', { summary: 'a real finding' }, s);

  const rows = observations(dir);
  // create_knowledge_base, run_pipeline, the manual save. Not the three lookups.
  assert.equal(rows.length, 3, rows.map(r => `${r.tool}:${r.summary}`).join(' | '));
  for (const r of rows) {
    assert.ok(!/^\{.*\}$/.test(r.summary.trim()), `argument JSON got in: ${r.tool} :: ${r.summary}`);
  }
  assert.ok(rows.some(r => r.tool === 'run_pipeline' && /task:/.test(r.summary)), 'lost the task record');
  assert.ok(rows.some(r => r.kind === 'manual'), 'lost the manual save');
});

test('sessionNotice says nothing about a session it has never seen', () => {
  assert.equal(sessionNotice('never-called-anything', 'get_skeleton'), null);
  assert.ok(_sessions instanceof Map, 'session state is in process, not in the table');
});
