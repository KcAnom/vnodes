'use strict';
/**
 * The view model behind the vnodes dependency map.
 *
 * Ported from trailhead's `05-view/src/model.ts` (MIT, github.com/KcAnom/trailhead)
 * and re-pointed at a different domain: nodes are files instead of tickets and
 * edges are imports instead of blocking relations. The layout discipline is
 * unchanged, and so is the rule it enforces — pure functions, graph slice in,
 * geometry out. No HTTP, no HTML, no store handle. The part with real logic in
 * it (where a file sits in dependency order, which imports form a cycle) is
 * testable without a browser, a server, or a database.
 *
 * Nothing here re-derives an answer the engine already has. Resolution and
 * traversal come from src/view/data.js, which uses the same rules as the CLI
 * tools; a viewer computing its own could disagree with `vnodes impact`, and
 * then one of them would be lying.
 */

/**
 * The height of every node box, in pixels, and one half of a cross-file
 * contract with ui/src/kit/NodeShell.tsx.
 *
 * It is not a guess at what the DOM will do; it is the number the DOM is
 * pinned to. 82 is exactly the sum of the fixed rows NodeShell renders:
 * 1 border-top + 49 header (8 pad + 16.25 title + 15 subtitle + 8 pad +
 * 1 border-bottom) + 31 body (8 pad + 15 meta + 8 pad) + 1 border-bottom.
 * The client uses `h-[49px]` and `h-[31px]` and always renders a subtitle so
 * the box cannot drift; the server owns the number because row pitch is
 * layout, and layout is the server's. The previous value came from SVG
 * text-baseline arithmetic for a renderer that no longer exists, which clipped
 * the meta row on 44 of 49 boxes and collapsed the row gutter an edge routes
 * through.
 */
const NODE_HEIGHT = 82;

/**
 * Past this many *indexed* files the roomy box stops paying for itself.
 *
 * Counted against the whole index rather than the drawn slice, because the
 * drawn count moves when trimming or the content filter changes and a single
 * SSE frame would then rewrite every node's width and position under a reader
 * who did nothing.
 */
const COMPACT_THRESHOLD = 60;

/**
 * The canvas shape the layout aims for, width over height.
 *
 * A browser viewport minus the toolbar and the detail panel is close to 2:1;
 * a map fitted into it at 1.5 leaves the right half empty and one at 2.5
 * shrinks every label below reading size.
 */
const TARGET_ASPECT = 1.9;

/**
 * Every measurement the layout and the renderer share.
 *
 * Handed to the renderer on the view instead of imported from here, so the
 * page never re-derives a number the layout already committed to. Height is
 * the same in both branches on purpose: a box that changed height with density
 * would change the row pitch, and the client's fixed rows cannot follow it.
 */
function geometry(compact) {
  return compact
    ? {
      compact: true,
      nodeWidth: 208, nodeHeight: NODE_HEIGHT,
      colGap: 96, rowGap: 28, margin: 24, maxRows: 12,
    }
    : {
      compact: false,
      nodeWidth: 280, nodeHeight: NODE_HEIGHT,
      colGap: 120, rowGap: 28, margin: 24, maxRows: 12,
    };
}

/**
 * How many rows a column takes before it spills, chosen to fit the viewport.
 *
 * Depth alone is not enough to lay out by: most files in a real project import
 * nothing local, so they all land at depth 0 and stack into one endless strip.
 * A fixed cap solves that but has no relation to the shape being drawn — the
 * same 10 rows produced a canvas at aspect 1.54 for the default view and 2.51
 * for a task-scoped one, one wasting half the width and the other rendering
 * 13px titles at 6.7px. Scoring on the log of the ratio makes too-wide and
 * too-tall symmetric, so neither failure is preferred. The target is fixed
 * here rather than taken from the query so a map URL pasted into a review
 * renders the same picture for every reader.
 */
function rowsForShape(countByLevel, geom, target = TARGET_ASPECT) {
  const counts = [...countByLevel.values()];
  if (!counts.length) return 4;
  const total = counts.reduce((a, b) => a + b, 0);
  let best = null;
  for (let rows = 3; rows <= Math.max(3, total); rows++) {
    const columns = counts.reduce((n, c) => n + Math.ceil(c / rows), 0);
    const deepest = Math.max(...counts.map(c => Math.min(c, rows)));
    const w = columns * (geom.nodeWidth + geom.colGap) - geom.colGap + geom.margin * 2;
    const h = deepest * (geom.nodeHeight + geom.rowGap) - geom.rowGap + geom.margin * 2;
    const score = Math.abs(Math.log((w / h) / target));
    if (!best || score < best.score) best = { rows, score };
  }
  return best.rows;
}

/** Directory rows are elided from the left — the tail is the part that locates a file. */
function elideLeft(text, maxChars = 36) {
  const s = String(text || '');
  return s.length <= maxChars ? s : `…${s.slice(s.length - (maxChars - 1))}`;
}

function basenameOf(key) {
  const i = key.lastIndexOf('/');
  return i === -1 ? key : key.slice(i + 1);
}

function dirnameOf(key) {
  const i = key.lastIndexOf('/');
  return i === -1 ? '' : key.slice(0, i);
}

/**
 * Dependency depth per file.
 *
 * A file sits one column right of its deepest dependency, so imports flow
 * left-to-right. Files inside an import cycle have no honest depth — the
 * back-edge is skipped rather than followed, so the walk terminates and they
 * land somewhere readable instead of nowhere. The cycle rendering says what the
 * depth cannot.
 */
function levelsFor(keys, deps) {
  const settled = new Map();
  const walking = new Set();

  /** `-1` means "contributes no depth" — an absent dependency or a back-edge. */
  function level(key) {
    const cached = settled.get(key);
    if (cached !== undefined) return cached;
    if (walking.has(key)) return -1;

    walking.add(key);
    let deepest = -1;
    for (const dep of deps.get(key) || []) {
      if (dep === key) continue;
      const depLevel = level(dep);
      if (depLevel < 0) continue;
      deepest = Math.max(deepest, depLevel);
    }
    walking.delete(key);

    const value = deepest + 1;
    settled.set(key, value);
    return value;
  }

  const result = new Map();
  for (const key of keys) result.set(key, level(key));
  return result;
}

/**
 * Import cycles, as strongly connected components of size > 1.
 *
 * Tarjan's algorithm, iterative: a real project's dependency graph is deep
 * enough that the recursive form blows the stack on the first monorepo.
 */
function cyclesFor(keys, deps) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;

  for (const root of keys) {
    if (index.has(root)) continue;
    const work = [{ key: root, edge: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { key } = frame;
      if (frame.edge === 0) {
        index.set(key, counter);
        low.set(key, counter);
        counter += 1;
        stack.push(key);
        onStack.add(key);
      }
      const children = deps.get(key) || [];
      if (frame.edge < children.length) {
        const child = children[frame.edge];
        frame.edge += 1;
        if (!index.has(child)) {
          work.push({ key: child, edge: 0 });
        } else if (onStack.has(child)) {
          low.set(key, Math.min(low.get(key), index.get(child)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].key;
        low.set(parent, Math.min(low.get(parent), low.get(key)));
      }
      if (low.get(key) === index.get(key)) {
        const component = [];
        for (;;) {
          const popped = stack.pop();
          onStack.delete(popped);
          component.push(popped);
          if (popped === key) break;
        }
        // Size 1 is a component, not a cycle — the indexer already refuses to
        // write a self-edge, so a lone file here imports nothing of itself.
        if (component.length > 1) cycles.push(component.sort());
      }
    }
  }
  return cycles;
}

/**
 * Graph slice → laid-out view.
 *
 * `focus` is the one highlighted set on the map, and it means exactly one
 * thing: what this query is actually about — the resolved target, or the pivot
 * files of a capsule. Scarcity is the whole point of a highlight; a second
 * meaning in the same colour would cost the first one its force.
 */
function buildMapView(slice, opts = {}) {
  const { root = '', task = '', intent = '', focus = new Set(), supporters = new Set() } = opts;
  // Dense graphs get the tighter box automatically. An explicit `compact` wins,
  // so the page's own toggle can override the guess in either direction.
  const geom = geometry(opts.compact === undefined ? slice.total_files > COMPACT_THRESHOLD : !!opts.compact);

  const keys = slice.files.map(f => f.path).sort();
  const present = new Set(keys);
  const byKey = new Map(slice.files.map(f => [f.path, f]));

  const deps = new Map(keys.map(k => [k, []]));
  const inDeg = new Map(keys.map(k => [k, 0]));
  const outDeg = new Map(keys.map(k => [k, 0]));
  const edgeList = [];
  for (const e of slice.edges) {
    if (!present.has(e.src) || !present.has(e.dst) || e.src === e.dst) continue;
    deps.get(e.src).push(e.dst);
    outDeg.set(e.src, outDeg.get(e.src) + 1);
    inDeg.set(e.dst, inDeg.get(e.dst) + 1);
    edgeList.push(e);
  }

  const levels = levelsFor(keys, deps);
  const cycles = cyclesFor(keys, deps);
  const inCycle = new Set(cycles.flat());
  const cycleOf = new Map();
  for (const [i, component] of cycles.entries()) for (const k of component) cycleOf.set(k, i);

  const nodeHeight = geom.nodeHeight;

  // How many columns each depth needs, and where its first one starts. Walked
  // in depth order so a level always begins to the right of every shallower
  // one, however many columns those spilled into.
  const countByLevel = new Map();
  for (const key of keys) {
    const level = levels.get(key) ?? 0;
    countByLevel.set(level, (countByLevel.get(level) ?? 0) + 1);
  }
  // Fitted before anything is placed: every column index below depends on it.
  geom.maxRows = rowsForShape(countByLevel, geom);
  const firstColumnOf = new Map();
  let columns = 0;
  for (const level of [...countByLevel.keys()].sort((a, b) => a - b)) {
    firstColumnOf.set(level, columns);
    columns += Math.ceil((countByLevel.get(level) ?? 0) / geom.maxRows);
  }

  const rootSet = new Set(slice.roots || []);
  const isolatedOf = k => (inDeg.get(k) || 0) === 0 && (outDeg.get(k) || 0) === 0;
  const degreeOf = k => (inDeg.get(k) || 0) + (outDeg.get(k) || 0);

  /**
   * Where each directory sits inside its own level, ranked by its most
   * connected file.
   *
   * Without this, src/, src/view/, test/ and ui/src/map/ interleave down a
   * column with nothing marking where one subsystem ends, so no subsystem is
   * legible even though every one of them is drawn. This is ordering only —
   * level still decides the column, so dependency order still reads
   * left-to-right and the picture still agrees with `vnodes impact`.
   */
  const dirRank = new Map();
  for (const key of keys) {
    const slot = `${levels.get(key) ?? 0} ${dirnameOf(key)}`;
    dirRank.set(slot, Math.max(dirRank.get(slot) ?? -1, degreeOf(key)));
  }
  const rankOf = key => -(dirRank.get(`${levels.get(key) ?? 0} ${dirnameOf(key)}`) ?? 0);

  /**
   * Order within a column: directory cluster, then connected before isolated,
   * then by degree.
   *
   * Alphabetical order put `.claude/settings.local.json`, `README.md` and two
   * config files at the top of the first column, so the eye landed on four
   * boxes with no edges before reaching any code. Every term here is derived
   * from the graph, so the ordering is still deterministic — the picture does
   * not reshuffle between two renders of the same index.
   */
  const placementOrder = [...keys].sort((a, b) => {
    const la = levels.get(a) ?? 0;
    const lb = levels.get(b) ?? 0;
    if (la !== lb) return la - lb;
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const da = dirnameOf(a);
    const db = dirnameOf(b);
    if (da !== db) return da < db ? -1 : 1;
    const ia = isolatedOf(a) ? 1 : 0;
    const ib = isolatedOf(b) ? 1 : 0;
    if (ia !== ib) return ia - ib;
    const d = degreeOf(b) - degreeOf(a);
    if (d) return d;
    return a < b ? -1 : 1;
  });

  const placedByLevel = new Map();
  const position = new Map();
  let deepestRow = 0;
  for (const key of placementOrder) {
    const level = levels.get(key) ?? 0;
    const placed = placedByLevel.get(level) ?? 0;
    placedByLevel.set(level, placed + 1);
    const column = (firstColumnOf.get(level) ?? 0) + Math.floor(placed / geom.maxRows);
    const row = placed % geom.maxRows;
    deepestRow = Math.max(deepestRow, row + 1);
    position.set(key, { column, row });
  }

  // How full each column ended up, so a short one can be centred against the
  // tallest. Top-aligning every level produced a monotonic staircase with the
  // whole bottom-right quadrant empty and edges forced to cross the boxes they
  // ran past; centring spreads the same nodes over both diagonals.
  const occupancy = new Map();
  for (const { column } of position.values()) occupancy.set(column, (occupancy.get(column) ?? 0) + 1);

  // Ids stay in path order so the same file keeps the same id across renders.
  const nodes = keys.map((key, id) => {
    const level = levels.get(key) ?? 0;
    const { column, row } = position.get(key);
    const file = byKey.get(key);
    return {
      id,
      key,
      name: basenameOf(key),
      dir: elideLeft(dirnameOf(key)),
      // The top-level segment, which is the coarsest grouping a reader can
      // hold in their head at a glance: the client tints by it and the toolbar
      // builds its directory rail from it.
      group: key.includes('/') ? key.slice(0, key.indexOf('/')) : '(root)',
      lang: file.lang,
      repo: file.repo,
      symbols: file.symbols,
      inDeg: inDeg.get(key) || 0,
      outDeg: outDeg.get(key) || 0,
      level,
      x: geom.margin + column * (geom.nodeWidth + geom.colGap),
      y: geom.margin
        + Math.round(row + (deepestRow - (occupancy.get(column) ?? 0)) / 2) * (nodeHeight + geom.rowGap),
      isRoot: rootSet.has(key),
      focus: focus.has(key) || rootSet.has(key),
      supporter: supporters.has(key),
      inCycle: inCycle.has(key),
      // A file nothing imports and that imports nothing local is either an
      // entry point or dead weight; the map cannot tell which, so it says
      // "isolated" and leaves the judgement to the reader.
      isolated: (inDeg.get(key) || 0) === 0 && (outDeg.get(key) || 0) === 0,
    };
  });

  const idOf = new Map(nodes.map(n => [n.key, n.id]));
  // Drawn dependency-first: the imported file is on the left, the importer on
  // the right, and the arrow points the way the dependency actually runs.
  const edges = edgeList.map(e => ({
    from: idOf.get(e.dst),
    to: idOf.get(e.src),
    kind: e.kind,
    inCycle: cycleOf.has(e.src) && cycleOf.get(e.src) === cycleOf.get(e.dst),
  }));

  const counts = {
    files: nodes.length,
    edges: edges.length,
    cycles: cycles.length,
    isolated: nodes.filter(n => n.isolated).length,
    focus: nodes.filter(n => n.focus).length,
    symbols: nodes.reduce((n, f) => n + f.symbols, 0),
  };

  return {
    root,
    target: slice.target || '',
    unresolved: !!slice.unresolved,
    task,
    intent,
    nodes,
    edges,
    cycles,
    counts,
    total_files: slice.total_files,
    // Four kinds of omission, kept apart because each has a different remedy
    // and the page names the control that reverses it. `dropped` stays what it
    // always was — trimming to map_max_nodes and nothing else — because
    // offering "raise map_max_nodes" for a file a language filter removed
    // would be advice that does not work.
    dropped: slice.dropped || 0,
    path: slice.path || '',
    show: slice.show || 'code',
    filtered: slice.filtered || { count: 0, langs: {} },
    out_of_scope: slice.out_of_scope || 0,
    crossing: slice.crossing || { in: 0, out: 0 },
    geom,
    nodeHeight,
    width: Math.max(geom.nodeWidth + geom.margin * 2,
      columns * (geom.nodeWidth + geom.colGap) - geom.colGap + geom.margin * 2),
    height: Math.max(nodeHeight + geom.margin * 2,
      deepestRow * (nodeHeight + geom.rowGap) - geom.rowGap + geom.margin * 2),
  };
}

module.exports = {
  buildMapView,
  geometry,
  levelsFor,
  cyclesFor,
  elideLeft,
  rowsForShape,
  NODE_HEIGHT,
  COMPACT_THRESHOLD,
  TARGET_ASPECT,
};
