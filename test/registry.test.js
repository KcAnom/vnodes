'use strict';
require('./_registry_home'); // isolates the knowledge-base registry from the developer's real ~/.config
/**
 * "A ?kb= selector resolves only to a registry entry" as a checkable fact.
 *
 * The daemon can now be told which project to read. That is one parameter away
 * from "open any sqlite file on disk by URL", and localhost is no defence: the
 * browser is on localhost too, and any page in any tab can issue a GET. The
 * property that makes it safe is that resolveKb treats the parameter as a KEY —
 * it is shape-gated to sixteen lowercase hex characters before a single
 * filesystem call, and the path it returns comes out of a file vnodes itself
 * wrote. That is a property of one commit unless something checks it.
 *
 * The case that matters most is the valid-shaped id of a real, unregistered
 * directory. Every other rejection here could be produced by a syntax filter;
 * only that one distinguishes a syntax filter from a membership gate.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const registry = require('../src/registry');
const { registryDir, kbId, resolveKb, recordIndex, recordAgent, listKbs, ensureEntry } = registry;

function tmpdir(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `vnodes-${tag}-`)));
}

/** A project with a finished-looking index, without running the indexer. */
function fixtureProject(tag, { manifest = true, files = 3, edges = 2 } = {}) {
  const root = tmpdir(tag);
  const eng = path.join(root, '.vnodes');
  fs.mkdirSync(eng, { recursive: true });
  const { openStore } = require('../src/store');
  const db = openStore(eng);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_index', ?)").run(String(Date.now()));
  db.close();
  if (manifest) fs.writeFileSync(path.join(eng, 'manifest.json'), JSON.stringify({ version: 1, files: {} }));
  recordIndex(root, { files, nodes: 10, edges, langs: ['js'], repos: ['(root)'], ms: 5, engDir: eng });
  return { root, id: kbId(root), eng };
}

function snapshotTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out.join('\n');
}

test('an index run leaves a well-formed record, and a second run inside the throttle does not rewrite it', () => {
  const { root, id } = fixtureProject('rec');
  const file = path.join(registryDir(), id, 'kb.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Every key present, nulls rather than omissions: a missing key and a stated
  // unknown read identically in a picker, and only one of them is honest.
  for (const k of ['schema', 'id', 'path', 'path_as_given', 'name', 'branch', 'complete',
    'last_indexed_ms', 'last_index_duration_ms', 'files', 'nodes', 'edges', 'langs',
    'repos', 'db_bytes', 'notes', 'notes_manual', 'last_activity_ms', 'snapshot_at', 'writer']) {
    assert.ok(k in rec, `kb.json is missing ${k}`);
  }
  assert.strictEqual(rec.id, id);
  assert.strictEqual(rec.path, root, 'the recorded path is the realpath');
  assert.strictEqual(rec.complete, true);
  assert.strictEqual(rec.files, 3);
  assert.strictEqual(rec.writer, 'runIndex');
  assert.strictEqual(rec.name, path.basename(root));

  const before = fs.statSync(file).mtimeMs;
  const again = recordIndex(root, { files: 3, nodes: 10, edges: 2, ms: 5, engDir: path.join(root, '.vnodes') });
  assert.strictEqual(again.written, false, 'unchanged counts inside write_interval_s must not rewrite');
  assert.strictEqual(fs.statSync(file).mtimeMs, before);

  // Changed counts are a new fact and always land, throttle or not.
  const changed = recordIndex(root, { files: 4, nodes: 12, edges: 3, ms: 6, engDir: path.join(root, '.vnodes') });
  assert.strictEqual(changed.written, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).files, 4);
});

test('a project whose index never finished is recorded as incomplete, with null counts', () => {
  const root = tmpdir('incomplete');
  const eng = path.join(root, '.vnodes');
  fs.mkdirSync(eng, { recursive: true });
  const { openStore } = require('../src/store');
  openStore(eng).close(); // an index.db exists; no run has ever finished
  const r = ensureEntry(root, 'cli');
  const rec = JSON.parse(fs.readFileSync(path.join(registryDir(), r.id, 'kb.json'), 'utf8'));
  assert.strictEqual(rec.complete, false);
  assert.strictEqual(rec.files, null, 'counts from an unfinished run are not reported as results');
  assert.strictEqual(rec.langs, null);

  const { indexStatus } = require('../src/indexer');
  const st = indexStatus(root);
  assert.strictEqual(st.state, 'incomplete', 'an index.db on disk is not evidence a run ever finished');
  assert.match(st.detail, /never finished|unset|missing/);

  const listed = listKbs().kbs.find(k => k.id === r.id);
  assert.strictEqual(listed.state, 'never_completed');
  assert.ok(listed.flags.includes('never_completed'));
  assert.strictEqual(listed.verdict, 'never finished indexing');
});

test('an MCP handshake in an unregistered directory writes nothing', () => {
  const root = tmpdir('unregistered');
  assert.strictEqual(recordAgent(root, { name: 'claude-code', version: '2.1.0' }), null);
  assert.ok(!fs.existsSync(path.join(registryDir(), kbId(root))),
    'a handshake in an unindexed directory must not create an entry — that is how the $HOME accident began');
});

test('200 concurrent agent writes across 8 agents leave 8 parseable files and no temp survivors', async () => {
  const { root, id } = fixtureProject('agents');
  const slugs = ['claude-code', 'codex', 'gemini', 'cursor', 'pi', 'prime', 'zed', 'unknown-agent'];
  const script = `
    const { recordAgent } = require(${JSON.stringify(path.join(ROOT, 'src', 'registry'))});
    for (let i = 0; i < 25; i++) recordAgent(${JSON.stringify(root)}, { name: process.argv[1], version: '1.0.0' });
  `;
  await Promise.all(slugs.map(slug => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, slug], { env: process.env },
      e => (e ? reject(e) : resolve()));
  })));

  const dir = path.join(registryDir(), id, 'agents');
  const names = fs.readdirSync(dir);
  assert.deepStrictEqual(names.filter(n => n.endsWith('.tmp')), [],
    'a rename-based write leaves no .tmp behind');
  assert.strictEqual(names.length, 8, `expected one file per agent, got ${names.join(', ')}`);
  for (const n of names) {
    const a = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    // One logical writer per file is the whole concurrency design: attribution
    // is the one accumulating fact here, and a lost update would silently drop
    // an agent that really did touch this knowledge base.
    assert.strictEqual(a.sessions, 25, `${n} lost an update`);
    assert.ok(a.first_seen_ms <= a.last_seen_ms);
  }
  const listed = listKbs().kbs.find(k => k.id === id);
  assert.strictEqual(listed.agents.length, 8);
});

test('resolveKb refuses everything that is not a registry key, with the right code and no side effects', () => {
  const { root, id } = fixtureProject('resolve');
  const launch = tmpdir('launch');

  // A real directory on disk that nobody registered. This is the case that
  // separates a membership gate from a syntax filter: the id is perfectly
  // well-formed and names a directory that exists.
  const unregistered = tmpdir('unregistered-but-real');
  // A second victim that looks exactly like a knowledge base but was never
  // registered: the store is right there, and nothing may open it.
  const decoy = tmpdir('unregistered-with-index');
  fs.mkdirSync(path.join(decoy, '.vnodes'));
  fs.writeFileSync(path.join(decoy, '.vnodes', 'index.db'), 'not really a database');
  const victims = [unregistered, decoy];
  const before = victims.map(snapshotTree);

  const cases = [
    ['/etc', 'bad_id'],
    ['../../etc/passwd', 'bad_id'],
    ['%2e%2e%2f', 'bad_id'],
    ['..%2F..%2Fetc', 'bad_id'],
    ['~', 'bad_id'],
    [id.toUpperCase(), 'bad_id'],
    ['a'.repeat(40), 'bad_id'],
    [require('node:crypto').createHash('sha1').update(root).digest('hex'), 'bad_id'],
    ['0123456789abcde', 'bad_id'],
    ['0123456789abcdef0', 'bad_id'],
    [kbId(unregistered), 'unknown_kb'],
    [kbId(decoy), 'unknown_kb'],
    [kbId('/etc'), 'unknown_kb'],
    [null, 'no_default'],
  ];
  for (const [raw, code] of cases) {
    const r = resolveKb(raw, null);
    assert.strictEqual(r.ok, false, `resolveKb accepted ${JSON.stringify(raw)}`);
    assert.strictEqual(r.code, code, `resolveKb(${JSON.stringify(raw)}) gave ${r.code}, expected ${code}`);
  }
  assert.deepStrictEqual(victims.map(snapshotTree), before,
    'a refused selector must not create, open or touch anything on disk');

  // Absent selector falls back to the launch project, and only to that.
  const dflt = resolveKb('', launch);
  assert.strictEqual(dflt.ok, true);
  assert.strictEqual(dflt.root, launch);
  assert.strictEqual(dflt.source, 'default');
  // A hub has no launch project, and must say so rather than guess one.
  assert.strictEqual(resolveKb('', null).code, 'no_default');

  const good = resolveKb(id, launch);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.root, root, 'a registered id resolves to the path vnodes recorded, not to the launch project');
  assert.strictEqual(good.source, 'query');
});

test('a registered root that is deleted, emptied or symlink-swapped is refused, never approximated', () => {
  // The project directory is gone.
  const gone = fixtureProject('gone');
  fs.rmSync(gone.root, { recursive: true, force: true });
  assert.strictEqual(resolveKb(gone.id, null).code, 'missing');

  // The project is there; its index is not. A GET must never create one.
  const emptied = fixtureProject('emptied');
  fs.rmSync(path.join(emptied.root, '.vnodes', 'index.db'), { force: true });
  const r = resolveKb(emptied.id, null);
  assert.strictEqual(r.code, 'engine_removed');
  assert.ok(!fs.existsSync(path.join(emptied.root, '.vnodes', 'index.db')),
    'resolving must not bring the store into existence');

  // A symlink swapped in under a registered root. Re-deriving the id from the
  // live realpath is what catches this; trusting the recorded string would have
  // handed the caller a different project's database under the id they asked for.
  const swapped = fixtureProject('swapped');
  const elsewhere = fixtureProject('elsewhere');
  const moved = `${swapped.root}-moved`;
  fs.renameSync(swapped.root, moved);
  fs.symlinkSync(elsewhere.root, swapped.root);
  const s = resolveKb(swapped.id, null);
  assert.strictEqual(s.code, 'moved');
  assert.strictEqual(s.expected, swapped.root);
  fs.unlinkSync(swapped.root);
  fs.renameSync(moved, swapped.root);
});

test('the picker opens no database', () => {
  const a = fixtureProject('nodb-a');
  const b = fixtureProject('nodb-b');
  const dbs = [a, b].map(p => path.join(p.root, '.vnodes', 'index.db'));
  const before = dbs.map(f => fs.statSync(f).mtimeMs);

  const out = listKbs({ launchRoot: a.root });

  assert.deepStrictEqual(dbs.map(f => fs.statSync(f).mtimeMs), before,
    'listKbs touched an index database — indexStatus was measured at 5.8s on one KB alone');
  for (const f of dbs) {
    assert.ok(!fs.existsSync(`${f}-wal`), 'a -wal file means the store was opened for writing');
  }
  for (const p of [a, b]) {
    assert.ok(!fs.existsSync(path.join(p.root, '.vnodes', 'memory.db')),
      'the picker must not create a memory store to count notes');
  }
  assert.ok(out.kbs.find(k => k.id === a.id).is_launch, "the daemon's own project is marked");
  assert.strictEqual(out.registry_dir, registryDir());
  assert.strictEqual(out.hub, false);
  assert.ok(Array.isArray(out.notes));
});

test('hiding is not omission, and forgetting never deletes an index', () => {
  const p = fixtureProject('hide');
  assert.ok(listKbs().kbs.some(k => k.id === p.id));

  registry.hide(p.id);
  const hidden = listKbs();
  assert.ok(!hidden.kbs.some(k => k.id === p.id), 'a hidden knowledge base leaves the list');
  assert.ok(hidden.hidden_count >= 1, 'and is counted, so hiding is never a silent omission');
  assert.ok(hidden.notes.some(n => n.includes('hidden')));

  registry.show(p.id);
  assert.ok(listKbs().kbs.some(k => k.id === p.id));

  const f = registry.forget(p.id);
  assert.strictEqual(f.ok, true);
  assert.ok(!fs.existsSync(path.join(registryDir(), p.id)), 'the registry row is gone');
  assert.ok(fs.existsSync(path.join(p.root, '.vnodes', 'index.db')),
    'forgetting is a registry operation — the index itself is the reader\'s to remove');
  assert.match(f.remove_engine_command, /^rm -rf /);
});

test('the home directory is flagged rather than quietly listed as a project', () => {
  // Recorded without indexing anything: the record is a description, and the
  // point of this test is what a row for $HOME would say if one existed.
  const rec = {
    schema: 1, id: kbId(os.homedir()), path: os.homedir(), path_as_given: null,
    name: 'your home directory', branch: null, complete: false, last_indexed_ms: null,
    last_index_duration_ms: null, files: null, nodes: null, edges: null, langs: null,
    repos: null, db_bytes: null, notes: 0, notes_manual: 0, last_activity_ms: null,
    snapshot_at: Date.now(), writer: 'cli',
  };
  const dir = path.join(registryDir(), rec.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kb.json'), JSON.stringify(rec));
  const row = listKbs().kbs.find(k => k.id === rec.id);
  assert.ok(row.flags.includes('home_dir'), '$HOME must be named as what it is');
  assert.strictEqual(row.name, 'your home directory');
  assert.match(row.remove_engine_command, /\.vnodes$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureIndexed refuses the home directory outright', () => {
  const { ensureIndexed } = require('../src/tools');
  const { loadConfig } = require('../src/config');
  const st = ensureIndexed(os.homedir(), loadConfig(null));
  assert.strictEqual(st.state, 'refused');
  assert.match(st.reason, /home directory/);
  assert.match(st.reason, /vnodes index --project/, 'a refusal has to say what to do instead');
});

async function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

test('a live daemon answers 404 for every non-key and 200 for a real one', async () => {
  const launch = fixtureProject('daemon-launch');
  const other = fixtureProject('daemon-other');
  const unregistered = tmpdir('daemon-victim');
  fs.writeFileSync(path.join(unregistered, 'keep.txt'), 'untouched\n');
  const beforeVictim = snapshotTree(unregistered);

  // No watcher: this test is about the routes, and fs.watch on a temp tree is
  // a background re-index racing every assertion below.
  fs.writeFileSync(path.join(launch.root, '.vnodes', 'config.json'),
    JSON.stringify({ index: { watch: false } }));

  const port = await freePort();
  process.env.VNODES_PORT = String(port);
  const { serve } = require('../src/daemon');
  const handle = serve(launch.root);
  const base = `http://127.0.0.1:${port}`;
  const get = async (url, headers) => {
    const r = await fetch(base + url, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    for (const raw of ['/etc', '../../etc/passwd', '%2e%2e%2f', '~', launch.id.toUpperCase(),
      'a'.repeat(40), kbId(unregistered), kbId('/etc')]) {
      for (const route of ['/ui/api/composition', '/ui/api/notes', '/ui/map/data', '/ui/map/node?file=x']) {
        const sep = route.includes('?') ? '&' : '?';
        const r = await get(`${route}${sep}kb=${encodeURIComponent(raw)}`);
        assert.strictEqual(r.status, 404,
          `${route} answered ${r.status} for kb=${raw}; a selector that is not a registry key is a 404`);
        assert.ok(['bad_id', 'unknown_kb'].includes(r.body.code), `unexpected code ${r.body.code} for ${raw}`);
        assert.ok(r.body.hint.includes('/ui/api/kbs'), 'a refusal says where real ids come from');
      }
    }
    assert.strictEqual(snapshotTree(unregistered), beforeVictim,
      'the daemon created or opened something inside a directory it was merely asked about');

    // A registered id that is not the launch project resolves, and to the right one.
    const comp = await get(`/ui/api/composition?kb=${other.id}`);
    assert.strictEqual(comp.status, 200);
    assert.strictEqual(comp.body.kb, other.id);

    // No selector at all is the launch project, and says so.
    const health = await get('/ui/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.kb, null);
    assert.strictEqual(health.body.kb_source, 'default');
    assert.strictEqual(health.body.project, launch.root);

    // The picker's payload is global and takes no selector.
    const kbs = await get('/ui/api/kbs');
    assert.strictEqual(kbs.status, 200);
    assert.strictEqual(kbs.body.launch_kb, launch.id);
    assert.ok(kbs.body.kbs.some(k => k.id === other.id));

    // Notes: never created to answer a GET.
    const notes = await get(`/ui/api/notes?kb=${other.id}`);
    assert.strictEqual(notes.status, 404);
    assert.match(notes.body.error, /no memory store/);
    assert.ok(!fs.existsSync(path.join(other.root, '.vnodes', 'memory.db')),
      'a GET brought a memory database into existence');

    // Cross-origin reads are refused the way cross-origin writes already were.
    const evil = await get('/ui/api/composition', { origin: 'https://evil.example' });
    assert.strictEqual(evil.status, 403);
    const crossSite = await get('/ui/api/kbs', { 'sec-fetch-site': 'cross-site' });
    assert.strictEqual(crossSite.status, 403);

    // /status keeps its shape, and every page URL that worked still works.
    const status = await fetch(`${base}/status`).then(r => r.json());
    assert.strictEqual(status.project, launch.root);
    assert.strictEqual(status.daemon, 'running');
    for (const page of ['/ui', '/ui/bases', '/ui/map', '/ui/capsule', '/ui/notes', '/ui/index', '/ui/status']) {
      const r = await fetch(base + page);
      assert.strictEqual(r.status, 200, `${page} stopped answering`);
    }
  } finally {
    handle.close();
    delete process.env.VNODES_PORT;
  }
});

test('a hub daemon owns no project and refuses to guess one', async () => {
  const port = await freePort();
  process.env.VNODES_PORT = String(port);
  const { serve } = require('../src/daemon');
  const handle = serve(null);
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${base}/status`).then(r => r.json());
    assert.strictEqual(status.project, null, 'a hub has no project to be wrong about');
    assert.deepStrictEqual(status.index, { state: 'hub' });

    const r = await fetch(`${base}/ui/api/health`);
    assert.strictEqual(r.status, 400, 'a scoped route with no selector and no launch project is a 400, not a guess');
    assert.strictEqual((await r.json()).code, 'no_default');

    // The picker still works — it is the whole point of the mode.
    const kbs = await fetch(`${base}/ui/api/kbs`).then(x => x.json());
    assert.strictEqual(kbs.hub, true);
    assert.strictEqual(kbs.launch_kb, null);
    assert.strictEqual((await fetch(`${base}/ui/bases`)).status, 200);
  } finally {
    handle.close();
    delete process.env.VNODES_PORT;
  }
});

// ------------------------------------------------- finding what is already there

const { discover, DISCOVER_SKIP } = require('../src/registry');

/** A tree of empty directories, with a fake knowledge base wherever asked. */
function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-discover-'));
  for (const [rel, isKb] of Object.entries(spec)) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    if (isKb) {
      fs.mkdirSync(path.join(dir, '.vnodes'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.vnodes', 'index.db'), '');
    }
  }
  return root;
}

test('discovery finds a knowledge base nobody reindexed', () => {
  const root = tree({ 'code/app': true, 'code/notes': false });
  const report = discover({ roots: [root] });
  assert.strictEqual(report.found.length, 1);
  assert.ok(report.found[0].endsWith('code/app'));
  assert.strictEqual(report.registered.length, 1, 'a base found for the first time is registered');
  assert.strictEqual(discover({ roots: [root] }).registered.length, 0, 'and not registered twice');
});

test('discovery registers without indexing anything', () => {
  const root = tree({ 'code/app': true, 'code/plain': false });
  discover({ roots: [root] });
  assert.ok(!fs.existsSync(path.join(root, 'code/plain', '.vnodes')),
    'a directory that was not a knowledge base must not become one by being looked at');
  // The fake index.db is still the empty file the fixture wrote.
  assert.strictEqual(fs.readFileSync(path.join(root, 'code/app', '.vnodes', 'index.db'), 'utf8'), '');
});

test('discovery does not walk into other people\'s source', () => {
  const root = tree({ 'app': true, 'app/node_modules/dep': true, 'app/vendor/lib': true });
  const report = discover({ roots: [root] });
  assert.strictEqual(report.found.length, 1, 'a dependency with its own index is not this machine\'s knowledge base');
  assert.ok(DISCOVER_SKIP.has('node_modules') && DISCOVER_SKIP.has('vendor'));
});

test('depth bounds the walk, and the bound is a real one', () => {
  const root = tree({ 'a/b/c/d/e/deep': true });
  assert.strictEqual(discover({ roots: [root], depth: 2 }).found.length, 0);
  assert.strictEqual(discover({ roots: [root], depth: 8 }).found.length, 1);
});

test('a scan stopped by its own budget says so', () => {
  const spec = {};
  for (let i = 0; i < 60; i++) spec[`dir${i}/sub`] = false;
  const root = tree(spec);
  const report = discover({ roots: [root], cap: 5 });
  assert.strictEqual(report.truncated, true, 'a scan that gave up must not look like a machine with nothing on it');
  assert.strictEqual(report.stopped_by, 'entries');
});

test('a complete scan reports that it was complete', () => {
  const root = tree({ 'code/app': true });
  const report = discover({ roots: [root] });
  assert.strictEqual(report.truncated, false);
  assert.strictEqual(report.stopped_by, null);
  assert.ok(report.ms >= 0 && report.scanned > 0);
});

test('a symlinked directory is not followed', () => {
  const root = tree({ 'real/app': true, 'links': false });
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'links', 'loop'), 'dir');
  const report = discover({ roots: [root] });
  assert.strictEqual(report.found.length, 1, 'following symlinks turns a scan into an unbounded walk');
});
