'use strict';
/**
 * Whether this process is still running the code that is on disk.
 *
 * Node reads a module once. A stdio MCP server or an HTTP daemon started at
 * 10:20 is still executing 10:20's source at midnight, however many times the
 * repo has been edited and committed in between — and nothing anywhere said so.
 *
 * That is not hypothetical. On 2026-08-23 the MCP server wired into this repo's
 * .mcp.json ran for over thirteen hours across eight commits that changed the
 * capsule budget, the memory relevance surface and the tool catalog itself. Its
 * answers looked entirely normal. Worse than a crash, because a crash is
 * visible: a stale server keeps answering, and it answers with logic the caller
 * has every reason to believe was replaced.
 *
 * Note what is NOT stale in that situation. index.db and memory.db are opened
 * per call, so graph and memory DATA stays current; it is the logic around it
 * that freezes. That split is why the failure is so quiet — half the answer
 * keeps moving.
 *
 * The check is one stat per source file, measured at 78 microseconds for the
 * nineteen this package loads, so it runs on every call rather than on a timer.
 * A timer would be the same class of mistake: a cached answer about whether the
 * cache is fresh.
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname);

/** Every .js file under src/, one level of nesting deep, which is all this package has. */
function sourceFiles(dir = SRC, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Source files modified since this process started.
 *
 * Compared against process start, not against a snapshot of what was loaded:
 * a file this process has not required yet is just as dangerous, because
 * requiring it later mixes new code into an old process.
 */
function changedSince(startedMs) {
  const changed = [];
  for (const f of sourceFiles()) {
    try {
      if (fs.statSync(f).mtimeMs > startedMs) changed.push(path.relative(path.join(SRC, '..'), f));
    } catch { /* deleted mid-run is its own kind of changed, but not one to crash on */ }
  }
  return changed;
}

/**
 * The line a long-lived process attaches to its answers once it is out of date.
 *
 * Names the files rather than saying "restart me": which files changed is what
 * tells a reader whether the staleness touches what they just asked about.
 */
function stalenessNotice(startedMs, { limit = 5 } = {}) {
  const changed = changedSince(startedMs);
  if (!changed.length) return null;
  const shown = changed.slice(0, limit).join(', ');
  const more = changed.length > limit ? `, and ${changed.length - limit} more` : '';
  return `this vnodes server started ${new Date(startedMs).toLocaleString()} and ${changed.length} source file(s) have changed on disk since: ${shown}${more}. Node loads a module once, so these answers come from the code as it was at startup. Restart the server before trusting them.`;
}

module.exports = { sourceFiles, changedSince, stalenessNotice };
