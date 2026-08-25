'use strict';
// Read-only store queries behind the dependency map.
//
// Separate from src/graph.js on purpose: graph.js answers agent tool calls
// (impact, flow) and its shapes are part of the MCP contract. The map needs a
// *drawable* slice — files with their language and symbol counts, plus every
// edge among them — and changing graph.js to carry presentation fields would
// leak the viewer into the tool contract.
const { openStoreReadOnly } = require('./../store');
const { DOC_LANGS } = require('../parser');

/** A trailing slash is a directory signal, not part of the prefix we match on. */
function normalizeDir(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * Is this a directory the index knows about?
 *
 * Asked of the store rather than the filesystem, because a map that scoped
 * itself to a directory the indexer never walked would draw an empty canvas
 * and blame the reader for it.
 */
function isIndexedDir(db, dir) {
  return !!db.prepare('SELECT 1 FROM files WHERE path LIKE ? || \'/%\' LIMIT 1').get(dir);
}

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
 *
 * `path` is a different question from `target`: not "this file and what it
 * touches" but "this subtree, whole". It is the shape of the request behind
 * `vnodes map src`, and no walk answers it — a neighbourhood of src/ pulls in
 * everything that imports src/ and stops being a picture of src/.
 *
 * `show` decides whether markdown, JSON and config are drawn. They default out
 * because a dependency map has nothing to say about most of them: on this repo
 * eleven of forty-nine drawn boxes were non-code and nine carried no edge at
 * all, so a fifth of the canvas was spent on content the picture cannot
 * express. The rule is by language and not by degree, because a zero-degree
 * rule would also delete the isolated *code* files the map exists to surface.
 */
function subgraph(engDir, {
  target = '', depth = 2, repo = '', maxNodes = 150, pin = [], prefer = [], path = '', show = 'code',
} = {}) {
  // GET / map reads never create index.db. openStore would.
  const db = openStoreReadOnly(engDir);
  const codeOnly = show !== 'all';
  const empty = (totalFiles, extra = {}) => ({
    files: [], edges: [], roots: [], total_files: totalFiles, dropped: 0, target,
    path: '', show: codeOnly ? 'code' : 'all', filtered: { count: 0, langs: {} },
    out_of_scope: 0, crossing: { in: 0, out: 0 }, unresolved: false, ...extra,
  });
  if (!db) return empty(0);
  try {
    const totalFiles = db.prepare('SELECT COUNT(*) c FROM files').get().c;
    if (totalFiles === 0) return empty(0);

    let scope = normalizeDir(path);
    let roots = [];
    if (target && !scope) {
      // A target ending in `/` says "directory" outright; otherwise the file
      // and symbol rules get first refusal and a directory is only inferred
      // when they both come back empty. `vnodes map src` forwards the bare
      // word, so the promotion has to live where the resolution does.
      const asDir = normalizeDir(target);
      if (/\/$/.test(target) && isIndexedDir(db, asDir)) {
        scope = asDir;
      } else {
        roots = resolveTargets(db, target, repo);
        if (!roots.length) {
          if (!isIndexedDir(db, asDir)) return empty(totalFiles, { unresolved: true });
          scope = asDir;
        }
      }
    }
    // Pinned files (a capsule's pivots) and preferred ones (its skeletons)
    // anchor the slice just like a target does — a map of a capsule that
    // trimmed away the capsule's own files would be a map of something else.
    const anchors = [...new Set([...roots, ...pin, ...prefer])];
    const keep = scope || !anchors.length ? null : neighborhood(db, anchors, depth);

    const allEdges = db.prepare('SELECT src_file s, dst_file d FROM edges').all();
    const degree = new Map();
    const bump = (k, n) => degree.set(k, (degree.get(k) || 0) + n);
    for (const e of allEdges) { bump(e.s, 1); bump(e.d, 1); }

    const params = [];
    let sql = 'SELECT path, repo, lang FROM files';
    if (repo) { sql += ' WHERE repo = ?'; params.push(repo); }
    let files = db.prepare(sql).all(...params);
    if (scope) files = files.filter(f => f.path === scope || f.path.startsWith(`${scope}/`));
    else if (keep) files = files.filter(f => keep.has(f.path));

    // Counted before the content filter runs, so the two omissions never
    // double-count the same file.
    const outOfScope = scope ? totalFiles - files.length : 0;
    const crossing = { in: 0, out: 0 };
    if (scope) {
      // Measured against every edge in the index, not the drawn ones: the
      // point is to say out loud that the subtree is not self-contained.
      const inside = new Set(files.map(f => f.path));
      for (const e of allEdges) {
        if (!inside.has(e.s) && inside.has(e.d)) crossing.in += 1;
        else if (inside.has(e.s) && !inside.has(e.d)) crossing.out += 1;
      }
    }

    const filtered = { count: 0, langs: {} };
    if (codeOnly) {
      // An anchor is exempt. The overlay's promise is that it shows what an
      // agent would actually be handed, and a capsule pivoting on README.md
      // drawn without README.md shows something else — the same reason the
      // trim ranks anchors above degree. Nothing is hidden by the exemption:
      // an anchor that survives was never withheld, so `filtered` does not
      // claim it was.
      const anchored = new Set(anchors);
      files = files.filter(f => {
        const lang = f.lang || '';
        if (!DOC_LANGS.has(lang) || anchored.has(f.path)) return true;
        filtered.count += 1;
        filtered.langs[lang] = (filtered.langs[lang] || 0) + 1;
        return false;
      });
    }

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
      // Still only the trim: raising ui.map_max_nodes is the remedy this
      // number promises, and it is no remedy for the other three.
      dropped: considered - files.length,
      target,
      path: scope,
      show: codeOnly ? 'code' : 'all',
      filtered,
      out_of_scope: outOfScope,
      crossing,
      unresolved: false,
    };
  } finally {
    db.close();
  }
}

/** Everything the sidebar shows for one file: symbols, both edge directions. */
function fileDetail(engDir, fileKey) {
  const db = openStoreReadOnly(engDir);
  if (!db) return null;
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
  const db = openStoreReadOnly(engDir);
  if (!db) return 0;
  try {
    return Number(db.prepare("SELECT value FROM meta WHERE key = 'last_index'").get()?.value || 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

module.exports = { subgraph, fileDetail, indexStamp };
