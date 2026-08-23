'use strict';
/**
 * A throwaway registry root for one test process.
 *
 * Indexing now registers the project it indexed, which is correct and is also
 * the one side effect in this codebase that reaches outside the tree under
 * test: without this, `npm test` would write a row into the developer's real
 * ~/.config/vnodes/registry for every mkdtemp fixture the suite builds, and the
 * knowledge-base picker would fill up with a dozen temp directories that no
 * longer exist. Required first thing by every test file that indexes anything.
 *
 * `VNODES_HOME` is respected when it is already set, so a caller can point a
 * whole run somewhere of its own choosing.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.VNODES_HOME) {
  process.env.VNODES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vnodes-test-home-'));
}

module.exports = { home: process.env.VNODES_HOME, registryDir: path.join(process.env.VNODES_HOME, 'registry') };
