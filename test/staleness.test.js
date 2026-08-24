'use strict';
require('./_registry_home'); // isolates the knowledge-base registry from the developer's real ~/.config
/**
 * Pins the check that a long-lived server is running the code on disk.
 *
 * Node reads a module once. The MCP server wired into this repo's own .mcp.json
 * ran for over thirteen hours across eight commits — commits that changed the
 * capsule budget, the memory relevance surface and the tool catalog itself —
 * and answered every call with the source as it stood at startup. Nothing said
 * so. It was found by comparing a process start time to a commit time by hand,
 * hours after it had started mattering.
 *
 * What makes it quiet is that only half the answer freezes: index.db and
 * memory.db are opened per call, so the DATA stays current while the logic
 * around it does not.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles, changedSince, stalenessNotice } = require('../src/staleness');

test('a process younger than every source file is not stale', () => {
  assert.deepEqual(changedSince(Date.now() + 1000), []);
  assert.equal(stalenessNotice(Date.now() + 1000), null);
});

test('a process older than an edit is stale, and names the file', () => {
  const changed = changedSince(0); // as if started at the epoch
  assert.ok(changed.length > 0, 'nothing looked changed against a start time of zero');
  const notice = stalenessNotice(0);
  assert.match(notice, /source file\(s\) have changed/);
  assert.match(notice, /Restart the server/);
});

test('it watches files this process has not loaded, not just the ones it has', () => {
  // A file required later mixes new code into an old process, so the check
  // cannot be limited to require.cache.
  const files = sourceFiles().map(f => path.basename(f));
  assert.ok(files.includes('capsule.js') && files.includes('registry.js'));
  assert.ok(files.includes('lifecycle.js'), 'nested source under src/daemon/ is not being watched');
});

test('an edit after start is detected', () => {
  const started = Date.now();
  const victim = path.join(__dirname, '..', 'src', 'logs.js');
  const was = fs.statSync(victim);
  try {
    fs.utimesSync(victim, new Date(), new Date(started + 5000));
    assert.ok(changedSince(started).some(f => f.endsWith('logs.js')), 'an edit after start went unseen');
  } finally {
    fs.utimesSync(victim, was.atime, was.mtime);
  }
});

test('the notice names files rather than only telling you to restart', () => {
  // Which files changed is what tells a reader whether the staleness touches
  // what they just asked about.
  assert.match(stalenessNotice(0), /src\//);
});
