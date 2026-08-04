'use strict';
// Impact graph + logic flow over the edge set (BR-011 tools; BR-029: available
// unconditionally in this build).
const { openStore } = require('./store');

// Resolve a symbol name or file path to file keys.
function resolveTargets(db, target, repo) {
  const direct = db.prepare('SELECT path FROM files WHERE path = ? OR path LIKE ?').all(target, `%/${target}`);
  if (direct.length) return direct.map(r => r.path);
  const params = [target];
  let sql = 'SELECT DISTINCT file FROM nodes WHERE name = ?';
  if (repo) { sql += ' AND repo = ?'; params.push(repo); }
  return db.prepare(sql).all(...params).map(r => r.file);
}

// The files table records each key's repo alias ('' in single-repo mode) —
// guessing the alias from the first path segment misreads src/ vs bin/ as
// different repos on non-workspace projects.
function repoMap(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT path, repo FROM files').all()) m.set(r.path, r.repo);
  return (key) => m.get(key) ?? '';
}

// Impact: who depends on this (reverse-edge BFS), depth-limited.
function impactGraph(engDir, { target, depth = 3, cross_repo = true, repo = null }) {
  const db = openStore(engDir);
  const repoOf = repoMap(db);
  const roots = resolveTargets(db, target, repo);
  if (!roots.length) { db.close(); return { target, found: false, hint: 'no file or symbol matched' }; }
  const revQ = db.prepare('SELECT src_file s, kind FROM edges WHERE dst_file = ?');
  const levels = [];
  let frontier = new Set(roots);
  const seen = new Set(roots);
  for (let d = 0; d < depth && frontier.size; d++) {
    const next = new Set();
    const lvl = [];
    for (const f of frontier) {
      for (const r of revQ.all(f)) {
        if (seen.has(r.s)) continue;
        if (!cross_repo && repoOf(r.s) !== repoOf(f)) continue;
        seen.add(r.s); next.add(r.s);
        lvl.push({ dependent: r.s, on: f, kind: r.kind });
      }
    }
    if (lvl.length) levels.push(lvl);
    frontier = next;
  }
  db.close();
  return { target, found: true, roots, dependents_total: seen.size - roots.length, levels };
}

// Logic flow: shortest dependency path between two files/symbols (bidirectional edges).
function logicFlow(engDir, { from, to, cross_repo = true, max_depth = 10 }) {
  const db = openStore(engDir);
  const repoOf = repoMap(db);
  const starts = resolveTargets(db, from, null);
  const goals = new Set(resolveTargets(db, to, null));
  if (!starts.length || !goals.size) { db.close(); return { from, to, found: false, hint: 'endpoint not matched' }; }
  const adjQ = db.prepare('SELECT dst_file n FROM edges WHERE src_file = ? UNION SELECT src_file n FROM edges WHERE dst_file = ?');
  const prev = new Map(starts.map(s => [s, null]));
  let frontier = [...starts];
  let hit = null;
  for (let d = 0; d < max_depth && frontier.length && !hit; d++) {
    const next = [];
    for (const f of frontier) {
      for (const r of adjQ.all(f, f)) {
        if (prev.has(r.n)) continue;
        if (!cross_repo && repoOf(r.n) !== repoOf(f)) continue;
        prev.set(r.n, f);
        if (goals.has(r.n)) { hit = r.n; break; }
        next.push(r.n);
      }
      if (hit) break;
    }
    frontier = next;
  }
  db.close();
  if (!hit) return { from, to, found: false, hint: `no path within ${max_depth} hops` };
  const pathArr = [];
  for (let n = hit; n; n = prev.get(n)) pathArr.unshift(n);
  return { from, to, found: true, hops: pathArr.length - 1, path: pathArr };
}

module.exports = { impactGraph, logicFlow };
