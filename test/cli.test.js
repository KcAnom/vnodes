'use strict';
// Pins the CLI argv switch: unknown commands fail, help succeeds, $HOME is
// not indexed without --force, and `ui bases` is a real page.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'vnodes.js');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 8000,
    env: opts.env ?? process.env,
  });
}

test('unknown command exits 1 and prints help', () => {
  const r = run(['nosuch']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /usage: vnodes/);
});

test('help exits 0', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: vnodes/);
  assert.match(r.stdout, /capsule <task/);
  assert.match(r.stdout, /llm \[status\|install\|enable/);
  assert.match(r.stdout, /bases \(picker/);
});

test('bare invocation is help and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: vnodes/);
});

test('ui bases does not say no page "bases"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-cli-ui-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-cli-home-'));
  const env = {
    ...process.env,
    VNODES_HOME: home,
    VNODES_PORT: String(18000 + Math.floor(Math.random() * 1000)),
  };
  try {
    const r = run(['ui', 'bases', '--project', tmp], { env, timeout: 12000 });
    const text = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(text, /no page "bases"/);
    assert.match(r.stdout, /\/ui\/bases/);
  } finally {
    run(['daemon', 'stop', '--project', tmp], { env, timeout: 5000 });
  }
});

test('unknown ui page lists bases among pages', () => {
  const r = run(['ui', 'not-a-page']);
  assert.match(r.stdout, /no page "not-a-page"/);
  assert.match(r.stdout, /\bbases\b/);
});

test('index --project $HOME without --force exits 1 before runIndex', () => {
  const home = os.homedir();
  const stamp = Date.now();
  const db = path.join(home, '.vnodes', 'index.db');
  const dbExists = fs.existsSync(db);
  const mtime = dbExists ? fs.statSync(db).mtimeMs : null;
  const t0 = Date.now();
  const r = run(['index', '--project', home], { timeout: 5000 });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}\n${r.stderr}`, /--force/);
  assert.match(`${r.stdout}\n${r.stderr}`, /home directory/);
  assert.ok(elapsed < 3000, `home index ran too long (${elapsed}ms) — refuse must happen before runIndex`);
  if (dbExists) assert.equal(fs.statSync(db).mtimeMs, mtime, 'touched $HOME/.vnodes/index.db');
  else assert.ok(!fs.existsSync(db), 'created $HOME/.vnodes/index.db');
  assert.ok(Date.now() - stamp >= 0);
});

test('reindex --project $HOME without --force exits 1 before rebuild', () => {
  const r = run(['reindex', '--project', os.homedir()], { timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}\n${r.stderr}`, /--force/);
});
