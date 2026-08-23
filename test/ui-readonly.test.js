'use strict';
/**
 * "The UI is read-only" as a checkable fact.
 *
 * It was a property of one commit, shipped inside a 427 KB minified bundle
 * nobody diffs, guarded by nothing but the intention of whoever wrote the
 * client. The three assertions here are the guard: the shipped client contains
 * no reference to a write tool, the server refuses to run one on the read-only
 * path, and the page list the server dispatches on is the same page list the
 * client routes on — the one agreement that spans the JS/TS boundary with no
 * compiler in between.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WRITE_TOOLS = ['save_observation', 'workspace_setup'];

function walk(dir, keep, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/**
 * Source with its comments removed.
 *
 * The check below is on what the code does, not on what it says about itself: a
 * comment explaining that this file never calls save_observation is the correct
 * comment to write, and failing the build over it would push authors into not
 * explaining the rule. Block comments and whole-line comments go; anything
 * still holding the name after that is holding it as code.
 */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}

test('nothing shipped to the browser names a write tool', () => {
  // Bare occurrences, not just imports: a string literal handed to a generic
  // rpc helper is exactly the shape this is meant to catch, and it does not
  // look like an import.
  const sources = [
    ...walk(path.join(ROOT, 'ui', 'src'), () => true),
    // The bundle is checked verbatim. Its comments are already gone, and it is
    // the artifact that actually runs in the reader's browser.
    ...walk(path.join(ROOT, 'src', 'view', 'static'), p => p.endsWith('.js')),
  ];
  assert.ok(sources.length > 0, 'found no UI sources to check — the check itself is broken');
  for (const file of sources) {
    const inBundle = file.includes(path.join('view', 'static'));
    const text = fs.readFileSync(file, 'utf8');
    const code = inBundle ? text : withoutComments(text);
    for (const tool of WRITE_TOOLS) {
      assert.ok(!code.includes(tool),
        `${path.relative(ROOT, file)} names the write tool ${tool}; the UI surface is read-only`);
    }
  }
});

test('the read-only dispatch refuses the write tools and records nothing', () => {
  const { callToolReadOnly, READ_ONLY_TOOLS } = require('../src/tools');
  const { engineDir } = require('../src/config');
  const { openMemory } = require('../src/store');

  for (const tool of WRITE_TOOLS) {
    assert.ok(!READ_ONLY_TOOLS.has(tool), `${tool} must not be in READ_ONLY_TOOLS`);
    assert.throws(() => callToolReadOnly(ROOT, tool, { summary: 'x', repos: [] }),
      /not read-only/, `${tool} must be refused before it reaches its case`);
  }

  // A real read through the read-only path must leave the memory feed alone:
  // agents read that feed, and a browser panel polling it would own the
  // relevance window with rows describing its own polling.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-readonly-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'export function a() { return 1; }\n');
  const engDir = engineDir(root);
  const count = () => {
    const db = openMemory(engDir);
    const n = Number(db.prepare('SELECT COUNT(*) c FROM observations').get().c);
    db.close();
    return n;
  };
  const before = count();
  callToolReadOnly(root, 'index_status', {});
  callToolReadOnly(root, 'get_session_context', { limit: 5 });
  assert.strictEqual(count(), before, 'a read through callToolReadOnly wrote an observation');
});

test('server pages and client routes are the same set', () => {
  const { PAGES } = require('../src/view/shell');
  const routesFile = path.join(ROOT, 'ui', 'src', 'shell', 'routes.ts');
  if (!fs.existsSync(routesFile)) {
    // The client half is built in ui/ and is allowed to land after this file.
    // Skipping loudly beats asserting against a file that does not exist yet —
    // but the skip has to be visible, or the check quietly never runs again.
    console.error('SKIP: ui/src/shell/routes.ts not present; route agreement unchecked');
    return;
  }
  const text = fs.readFileSync(routesFile, 'utf8');
  const client = [...new Set([...text.matchAll(/["'`](\/ui(?:\/[a-z]+)?)["'`]/g)].map(m => m[1]))];

  // /ui/status is served, but it is plain HTML from the daemon rather than a
  // React page — the client is allowed to name it (it links there, and it is
  // the fallback when the bundle is broken) and must not try to route it.
  const served = [...PAGES.keys(), '/ui/status'];
  for (const p of client) {
    assert.ok(served.includes(p), `client names ${p}, which the daemon answers with a 404`);
  }
  for (const p of PAGES.keys()) {
    assert.ok(client.includes(p), `the daemon serves ${p} but no client route draws it`);
  }
});
