'use strict';
// M1 Indexing Engine. Parse-only (BR-006). Incremental: manifest.json holds
// per-file content hashes and is committed so clones rebuild incrementally
// (BR-003). Files above cfg.index.max_file_size_kb are skipped (BR-007).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildIgnore } = require('./ignore');
const { isSecretFile } = require('./secrets');
const { parseFile, langOf } = require('./parser');
const { openStore, openStoreReadOnly } = require('./store');
const { engineDir } = require('./config');
const { loadWorkspace } = require('./workspace');

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function walk(root, isIgnored, out = [], rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!isIgnored(r, true)) walk(root, isIgnored, out, r);
    } else if (e.isFile()) {
      if (!isIgnored(r, false)) out.push(r);
    }
  }
  return out;
}

const CAND_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb',
  '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/__init__.py'];

function tryCandidates(base, fileSet) {
  for (const s of CAND_SUFFIXES) if (fileSet.has(base + s)) return base + s;
  return null;
}

// Path aliases from tsconfig/jsconfig (compilerOptions.baseUrl + paths), e.g.
// "@/*": ["./*"]. Without these, alias imports look like bare package
// specifiers and every intra-project edge through them is lost.
function loadAliases(repoRoot) {
  const out = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = path.join(repoRoot, name);
    if (!fs.existsSync(p)) continue;
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let j = null;
    try { j = JSON.parse(raw); } catch {
      // tsconfig permits comments and trailing commas; JSON.parse does not.
      try {
        j = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/,(\s*[}\]])/g, '$1'));
      } catch { continue; }
    }
    const co = (j && j.compilerOptions) || {};
    const baseUrl = co.baseUrl || '.';
    for (const [pat, targets] of Object.entries(co.paths || {})) {
      if (!Array.isArray(targets)) continue;
      for (const t of targets) {
        let target = path.posix.normalize(path.posix.join(baseUrl, String(t).replace(/\*$/, '')));
        if (target === '.' || target === './') target = '';
        out.push({ prefix: pat.replace(/\*$/, ''), wildcard: pat.endsWith('*'), target });
      }
    }
  }
  return out;
}

// Python stdlib top-level module names (3.12 sys.stdlib_module_names, public
// set). Bare imports of these resolve to the stdlib in a real interpreter, so
// ancestor-root probing must not claim them for a local file of the same name.
const PY_STDLIB = new Set([
  '__future__', '_thread', 'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio',
  'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2',
  'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs',
  'codeop', 'collections', 'colorsys', 'compileall', 'concurrent',
  'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile',
  'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm',
  'decimal', 'difflib', 'dis', 'doctest', 'email', 'encodings', 'ensurepip',
  'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch',
  'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext',
  'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'idlelib', 'imaplib', 'imghdr', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math',
  'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt', 'multiprocessing',
  'netrc', 'nis', 'nntplib', 'ntpath', 'nturl2path', 'numbers', 'opcode',
  'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle',
  'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib',
  'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're',
  'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched',
  'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal',
  'site', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3',
  'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess',
  'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile',
  'telnetlib', 'tempfile', 'termios', 'test', 'textwrap', 'threading', 'time',
  'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback',
  'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings',
  'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib',
  'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

// Python dots are package separators, not filesystem path segments. A leading
// dot means "this package", each extra dot one level up — so `.util` is never
// the dotfile `./.util`. Bare dotted names are absolute package paths, and the
// package root is often nested (tools/LatentSync/latentsync/...), so try each
// ancestor directory as a root.
function resolvePythonImport(fromFile, spec, fileSet) {
  const m = spec.match(/^(\.*)([\s\S]*)$/);
  const dots = m[1].length;
  const rest = m[2].split('.').filter(Boolean).join('/');
  const fromDir = path.posix.dirname(fromFile);
  if (dots > 0) {
    let dir = fromDir;
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    return tryCandidates(rest ? path.posix.join(dir, rest) : dir, fileSet);
  }
  if (!rest) return null;
  // A stdlib name resolves to the stdlib unless a same-directory sibling
  // shadows it (script dir leads sys.path); never claim it via ancestor roots.
  if (PY_STDLIB.has(rest.split('/')[0])) {
    return tryCandidates(fromDir === '.' ? rest : path.posix.join(fromDir, rest), fileSet);
  }
  let dir = fromDir;
  for (;;) {
    const hit = tryCandidates(dir === '.' ? rest : path.posix.join(dir, rest), fileSet);
    if (hit) return hit;
    if (dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

// Rust paths are module paths, not filesystem paths. `crate::` roots at the
// nearest lib.rs/main.rs ancestor, `super::` walks up module dirs, `self::`
// stays put, and a bare head is either a `mod` sibling or a 2015-edition
// crate-root module — external crates (std, serde, …) simply never resolve.
// Trailing segments may be items rather than modules, so probe prefixes
// longest-first against both `<path>.rs` and `<path>/mod.rs`.
function crateRootDir(fromFile, fileSet) {
  let dir = path.posix.dirname(fromFile);
  for (;;) {
    const at = p => fileSet.has(dir === '.' ? p : `${dir}/${p}`);
    if (at('lib.rs') || at('main.rs')) return dir;
    if (dir === '.' || dir === '') return path.posix.dirname(fromFile);
    dir = path.posix.dirname(dir);
  }
}

function resolveRustImport(fromFile, spec, fileSet) {
  const segs = spec.split('::').filter(Boolean);
  if (!segs.length) return null;
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.basename(fromFile, '.rs');
  // Child modules of a/b.rs live in a/b/; mod.rs, lib.rs and main.rs own their dir.
  const selfDir = ['mod', 'lib', 'main'].includes(base) ? fromDir : path.posix.join(fromDir, base);
  const probe = (rootDir, rest) => {
    for (let n = rest.length; n >= 1; n--) {
      const rel = rest.slice(0, n).join('/');
      const cand = rootDir === '.' || rootDir === '' ? rel : `${rootDir}/${rel}`;
      if (fileSet.has(`${cand}.rs`)) return `${cand}.rs`;
      if (fileSet.has(`${cand}/mod.rs`)) return `${cand}/mod.rs`;
    }
    return null;
  };
  const head = segs[0];
  if (head === 'crate') return probe(crateRootDir(fromFile, fileSet), segs.slice(1));
  if (head === 'self') return probe(selfDir, segs.slice(1));
  if (head === 'super') {
    let dir = path.posix.dirname(selfDir);
    let rest = segs.slice(1);
    while (rest[0] === 'super') { dir = path.posix.dirname(dir); rest = rest.slice(1); }
    return probe(dir, rest);
  }
  return probe(selfDir, segs) || probe(crateRootDir(fromFile, fileSet), segs);
}

// Go imports name package directories via the go.mod module path, not files.
// Strip the module prefix, then map the package dir to a representative .go
// file already in the index. External packages have a foreign prefix → null.
function loadGoModule(repoRoot) {
  try {
    const m = fs.readFileSync(path.join(repoRoot, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

function goPackageDirs(fileSet) {
  const rep = new Map(); // package dir → representative non-test .go file
  for (const f of fileSet) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    const d = path.posix.dirname(f);
    // Prefer <dir>/<dirname>.go (the conventional package anchor), else the
    // lexicographically first file — Go imports name directories, not files.
    const anchor = d === '.' ? null : `${d}/${path.posix.basename(d)}.go`;
    const cur = rep.get(d);
    if (f === anchor || !cur || (cur !== anchor && f < cur)) rep.set(d, f);
  }
  return rep;
}

function resolveGoImport(spec, goModule, goDirs) {
  if (!goModule) return null;
  if (spec === goModule) return goDirs.get('.') || null;
  if (!spec.startsWith(goModule + '/')) return null;
  return goDirs.get(spec.slice(goModule.length + 1)) || null;
}

// PHP: PSR-4 prefixes from composer.json map namespaces to directories; when a
// project autoloads its own way (legacy underscore classes, custom loaders),
// fall back to the class name → defining-file map built from the symbol table.
// Ambiguous class names resolve to nothing — no fabricated edges.
function loadComposerPsr4(repoRoot) {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repoRoot, 'composer.json'), 'utf8'));
    for (const src of [j.autoload?.['psr-4'], j['autoload-dev']?.['psr-4']]) {
      for (const [prefix, dir] of Object.entries(src || {})) {
        for (const d of Array.isArray(dir) ? dir : [dir])
          out.push({ prefix, dir: String(d).replace(/\/+$/, '') });
      }
    }
  } catch {}
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

function resolvePhpImport(fromFile, spec, fileSet, psr4, classes) {
  if (spec.includes('/') || spec.endsWith('.php')) { // path-style require/include literal
    const sibling = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    if (fileSet.has(sibling)) return sibling;
    const norm = path.posix.normalize(spec.replace(/^\/+/, ''));
    return fileSet.has(norm) ? norm : null;
  }
  const segs = spec.split('\\').filter(Boolean);
  if (!segs.length) return null;
  for (const { prefix, dir } of psr4) {
    if ((spec + '\\').startsWith(prefix)) {
      const rest = spec.slice(prefix.length).split('\\').filter(Boolean);
      const cand = path.posix.normalize(path.posix.join(dir, rest.join('/')) + '.php');
      if (fileSet.has(cand)) return cand;
    }
  }
  const hits = classes.get(segs[segs.length - 1]);
  return hits && hits.length === 1 ? hits[0] : null;
}

// Swift: `import X` names a SwiftPM target, conventionally rooted at
// Sources/<X>/ (or Tests/<X>/). Anchor the edge on <X>.swift in that root when
// present, else the lexicographically first file — same shape as Go packages.
function swiftModuleMap(fileSet) {
  const map = new Map();
  for (const f of fileSet) {
    if (!f.endsWith('.swift')) continue;
    const m = f.match(/(?:^|\/)(?:Sources|Tests)\/([^/]+)\//);
    if (!m) continue;
    const mod = m[1];
    const rootEnd = f.indexOf(`/${mod}/`, m.index) + mod.length + 1;
    const anchor = `${f.slice(0, rootEnd)}/${mod}.swift`;
    const cur = map.get(mod);
    if (f === anchor || !cur || (cur !== anchor && f < cur)) map.set(mod, f);
  }
  return map;
}

// Java/Kotlin: import paths mirror directory tails under some source root
// (src/main/java/, decompiled trees, anything) — suffix-match the dotted path
// against files sharing the type's basename; unique-basename fallback for
// nonstandard layouts; one segment dropped retries inner classes. A trailing
// dot marks a wildcard package import, anchored like a Go package.
function jvmMaps(fileSet) {
  const types = new Map(), dirs = new Map();
  for (const f of fileSet) {
    if (!f.endsWith('.java') && !f.endsWith('.kt')) continue;
    const base = path.posix.basename(f).replace(/\.(java|kt)$/, '');
    if (!types.has(base)) types.set(base, []);
    types.get(base).push(f);
    const d = path.posix.dirname(f);
    if (!dirs.has(d) || f < dirs.get(d)) dirs.set(d, f);
  }
  return { types, dirs };
}

function resolveJvmImport(spec, { types, dirs }) {
  const segs = spec.split('.').filter(Boolean);
  if (!segs.length) return null;
  if (spec.endsWith('.')) { // wildcard: unique package dir with this tail
    const tail = segs.join('/');
    let hit = null;
    for (const [d, rep] of dirs) {
      if (d === tail || d.endsWith(`/${tail}`)) { if (hit) return null; hit = rep; }
    }
    return hit;
  }
  const attempt = ss => {
    const cand = types.get(ss[ss.length - 1]) || [];
    const tail = `/${ss.join('/')}.`;
    const exact = cand.filter(f => `/${f}`.endsWith(`${tail}java`) || `/${f}`.endsWith(`${tail}kt`));
    if (exact.length === 1) return exact[0];
    if (!exact.length && cand.length === 1) return cand[0];
    return null;
  };
  return attempt(segs) || (segs.length > 1 ? attempt(segs.slice(0, -1)) : null);
}

// C#: `using X.Y` names a namespace; the declaring files are found via the
// parser's namespace nodes. Edge anchors on <LastSegment>.cs in the namespace
// when present, else its first file. `using static Type` and nested references
// fall back to the unique-type map.
function resolveCsImport(spec, nsAnchors, types) {
  const direct = nsAnchors.get(spec);
  if (direct) return direct;
  const hits = types.get(spec.split('.').pop());
  return hits && hits.length === 1 ? hits[0] : null;
}

// Lua: require("a.b") is dots-to-path against package.path — unknowable per
// project, so probe importing-file-relative then repo-root (plus init.lua),
// then fall back to a unique module basename. Externals (socket.http) miss all
// three and stay unresolved.
function resolveLuaImport(fromFile, spec, fileSet, luaFiles) {
  const rel = spec.replace(/\./g, '/');
  for (const base of [path.posix.join(path.posix.dirname(fromFile), rel), rel]) {
    const norm = path.posix.normalize(base);
    if (fileSet.has(`${norm}.lua`)) return `${norm}.lua`;
    if (fileSet.has(`${norm}/init.lua`)) return `${norm}/init.lua`;
  }
  const hits = luaFiles.get(spec.split('.').pop());
  return hits && hits.length === 1 ? hits[0] : null;
}

// Dart addresses its own code by package name, not path: `package:foo/a.dart`
// means <dir-of-the-pubspec-naming-foo>/lib/a.dart. In a monorepo those
// pubspecs are scattered, so every one in the tree is read. Packages absent
// from the map are third-party (pub cache, outside the index) → null.
function dartPackageRoots(repoRoot, fileSet) {
  const roots = new Map(); // package name → dir holding its pubspec ('' at root)
  for (const f of fileSet) {
    if (path.posix.basename(f) !== 'pubspec.yaml') continue;
    try {
      const m = fs.readFileSync(path.join(repoRoot, f), 'utf8').match(/^name:\s*['"]?([\w.]+)['"]?/m);
      if (!m) continue;
      const dir = path.posix.dirname(f);
      const next = dir === '.' ? '' : dir;
      const cur = roots.get(m[1]);
      // A vendored copy can duplicate a name; the shallowest pubspec wins so
      // the choice does not depend on walk order. The root pubspec's dir is '',
      // and ''.split('/').length is 1 — the same as a top-level 'app' — so depth
      // has to be computed, not taken from the segment count, or root-vs-
      // top-level ties fall back to walk order and break that guarantee.
      const depth = d => (d === '' ? 0 : d.split('/').length);
      if (cur === undefined || depth(next) < depth(cur)) roots.set(m[1], next);
    } catch {}
  }
  return roots;
}

function resolveDartImport(fromFile, spec, fileSet, roots) {
  if (spec.startsWith('dart:')) return null; // SDK, never a file in the tree
  if (spec.startsWith('package:')) {
    const rest = spec.slice(8);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const dir = roots.get(rest.slice(0, slash));
    if (dir === undefined) return null;
    const p = path.posix.normalize(path.posix.join(dir, 'lib', rest.slice(slash + 1)));
    return fileSet.has(p) ? p : null;
  }
  // Everything else is relative — Dart allows a bare sibling with no './'.
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return fileSet.has(p) ? p : null;
}

// Resolve an import specifier to a file in the indexed set. Bare package
// specifiers stay unresolved — external deps are not graph nodes.
function resolveImport(fromFile, spec, fileSet, ctx = {}) {
  if (fromFile.endsWith('.dart')) return resolveDartImport(fromFile, spec, fileSet, ctx.dartRoots || new Map());
  if (fromFile.endsWith('.py')) return resolvePythonImport(fromFile, spec, fileSet);
  if (fromFile.endsWith('.rs')) return resolveRustImport(fromFile, spec, fileSet);
  if (fromFile.endsWith('.go')) return resolveGoImport(spec, ctx.goModule, ctx.goDirs || new Map());
  if (fromFile.endsWith('.php')) return resolvePhpImport(fromFile, spec, fileSet, ctx.phpPsr4 || [], ctx.phpClasses || new Map());
  if (fromFile.endsWith('.swift')) return (ctx.swiftModules || new Map()).get(spec.split('.')[0]) || null;
  if (fromFile.endsWith('.java') || fromFile.endsWith('.kt')) return ctx.jvm ? resolveJvmImport(spec, ctx.jvm) : null;
  if (fromFile.endsWith('.cs')) return resolveCsImport(spec, ctx.csNamespaces || new Map(), ctx.csTypes || new Map());
  if (fromFile.endsWith('.lua')) return resolveLuaImport(fromFile, spec, fileSet, ctx.luaFiles || new Map());
  if (fromFile.endsWith('.sh') || fromFile.endsWith('.bash') || fromFile.endsWith('.zsh')) {
    // source paths resolve relative to the script's directory, then repo root;
    // ~/ and absolute paths are outside the tree and stay unresolved.
    if (spec.startsWith('~') || spec.startsWith('/')) return null;
    const sib = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    if (fileSet.has(sib)) return sib;
    const norm = path.posix.normalize(spec);
    return fileSet.has(norm) ? norm : null;
  }
  if (spec.startsWith('.')) {
    return tryCandidates(
      path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)), fileSet);
  }
  for (const a of ctx.aliases || []) {
    if (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix) {
      const tail = a.wildcard ? spec.slice(a.prefix.length) : '';
      let base = path.posix.normalize(a.target ? path.posix.join(a.target, tail) : tail);
      if (base.startsWith('./')) base = base.slice(2);
      const hit = tryCandidates(base, fileSet);
      if (hit) return hit;
    }
  }
  return null;
}

// Index one repo tree into the store under a repo alias ('' for single-repo).
function indexRepo(db, repoRoot, alias, cfg, log) {
  const isIgnored = buildIgnore(repoRoot);
  const filterSecrets = cfg.filter_secrets !== false;
  const maxBytes = cfg.index.max_file_size_kb * 1024;
  const files = walk(repoRoot, isIgnored);
  const fileSet = new Set(files);
  const aliases = loadAliases(repoRoot);

  const prev = new Map(
    db.prepare('SELECT path, hash FROM files WHERE repo = ?').all(alias).map(r => [r.path, r.hash]));
  const manifest = {};
  let added = 0, updated = 0, skippedSecret = 0, skippedSize = 0, unchanged = 0;

  const insFile = db.prepare('INSERT OR REPLACE INTO files (path, repo, hash, size, lang, indexed_at) VALUES (?,?,?,?,?,?)');
  const delNodes = db.prepare('DELETE FROM nodes WHERE file = ? AND repo = ?');
  const insNode = db.prepare('INSERT INTO nodes (file, repo, name, kind, line, signature) VALUES (?,?,?,?,?,?)');
  const delEdges = db.prepare('DELETE FROM edges WHERE src_file = ?');
  const insEdge = db.prepare('INSERT OR REPLACE INTO edges (src_file, dst_file, kind) VALUES (?,?,?)');
  const delImports = db.prepare('DELETE FROM imports WHERE file = ?');
  const insImport = db.prepare('INSERT INTO imports (file, repo, spec) VALUES (?,?,?)');

  for (const rel of files) {
    if (filterSecrets && isSecretFile(rel)) { skippedSecret++; continue; }
    if (!langOf(rel)) continue;
    const abs = path.join(repoRoot, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > maxBytes) { skippedSize++; continue; }
    const buf = fs.readFileSync(abs);
    const hash = sha1(buf);
    const key = alias ? `${alias}/${rel}` : rel;
    manifest[key] = hash;
    if (prev.get(key) === hash) { unchanged++; prev.delete(key); continue; }
    const parsed = parseFile(rel, buf.toString('utf8'));
    if (!parsed) continue;
    prev.has(key) ? updated++ : added++;
    prev.delete(key);
    insFile.run(key, alias, hash, stat.size, parsed.lang, Date.now());
    delNodes.run(key, alias);
    for (const n of parsed.nodes) insNode.run(key, alias, n.name, n.kind, n.line, n.signature || '');
    // Store the specifiers, not the edges. Parse output depends only on this
    // file's bytes and so is safe to cache on its hash; resolution is not.
    delImports.run(key);
    for (const spec of parsed.imports) insImport.run(key, alias, spec);
  }
  // Removed files: anything previously indexed but no longer on disk. Inbound
  // edges must go too, or impact/flow keep pointing at ghost files.
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');
  const delInEdges = db.prepare('DELETE FROM edges WHERE dst_file = ?');
  let removed = 0;
  for (const [gone] of prev) {
    delFile.run(gone);
    delNodes.run(gone, alias);
    delEdges.run(gone);
    delInEdges.run(gone);
    delImports.run(gone);
    removed++;
  }
  // Second pass: edges, once the full file set is known. Language-specific
  // context (Go module map, PHP autoload data, Swift target map) is built once
  // per repo, and only when the repo actually contains that language.
  const prefix = alias ? `${alias}/` : '';
  const has = ext => { for (const f of fileSet) if (f.endsWith(ext)) return true; return false; };
  const ctx = { aliases };
  if (has('.go')) { ctx.goModule = loadGoModule(repoRoot); ctx.goDirs = goPackageDirs(fileSet); }
  if (has('.swift')) ctx.swiftModules = swiftModuleMap(fileSet);
  if (has('.dart')) ctx.dartRoots = dartPackageRoots(repoRoot, fileSet);
  // Name→files maps from the symbol table: unchanged files keep their node
  // rows, so the DB is the complete view even on incremental runs.
  const dbNameMap = (kind, likeExt) => {
    const m = new Map();
    for (const r of db.prepare(`SELECT name, file FROM nodes WHERE repo = ? AND kind = ? AND file LIKE ?`).all(alias, kind, `%${likeExt}`)) {
      const rel = alias ? r.file.slice(alias.length + 1) : r.file;
      if (!m.has(r.name)) m.set(r.name, []);
      m.get(r.name).push(rel);
    }
    return m;
  };
  if (has('.php')) {
    ctx.phpPsr4 = loadComposerPsr4(repoRoot);
    ctx.phpClasses = dbNameMap('class', '.php');
  }
  if (has('.java') || has('.kt')) ctx.jvm = jvmMaps(fileSet);
  if (has('.lua')) {
    ctx.luaFiles = new Map();
    for (const f of fileSet) {
      if (!f.endsWith('.lua')) continue;
      const base = path.posix.basename(f, '.lua');
      if (!ctx.luaFiles.has(base)) ctx.luaFiles.set(base, []);
      ctx.luaFiles.get(base).push(f);
    }
  }
  if (has('.cs')) {
    ctx.csTypes = dbNameMap('class', '.cs');
    ctx.csNamespaces = new Map();
    for (const [ns, files] of dbNameMap('module', '.cs')) {
      const anchor = files.find(f => path.posix.basename(f) === `${ns.split('.').pop()}.cs`);
      ctx.csNamespaces.set(ns, anchor || files.sort()[0]);
    }
  }
  // Re-resolve every file, not just the ones that changed. An unchanged file's
  // specifiers are still the same, but what they resolve to is not: a target
  // that appears, moves or is deleted changes the answer for every importer,
  // and those importers may not be touched again for months. Resolution is
  // pure and cheap — map and set lookups over specs already in the DB — so
  // redoing all of it each run is what makes incremental equal a cold rebuild.
  db.prepare('DELETE FROM edges WHERE src_file IN (SELECT path FROM files WHERE repo = ?)').run(alias);
  for (const { file, spec } of db.prepare('SELECT file, spec FROM imports WHERE repo = ?').all(alias)) {
    const rel = alias ? file.slice(alias.length + 1) : file;
    const dstRel = resolveImport(rel, spec, fileSet, ctx);
    // Ancestor-root probing can land back on the importing file itself
    // (e.g. `import util` inside util.py); a self-edge is not a dependency.
    if (dstRel && dstRel !== rel) insEdge.run(file, prefix + dstRel, 'import');
  }
  log?.(`repo=${alias || '(root)'} files=${files.length} +${added} ~${updated} -${removed} =${unchanged} secret-skip=${skippedSecret} size-skip=${skippedSize}`);
  return { manifest, added, updated, removed, unchanged, skippedSecret, skippedSize, total: files.length };
}

// Bumped whenever stored parse output stops being reusable — a new table the
// incremental path reads from, or a parser change that alters what unchanged
// files should yield. Both are invisible to the per-file content hash.
const SCHEMA_VERSION = '2';

function runIndex(projectRoot, cfg, log) {
  const t0 = Date.now();
  const engDir = engineDir(projectRoot);
  const db = openStore(engDir);
  // An index written before `imports` existed holds no specifiers for its
  // unchanged files, so re-resolving would drop their edges. Clear the derived
  // tables once and let the next pass rebuild them from source.
  if (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value !== SCHEMA_VERSION) {
    db.exec('DELETE FROM files; DELETE FROM nodes; DELETE FROM edges; DELETE FROM imports;');
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }
  const firstRun = db.prepare('SELECT COUNT(*) c FROM files').get().c === 0;
  const ws = loadWorkspace(projectRoot);
  let manifest = {};
  const stats = [];
  if (ws) {
    // Multi-repo workspace: index every member as one workspace (BR-019).
    for (const { alias, path: repoPath } of ws.repos) {
      const abs = path.resolve(ws.baseDir, repoPath);
      if (!fs.existsSync(abs)) { log?.(`repo ${alias}: missing at ${abs}`); continue; }
      const r = indexRepo(db, abs, alias, cfg, log);
      Object.assign(manifest, r.manifest);
      stats.push({ alias, ...r, manifest: undefined });
    }
    resolveCrossRepoEdges(db, ws, log);
  } else {
    const r = indexRepo(db, projectRoot, '', cfg, log);
    manifest = r.manifest;
    stats.push({ alias: '', ...r, manifest: undefined });
  }
  // Committed manifest: small per-file content hashes (BR-001, BR-003).
  fs.writeFileSync(path.join(engDir, 'manifest.json'),
    JSON.stringify({ version: 1, files: manifest }, null, 0));
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
  setMeta.run('last_index', String(Date.now()));
  setMeta.run('last_index_ms', String(Date.now() - t0));
  setMeta.run('last_index_first_run', firstRun ? '1' : '0');
  const nodeCount = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
  const edgeCount = db.prepare('SELECT COUNT(*) c FROM edges').get().c;
  const fileCount = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  const langs = db.prepare('SELECT lang, COUNT(*) c FROM files GROUP BY lang ORDER BY c DESC LIMIT 3').all().map(r => r.lang || 'unknown');
  const repos = db.prepare('SELECT DISTINCT repo FROM files').all().map(r => r.repo || '(root)');
  // W1: registration is a side effect of INDEXING, never of merely reading. A
  // finished run is the only moment at which every field of the snapshot is
  // both true and already in scope, and the write is throttled so the watcher's
  // debounced re-runs collapse to one a minute. Wrapped because a registry
  // failure — a full disk, an unwritable ~/.config — must never be able to
  // throw into indexing, which is the thing that actually matters here.
  try {
    require('./registry').recordIndex(projectRoot, {
      files: fileCount, nodes: nodeCount, edges: edgeCount, langs, repos,
      ms: Date.now() - t0, last_indexed_ms: Date.now(), engDir,
    }, cfg);
  } catch {}
  db.close();
  return { ms: Date.now() - t0, files: fileCount, nodes: nodeCount, edges: edgeCount, stats };
}

// Cross-repo edges (BR-021 vocabulary): env-contract + shared-types heuristics.
function resolveCrossRepoEdges(db, ws, log) {
  const insEdge = db.prepare('INSERT OR REPLACE INTO edges (src_file, dst_file, kind) VALUES (?,?,?)');
  // shared types: package.json dependency name matches another repo's package name
  const pkgs = new Map();
  for (const { alias, path: repoPath } of ws.repos) {
    const p = path.resolve(ws.baseDir, repoPath, 'package.json');
    if (fs.existsSync(p)) {
      try { pkgs.set(JSON.parse(fs.readFileSync(p, 'utf8')).name, alias); } catch {}
    }
  }
  let n = 0;
  for (const { alias, path: repoPath } of ws.repos) {
    const p = path.resolve(ws.baseDir, repoPath, 'package.json');
    if (!fs.existsSync(p)) continue;
    let deps = {};
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      deps = { ...j.dependencies, ...j.devDependencies };
    } catch { continue; }
    for (const dep of Object.keys(deps)) {
      const target = pkgs.get(dep);
      if (target && target !== alias) { insEdge.run(`${alias}/package.json`, `${target}/package.json`, 'shared-types'); n++; }
    }
  }
  if (n) log?.(`cross-repo edges: ${n}`);
}

function indexStatus(projectRoot) {
  const engDir = path.join(projectRoot, '.vnodes');
  if (!fs.existsSync(path.join(engDir, 'index.db'))) return { state: 'uninitialized' };
  const db = openStoreReadOnly(engDir);
  if (!db) return { state: 'uninitialized' };
  const out = {
    state: 'ready',
    files: db.prepare('SELECT COUNT(*) c FROM files').get().c,
    nodes: db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
    edges: db.prepare('SELECT COUNT(*) c FROM edges').get().c,
    repos: db.prepare('SELECT DISTINCT repo FROM files').all().map(r => r.repo || '(root)'),
    languages: db.prepare('SELECT lang, COUNT(*) c FROM files GROUP BY lang ORDER BY c DESC').all(),
    last_index: Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index'").get()?.value || 0),
    last_index_ms: Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index_ms'").get()?.value || 0),
    last_index_first_run: db.prepare("SELECT value FROM meta WHERE key = 'last_index_first_run'").get()?.value === '1',
  };
  db.close();
  // What is on disk and deliberately absent, and the rule that made it so.
  // The index is what every agent reads, so an exclusion nobody can see is the
  // same silent omission the map is forbidden to make — and it has already cost
  // a quarter of a capsule's budget once, unnoticed, because nothing reported it.
  try {
    const { excludedSummary } = require('./exclusions');
    const report = excludedSummary(projectRoot);
    out.excluded = {
      subtrees: report.subtrees.length,
      files: report.files.length,
      by_source: report.by_source,
      truncated: report.truncated,
      // Named rather than counted: "why is X missing" is answered by seeing X.
      sample: [...report.subtrees, ...report.files]
        .slice(0, 12)
        .map(item => `${item.path} (${item.source}${item.pattern ? `: ${item.pattern}` : ''})`),
    };
  } catch (e) {
    out.excluded = { error: e.message };
  }
  // Empty/unsupported workspace must be surfaced explicitly, not silent (ERR-001).
  if (out.files === 0) out.state = 'empty — no supported files found in this tree';
  /**
   * An index.db on disk is not evidence that an index run ever finished.
   *
   * `state: 'ready'` used to rest on fs.existsSync(index.db) alone, and the
   * accidental knowledge base at $HOME is the proof of what that costs: its
   * meta table is empty, it has no manifest.json, it holds 3.67M nodes and zero
   * edges, and every status check called it healthy. Any code path that opens a
   * store creates that file — so "the file exists" and "this tree was indexed"
   * are different claims, and only the second one is worth reporting as ready.
   *
   * Checked last so it wins over 'empty': a run that never finished has no file
   * count to be empty about.
   */
  if (!out.last_index || !fs.existsSync(path.join(engDir, 'manifest.json'))) {
    out.state = 'incomplete';
    out.detail = 'no index run has ever finished on this tree'
      + (out.last_index ? ' (manifest.json is missing)' : ' (meta.last_index is unset)')
      + ' — run: vnodes index';
  }
  return out;
}

module.exports = { runIndex, indexStatus, sha1 };
