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
const { openStore } = require('./store');
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

// Resolve an import specifier to a file in the indexed set (relative paths only;
// bare package specifiers stay unresolved — external deps are not graph nodes).
function resolveImport(fromFile, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    `${base}.mjs`, `${base}.py`, `${base}.rb`, `${base}/index.ts`, `${base}/index.js`,
    `${base}/__init__.py`, `${base}.vue`, `${base}.svelte`];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// Index one repo tree into the store under a repo alias ('' for single-repo).
function indexRepo(db, repoRoot, alias, cfg, log) {
  const isIgnored = buildIgnore(repoRoot);
  const filterSecrets = cfg.filter_secrets !== false;
  const maxBytes = cfg.index.max_file_size_kb * 1024;
  const files = walk(repoRoot, isIgnored);
  const fileSet = new Set(files);

  const prev = new Map(
    db.prepare('SELECT path, hash FROM files WHERE repo = ?').all(alias).map(r => [r.path, r.hash]));
  const manifest = {};
  let added = 0, updated = 0, skippedSecret = 0, skippedSize = 0, unchanged = 0;

  const insFile = db.prepare('INSERT OR REPLACE INTO files (path, repo, hash, size, lang, indexed_at) VALUES (?,?,?,?,?,?)');
  const delNodes = db.prepare('DELETE FROM nodes WHERE file = ? AND repo = ?');
  const insNode = db.prepare('INSERT INTO nodes (file, repo, name, kind, line, signature) VALUES (?,?,?,?,?,?)');
  const delEdges = db.prepare('DELETE FROM edges WHERE src_file = ?');
  const insEdge = db.prepare('INSERT OR REPLACE INTO edges (src_file, dst_file, kind) VALUES (?,?,?)');

  const pendingImports = [];
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
    delEdges.run(key);
    pendingImports.push([key, rel, parsed.imports]);
  }
  // Removed files: anything previously indexed but no longer on disk.
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');
  for (const [gone] of prev) {
    delFile.run(gone);
    delNodes.run(gone, alias);
    delEdges.run(gone);
    added; // (removed count not separately reported)
  }
  // Second pass: edges, once the full file set is known.
  const prefix = alias ? `${alias}/` : '';
  const keyedSet = new Set(files.map(f => prefix + f));
  for (const [key, rel, imports] of pendingImports) {
    for (const spec of imports) {
      const dstRel = resolveImport(rel, spec, fileSet);
      if (dstRel) insEdge.run(key, prefix + dstRel, 'import');
    }
  }
  log?.(`repo=${alias || '(root)'} files=${files.length} +${added} ~${updated} =${unchanged} secret-skip=${skippedSecret} size-skip=${skippedSize}`);
  return { manifest, added, updated, unchanged, skippedSecret, skippedSize, total: files.length };
}

function runIndex(projectRoot, cfg, log) {
  const t0 = Date.now();
  const engDir = engineDir(projectRoot);
  const db = openStore(engDir);
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
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('last_index', String(Date.now()));
  const nodeCount = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
  const edgeCount = db.prepare('SELECT COUNT(*) c FROM edges').get().c;
  const fileCount = db.prepare('SELECT COUNT(*) c FROM files').get().c;
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
  const db = openStore(engDir);
  const out = {
    state: 'ready',
    files: db.prepare('SELECT COUNT(*) c FROM files').get().c,
    nodes: db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
    edges: db.prepare('SELECT COUNT(*) c FROM edges').get().c,
    repos: db.prepare('SELECT DISTINCT repo FROM files').all().map(r => r.repo || '(root)'),
    languages: db.prepare('SELECT lang, COUNT(*) c FROM files GROUP BY lang ORDER BY c DESC').all(),
    last_index: Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index'").get()?.value || 0),
  };
  db.close();
  // Empty/unsupported workspace must be surfaced explicitly, not silent (ERR-001).
  if (out.files === 0) out.state = 'empty — no supported files found in this tree';
  return out;
}

module.exports = { runIndex, indexStatus, sha1 };
