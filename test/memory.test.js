'use strict';
require('./_registry_home'); // isolates the knowledge-base registry from the developer's real ~/.config
/**
 * Pins the relevance surface against the failure that made it useless on its
 * own repo.
 *
 * `run_pipeline` writes the task text verbatim into an observation, and
 * `searchMemory` scores by term overlap against that text — so asking the same
 * question twice matched its own history perfectly. Measured 2026-08-23: two
 * task records scored 16.00 against real findings at 5.50, 4.50 and 3.25, and
 * once the memory reserve landed they were eating about 40% of it. The number
 * was not wrong; the question was. Against a task record, term overlap asks
 * "is this the same question" — this function exists to answer "does this
 * knowledge bear on it".
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { captureObservation, searchMemory, sessionContext } = require('../src/memory');
const { openStore } = require('../src/store');
const { runIndex } = require('../src/indexer');
const { loadConfig } = require('../src/config');

const TASK = 'refactor the daemon registry capsule and tools for the picker';

function store() {
  const engDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-memory-'));
  // What the capsule writes about itself: the query, quoted back. The file is
  // set because callTool links a task record to its first pivot, which is the
  // only reason these ever score at all once the echo is discounted.
  captureObservation(engDir, {
    session: 'old', tool: 'run_pipeline', kind: 'auto', file: 'src/registry.js',
    summary: `task: ${TASK} → intent=refactor, 3 pivots, 9 skeletons, 4000 tokens`,
  });
  // What somebody chose to write down. Deliberately shares few words with the
  // query, so it can only win on being a finding rather than on echoing.
  captureObservation(engDir, {
    session: 'old', tool: 'save_observation', kind: 'manual', file: 'src/registry.js',
    summary: 'resolveKb shape-gates to 16 hex chars before any I/O, so caller text never reaches path.join',
  });
  return engDir;
}

test('capsules attach findings only, never task echoes', () => {
  const hits = searchMemory(store(), TASK, { limit: 5, readOnly: true, findingsOnly: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'manual');
});

test('a task record cannot outrank a finding by quoting the question back', () => {
  const hits = searchMemory(store(), TASK, { limit: 5, readOnly: true });
  assert.ok(hits.length >= 2, 'expected both rows to be eligible');
  assert.equal(hits[0].kind, 'manual', `a task echo ranked first: ${hits[0].summary.slice(0, 50)}`);
});

test('a task record is demoted, not silenced', () => {
  const hits = searchMemory(store(), TASK, { limit: 5, readOnly: true });
  assert.ok(hits.some(h => h.tool === 'run_pipeline'), 'the task record vanished instead of ranking lower');
});

test('a task record can still match on what it produced', () => {
  const engDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-memory-'));
  captureObservation(engDir, {
    session: 'old', tool: 'run_pipeline', kind: 'auto', file: 'src/capsule.js',
    summary: 'task: something entirely unrelated → intent=explore, 1 pivots',
  });
  const hits = searchMemory(engDir, 'capsule.js', { limit: 5, readOnly: true });
  assert.equal(hits.length, 1, 'matching on the file it touched was lost too');
});

test('kind multiplies rather than adds, so it survives a big match count', () => {
  const engDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-memory-'));
  const body = 'daemon registry capsule tools picker indexer skeleton budget';
  captureObservation(engDir, { session: 'a', tool: 'workspace_setup', kind: 'auto', summary: body });
  captureObservation(engDir, { session: 'a', tool: 'save_observation', kind: 'manual', summary: body });
  const hits = searchMemory(engDir, body, { limit: 5, readOnly: true });
  assert.equal(hits[0].kind, 'manual', 'identical text, and the byproduct still won');
});

test('session context still reports task records — activity is its job', () => {
  const rows = sessionContext(store(), { limit: 10, readOnly: true });
  assert.ok(rows.some(r => r.tool === 'run_pipeline'), 'demoting them in search removed them everywhere');
});

test('a stale finding is still returned, carrying its warning', () => {
  const engDir = store();
  const db = new (require('node:sqlite').DatabaseSync)(path.join(engDir, 'memory.db'));
  db.prepare('UPDATE observations SET stale = 1 WHERE kind = ?').run('manual');
  db.close();
  const hits = searchMemory(engDir, TASK, { limit: 5, readOnly: true });
  const stale = hits.find(h => h.kind === 'manual');
  assert.ok(stale, 'a stale finding was dropped instead of demoted');
  assert.match(stale.warning, /stale/);
});

test('a finding can be deleted; a task record cannot', () => {
  const { deleteObservation } = require('../src/memory');
  const engDir = store();
  const hits = searchMemory(engDir, TASK, { limit: 5, readOnly: true, findingsOnly: true });
  const id = hits[0].id;
  assert.deepEqual(deleteObservation(engDir, id), { ok: true, id });
  assert.equal(searchMemory(engDir, TASK, { findingsOnly: true, readOnly: true }).length, 0);
  const log = sessionContext(engDir, { limit: 10, readOnly: true });
  const taskRow = log.find(r => r.tool === 'run_pipeline');
  assert.ok(taskRow);
  const blocked = deleteObservation(engDir, taskRow.id);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /only findings/);
});

test('updateObservation rewrites a finding and refuses a task row', () => {
  const { updateObservation } = require('../src/memory');
  const engDir = store();
  const hits = searchMemory(engDir, TASK, { findingsOnly: true, readOnly: true });
  const id = hits[0].id;
  const out = updateObservation(engDir, { id, summary: 'shape-gate first, then I/O' });
  assert.equal(out.ok, true);
  const again = searchMemory(engDir, 'shape-gate', { findingsOnly: true, readOnly: true });
  assert.match(again[0].summary, /shape-gate/);
  const log = sessionContext(engDir, { limit: 10, readOnly: true });
  const taskRow = log.find(r => r.tool === 'run_pipeline');
  assert.equal(updateObservation(engDir, { id: taskRow.id, summary: 'nope' }).ok, false);
});

test('clearActivity deletes auto rows and keeps findings', () => {
  const { clearActivity } = require('../src/memory');
  const engDir = store();
  const out = clearActivity(engDir);
  assert.ok(out.deleted >= 1);
  const log = sessionContext(engDir, { limit: 20, readOnly: true });
  assert.ok(log.every(r => r.kind === 'manual'));
});

test('concurrent capsule completions wait for observation writes instead of locking', { timeout: 30000 }, async () => {
  const engDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-memory-concurrent-'));
  const idx = openStore(engDir);
  idx.prepare('INSERT INTO files (path, repo, hash, size, lang, indexed_at) VALUES (?,?,?,?,?,?)')
    .run('src/pivot.js', '', 'hash-1', 1, 'javascript', Date.now());
  idx.close();
  captureObservation(engDir, {
    session: 'seed', tool: 'run_pipeline', file: 'src/pivot.js', summary: 'seed',
  });

  const workers = 8;
  const writesPerWorker = 20;
  const startsAt = Date.now() + 1000;
  const memoryModule = path.join(__dirname, '..', 'src', 'memory.js');
  const script = `
    process.removeAllListeners('warning');
    const { captureObservation } = require(${JSON.stringify(memoryModule)});
    const startsAt = Number(process.argv[1]);
    const worker = process.argv[2];
    while (Date.now() < startsAt) {}
    for (let i = 0; i < ${writesPerWorker}; i++) {
      captureObservation(${JSON.stringify(engDir)}, {
        session: 'worker-' + worker,
        tool: 'run_pipeline',
        file: 'src/pivot.js',
        summary: 'parallel capsule ' + worker + ':' + i,
      });
    }
  `;

  const runWorker = worker => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, String(startsAt), String(worker)], {
      cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`)));
  });
  await Promise.all(Array.from({ length: workers }, (_, i) => runWorker(i)));

  const db = new (require('node:sqlite').DatabaseSync)(path.join(engDir, 'memory.db'), { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
  db.close();
  assert.strictEqual(count, 1 + workers * writesPerWorker,
    'a concurrent writer failed or lost an observation');
});

test('concurrent run_pipeline processes complete against one knowledge base', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-pipeline-concurrent-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'pivot.js'), 'export function pivot() { return 1; }\n');
  runIndex(root, loadConfig(root));

  const workers = 8;
  const startsAt = Date.now() + 1000;
  const toolsModule = path.join(__dirname, '..', 'src', 'tools.js');
  const script = `
    process.removeAllListeners('warning');
    const { callTool } = require(${JSON.stringify(toolsModule)});
    const startsAt = Number(process.argv[1]);
    const worker = process.argv[2];
    while (Date.now() < startsAt) {}
    const result = callTool(${JSON.stringify(root)}, 'run_pipeline', {
      task: 'explain pivot worker ' + worker,
      preset: 'explore',
    }, 'worker-' + worker);
    if (!result.pivots || result.pivots[0]?.file !== 'src/pivot.js') process.exit(2);
  `;

  const runWorker = worker => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, String(startsAt), String(worker)], {
      cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`pipeline worker ${worker} exited ${code}: ${stderr}`)));
  });
  await Promise.all(Array.from({ length: workers }, (_, i) => runWorker(i)));

  const db = new (require('node:sqlite').DatabaseSync)(path.join(root, '.vnodes', 'memory.db'), { readOnly: true });
  const count = db.prepare("SELECT COUNT(*) c FROM observations WHERE tool = 'run_pipeline'").get().c;
  db.close();
  assert.strictEqual(count, workers, 'a pipeline failed before recording its completion');
});
