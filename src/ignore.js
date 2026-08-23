'use strict';
// Ignore rules: merge .gitignore, .vnodesignore, .vnodes_ignore (gitignore syntax)
// plus built-in default excludes (BR-005).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'target', 'dist', '.next',
  '__pycache__', 'build', 'vendor', 'Pods', 'DerivedData', '.expo', '.vnodes'];

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
function parseIgnoreFile(file, prefix = '') {
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
      return { re, negate, dirOnly };
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
    rules.push(...parseIgnoreFile(path.join(projectRoot, e.name, '.gitignore'), e.name));
  }
  return rules;
}

function buildIgnore(projectRoot) {
  const rules = [
    ...DEFAULT_EXCLUDES.map(d => ({ re: new RegExp(`(^|/)${d.replace('.', '\\.')}(/|$)`), negate: false, dirOnly: false })),
    ...parseIgnoreFile(path.join(projectRoot, '.gitignore')),
    ...nestedIgnoreRules(projectRoot),
    ...parseIgnoreFile(path.join(projectRoot, '.vnodesignore')),
    ...parseIgnoreFile(path.join(projectRoot, '.vnodes_ignore')),
  ];
  return function isIgnored(relPath, isDir) {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !r.re.test(relPath + '/')) continue;
      if (r.re.test(relPath)) ignored = !r.negate;
    }
    return ignored;
  };
}

module.exports = { buildIgnore, DEFAULT_EXCLUDES };
