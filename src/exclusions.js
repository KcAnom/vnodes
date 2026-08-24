'use strict';
/**
 * What is on disk and not in the index, and which rule put it there.
 *
 * The map is forbidden to omit a file silently — it states what it trimmed and
 * what it filtered. The index had no such account, and it is the thing agents
 * actually read: capsules, impact, flow and memory are all built from it. A
 * file missing from the index is missing from every answer any provider's agent
 * gives, with nothing to consult about why.
 *
 * That gap was found the hard way. A screenshot harness wrote a Chrome profile
 * into the tree, 181 of 232 indexed files became browser cache, capsules spent
 * a quarter of their budget on it, and every status check reported healthy.
 *
 * Excluded directories are reported as subtrees and not descended into. Walking
 * node_modules to count what was skipped costs more than the answer is worth,
 * and "node_modules/ — excluded by .gitignore" is the whole answer anyway.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildIgnore } = require('./ignore');
const { langOf } = require('./parser');
const { loadWorkspace } = require('./workspace');

/** Enough of the tree to be useful, bounded so a huge repo cannot hang a status call. */
const MAX_ENTRIES = 20000;

function walk(root, isIgnored, report, budget) {
  let entries;
  try { entries = fs.readdirSync(root.abs, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (budget.spent++ > MAX_ENTRIES) { report.truncated = true; return; }
    // Ignore rules are repo-relative, matching indexer.walk. The alias prefix
    // is only for the reported path, matching indexer file keys (`alias/rel`).
    const rel = root.rel ? `${root.rel}/${entry.name}` : entry.name;
    const reported = root.prefix ? `${root.prefix}/${rel}` : rel;
    const abs = path.join(root.abs, entry.name);
    const isDir = entry.isDirectory();

    if (isIgnored(rel, isDir)) {
      const why = isIgnored.reason(rel, isDir) || { source: 'unknown', pattern: '' };
      // A file with no recognised language was never a candidate, so reporting
      // it as excluded would bury the real answers in noise.
      if (isDir) report.subtrees.push({ path: reported + '/', ...why });
      else if (langOf(rel)) report.files.push({ path: reported, lang: langOf(rel), ...why });
      continue;
    }
    if (isDir) walk({ abs, prefix: root.prefix, rel }, isIgnored, report, budget);
  }
}

/**
 * @returns {{subtrees: object[], files: object[], by_source: object, truncated: boolean}}
 */
function excludedSummary(projectRoot) {
  const workspace = loadWorkspace(projectRoot);
  const roots = workspace?.repos?.length
    ? workspace.repos.map(r => ({
        // Same resolve as indexer.runIndex: relative secondary paths are
        // against workspace.baseDir, never against process.cwd().
        abs: path.resolve(workspace.baseDir, r.path),
        prefix: r.alias || '',
        rel: '',
      }))
    : [{ abs: projectRoot, prefix: '', rel: '' }];

  const report = { subtrees: [], files: [], by_source: {}, truncated: false };
  const budget = { spent: 0 };
  for (const root of roots) {
    if (!fs.existsSync(root.abs)) continue;
    walk(root, buildIgnore(root.abs), report, budget);
  }

  for (const item of [...report.subtrees, ...report.files]) {
    report.by_source[item.source] = (report.by_source[item.source] || 0) + 1;
  }
  return report;
}

module.exports = { excludedSummary };
