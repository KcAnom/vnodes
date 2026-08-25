'use strict';
// Ignore rules: merge .gitignore, .vnodesignore, .vnodes_ignore (gitignore syntax)
// plus built-in default excludes.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'target', 'dist', '.next',
  '__pycache__', 'build', 'vendor', 'Pods', 'DerivedData', '.expo', '.vnodes'];

// These names describe conventional root outputs, but they are also ordinary
// source-package names below a source tree (`internal/build` was the observed
// failure). Excluding every matching basename silently removes real code.
// Root outputs remain cheap by default; nested outputs belong in the project's
// .gitignore/.vnodesignore, which are more authoritative than a name guess.
const ROOT_ONLY_DEFAULT_EXCLUDES = new Set(['target', 'dist', 'build']);

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^$()[]{}|\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return re;
}

// `prefix` scopes a nested ignore file to the directory it was found in, the way
// git does: a pattern written in ui/.gitignore means "under ui/", never "anywhere".
function parseIgnoreFile(file, prefix = '', source = '') {
  if (!fs.existsSync(file)) return [];
  const scope = prefix ? `${globToRegExp(prefix)}/` : '';
  return fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes('/') && !line.startsWith('**');
      const body = globToRegExp(line.replace(/^\//, ''));
      const re = prefix
        ? new RegExp(anchored ? `^${scope}${body}(/|$)` : `^${scope}(.*/)?${body}(/|$)`)
        : new RegExp(anchored ? `^${body}(/|$)` : `(^|/)${body}(/|$)`);
      return { re, negate, dirOnly, source: source || path.basename(file), pattern: line };
    });
}

/**
 * Ignore files one level down.
 *
 * A repo with a client subproject keeps that subproject's build scratch in the
 * subproject's own .gitignore — ui/.gitignore here already lists `.shots/` —
 * and the indexer never read it, because ignore-file names were joined against
 * the project root alone. That is how 181 headless-Chrome cache files became
 * 78% of this index while every status check said healthy.
 *
 * One level, not a walk: it fixes the whole observed failure class (a
 * subproject at the top of the tree) for one readdir, where a full walk pays a
 * stat per directory on every index and every watcher event.
 */
function nestedIgnoreRules(projectRoot) {
  const rules = [];
  let entries;
  try { entries = fs.readdirSync(projectRoot, { withFileTypes: true }); } catch { return rules; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || DEFAULT_EXCLUDES.includes(e.name)) continue;
    rules.push(...parseIgnoreFile(path.join(projectRoot, e.name, '.gitignore'), e.name, `${e.name}/.gitignore`));
  }
  return rules;
}

function buildIgnore(projectRoot) {
  const rules = [
    ...DEFAULT_EXCLUDES.map(d => ({
      re: new RegExp(ROOT_ONLY_DEFAULT_EXCLUDES.has(d)
        ? `^${globToRegExp(d)}(/|$)`
        : `(^|/)${globToRegExp(d)}(/|$)`),
      negate: false, dirOnly: false, source: 'built-in', pattern: d,
    })),
    ...parseIgnoreFile(path.join(projectRoot, '.gitignore')),
    ...nestedIgnoreRules(projectRoot),
    ...parseIgnoreFile(path.join(projectRoot, '.vnodesignore')),
    ...parseIgnoreFile(path.join(projectRoot, '.vnodes_ignore')),
  ];
  /**
   * Why a path was excluded, or null if it was not.
   *
   * Carried alongside the predicate rather than recomputed elsewhere, so the
   * answer to "why is this file not in my knowledge base" comes from the same
   * rules that excluded it. The index is what agents read; an exclusion nobody
   * can see is the same silent omission the map is forbidden to make.
   */
  isIgnored.reason = function reason(relPath, isDir) {
    let hit = null;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !r.re.test(relPath + '/')) continue;
      if (r.re.test(relPath)) hit = r.negate ? null : r;
    }
    return hit ? { source: hit.source, pattern: hit.pattern } : null;
  };

  return isIgnored;

  function isIgnored(relPath, isDir) {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !r.re.test(relPath + '/')) continue;
      if (r.re.test(relPath)) ignored = !r.negate;
    }
    return ignored;
  }
}

module.exports = { buildIgnore, DEFAULT_EXCLUDES };
