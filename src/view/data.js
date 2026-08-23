'use strict';
// Read-only store queries behind the dependency map (M9 map surface).
//
// Separate from src/graph.js on purpose: graph.js answers agent tool calls
// (impact, flow) and its shapes are part of the MCP contract. The map needs a
// *drawable* slice — files with their language and symbol counts, plus every
// edge among them — and changing graph.js to carry presentation fields would
// leak the viewer into the tool contract.
const { openStore } = require('./../store');

// Same resolution rule as graph.js resolveTargets: exact path, path suffix,
// then symbol name. A viewer that resolved targets differently from the CLI
// would draw a map of a file the CLI never selected.
function resolveTargets(db, target, repo) {
  const direct = db.prepare('SELECT path FROM files WHERE path = ? OR path LIKE ?').all(target, `%/${target}`);
  if (direct.length) return direct.map(r => r.path);
  const params = [target];
  let sql = 'SELECT DISTINCT file FROM nodes WHERE name = ?';
  if (repo) { sql += ' AND repo = ?'; params.push(repo); }
  return db.prepare(sql).all(...params).map(r => r.file);
}

// Undirected BFS from the roots. A map scoped to a file has to show both what
// it pulls in and what breaks if it changes — impact alone would draw half a
// neighbourhood and call it the blast radius.
function neighborhood(db, roots, depth) {
  const adj = db.prepare(
    'SELECT dst_file n FROM edges WHERE src_file = ? UNION SELECT src_file n FROM edges WHERE dst_file = ?');
  const seen = new Set(roots);
  let frontier = [...roots];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const f of frontier) {
      for (const r of adj.all(f, f)) {
        if (seen.has(r.n)) continue;
        seen.add(r.n);
        next.push(r.n);
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * A drawable slice of the graph.
 *
 * `target` scopes to one file or symbol and its neighbourhood; without it the
 * whole project is offered and trimmed to `maxNodes` by degree — the most
 * connected files are the ones a map is for. Trimming is always reported in
 * `dropped`, never silent: a picture that quietly omits 900 files reads as a
 * complete picture of a small project.
 *
 * `pin` and `prefer` both anchor the walk; they differ only when the slice is
 * too big to draw. See the trim below for the order and why it has to exist.
 */
function subgraph(engDir, { target = '', depth = 2, repo = '', maxNodes = 150, pin = [], prefer = [] } = {}) {
  const db = openStore(engDir);
  try {
    const totalFiles = db.prepare('SELECT COUNT(*) c FROM files').get().c;
    if (totalFiles === 0) {
      return { files: [], edges: [], roots: [], total_files: 0, dropped: 0, target, unresolved: false };
    }

    let roots = [];
    if (target) {
      roots = resolveTargets(db, target, repo);
      if (!roots.length) {
        return { files: [], edges: [], roots: [], total_files: totalFiles, dropped: 0, target, unresolved: true };
      }
    }
    // Pinned files (a capsule's pivots) and preferred ones (its skeletons)
    // anchor the slice just like a target does — a map of a capsule that
    // trimmed away the capsule's own files would be a map of something else.
    const anchors = [...new Set([...roots, ...pin, ...prefer])];
    const keep = anchors.length ? neighborhood(db, anchors, depth) : null;

    const degree = new Map();
    const bump = (k, n) => degree.set(k, (degree.get(k) || 0) + n);
    for (const e of db.prepare('SELECT src_file s, dst_file d FROM edges').all()) { bump(e.s, 1); bump(e.d, 1); }

    const params = [];
    let sql = 'SELECT path, repo, lang FROM files';
    if (repo) { sql += ' WHERE repo = ?'; params.push(repo); }
    let files = db.prepare(sql).all(...params);
    if (keep) files = files.filter(f => keep.has(f.path));

    const considered = files.length;
    if (files.length > maxNodes) {
      // Anchors survive the trim ahead of everything else — dropping the file
      // the map was asked about would answer a different question than the one
      // posed. Ranked among themselves, because a capsule can be larger than
      // `maxNodes` on its own: with every candidate an anchor, one flag is no
      // tiebreak at all and degree decides, which trades a zero-degree pivot
      // for a well-connected skeleton and drops the files the map exists to
      // show. Explicit target first, then pivots, then skeletons.
      const rootSet = new Set(roots);
      const pinSet = new Set(pin);
      const preferSet = new Set(prefer);
      const rank = p => (rootSet.has(p) ? 3 : pinSet.has(p) ? 2 : preferSet.has(p) ? 1 : 0);
      files.sort((a, b) => {
        const byRank = rank(b.path) - rank(a.path);
        if (byRank) return byRank;
        return (degree.get(b.path) || 0) - (degree.get(a.path) || 0);
      });
      files = files.slice(0, maxNodes);
    }

    const shown = new Set(files.map(f => f.path));
    const symbols = new Map(
      db.prepare('SELECT file, COUNT(*) c FROM nodes GROUP BY file').all().map(r => [r.file, r.c]));

    const edges = db.prepare('SELECT src_file s, dst_file d, kind FROM edges').all()
      .filter(e => shown.has(e.s) && shown.has(e.d))
      .map(e => ({ src: e.s, dst: e.d, kind: e.kind || 'import' }));

    return {
      files: files.map(f => ({
        path: f.path,
        repo: f.repo || '',
        lang: f.lang || '',
        symbols: symbols.get(f.path) || 0,
      })),
      edges,
      roots: roots.filter(r => shown.has(r)),
      total_files: totalFiles,
      dropped: considered - files.length,
      target,
      unresolved: false,
    };
  } finally {
    db.close();
  }
}

/** Everything the sidebar shows for one file: symbols, both edge directions. */
function fileDetail(engDir, fileKey) {
  const db = openStore(engDir);
  try {
    const file = db.prepare('SELECT path, repo, lang, size FROM files WHERE path = ?').get(fileKey);
    if (!file) return null;
    return {
      file: file.path,
      repo: file.repo || '',
      lang: file.lang || '',
      size: file.size || 0,
      symbols: db.prepare('SELECT name, kind, line, signature FROM nodes WHERE file = ? ORDER BY line').all(fileKey),
      dependencies: db.prepare('SELECT dst_file f, kind FROM edges WHERE src_file = ? ORDER BY dst_file').all(fileKey),
      dependents: db.prepare('SELECT src_file f, kind FROM edges WHERE dst_file = ? ORDER BY src_file').all(fileKey),
    };
  } finally {
    db.close();
  }
}

/** Index generation, for deciding whether a live frame is worth pushing. */
function indexStamp(engDir) {
  const db = openStore(engDir);
  try {
    return Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index'").get()?.value || 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

module.exports = { subgraph, fileDetail, indexStamp };
