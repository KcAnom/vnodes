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

function parseIgnoreFile(file) {
  if (!fs.existsSync(file)) return [];
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
      const re = new RegExp(anchored ? `^${body}(/|$)` : `(^|/)${body}(/|$)`);
      return { re, negate, dirOnly };
    });
}

function buildIgnore(projectRoot) {
  const rules = [
    ...DEFAULT_EXCLUDES.map(d => ({ re: new RegExp(`(^|/)${d.replace('.', '\\.')}(/|$)`), negate: false, dirOnly: false })),
    ...parseIgnoreFile(path.join(projectRoot, '.gitignore')),
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
