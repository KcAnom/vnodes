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

const NODE_WIDTH = 280;
/** Characters that fit on one line at the label's size inside a node. */
const TITLE_CHARS_PER_LINE = 34;
/** Beyond this a path is genuinely too long to read in a box; it gets an ellipsis. */
const TITLE_MAX_LINES = 3;

/** Baseline of the first label line, below the directory row. */
const TITLE_TOP = 44;
/** Baseline-to-baseline within the label block. */
const TITLE_LEADING = 16;
/** Last label baseline to the meta line below it. */
const META_GAP = 20;
/** Below the meta line to the bottom edge. */
const NODE_BOTTOM = 12;

const COL_GAP = 90;
const ROW_GAP = 26;
const MARGIN = 20;

/**
 * Rows before a column spills into the next one.
 *
 * Depth alone is not enough to lay out by: most files in a real project import
 * nothing local, so they all land at depth 0 and stack into one endless strip.
 * A level spills sideways once it passes this, and later levels shift right to
 * make room, so left-to-right still reads as dependency order.
 */
const MAX_ROWS_PER_COLUMN = 10;

/** Past this many nodes the roomy box stops paying for itself and reads as sprawl. */
const COMPACT_THRESHOLD = 40;

/**
 * Every measurement the layout and the renderer share.
 *
 * Handed to the renderer on the view instead of imported from here, because
 * the two sizes below would otherwise have to be re-derived in page.js — which
 * is exactly how the first version of this in trailhead ended up drawing the
 * meta label on top of the second title line.
 */
function geometry(compact) {
  return compact
    ? {
      compact: true,
      nodeWidth: 208, charsPerLine: 24, maxLines: 2,
      titleTop: 38, titleLeading: 15, metaGap: 18, nodeBottom: 10,
      colGap: 58, rowGap: 18, margin: 16, maxRows: 14,
    }
    : {
      compact: false,
      nodeWidth: NODE_WIDTH, charsPerLine: TITLE_CHARS_PER_LINE, maxLines: TITLE_MAX_LINES,
      titleTop: TITLE_TOP, titleLeading: TITLE_LEADING, metaGap: META_GAP, nodeBottom: NODE_BOTTOM,
      colGap: COL_GAP, rowGap: ROW_GAP, margin: MARGIN, maxRows: MAX_ROWS_PER_COLUMN,
    };
}

/** Box height for a label that wrapped to `lines` lines. */
function nodeHeightFor(lines, geom = geometry(false)) {
  return geom.titleTop + (Math.max(1, lines) - 1) * geom.titleLeading + geom.metaGap + geom.nodeBottom;
}

/**
 * Wrap a file's name to the box.
 *
 * Paths break on separators before words, because `useAuth` and `Provider` in
 * `useAuthProvider.ts` are one token to a reader and splitting them mid-word
 * reads as two files. A name cut to "context-capsu…" tells you nothing, which
 * defeats the point of drawing the graph — the full key stays in the tooltip
 * either way.
 */
function wrapTitle(title, maxChars = TITLE_CHARS_PER_LINE, maxLines = TITLE_MAX_LINES) {
  const text = String(title || '').trim();
  if (!text) return [''];
  // Split after separators so the separator stays with the part it followed.
  const words = text.split(/(?<=[/\-_.])/).filter(Boolean);

  const lines = [];
  let line = '';
  let index = 0;

  for (; index < words.length; index += 1) {
    let word = words[index];
    const candidate = line + word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
      if (lines.length === maxLines) break;
    }
    // A single segment wider than the box has to break somewhere.
    while (word.length > maxChars) {
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
      if (lines.length === maxLines) break;
    }
    if (lines.length === maxLines) break;
    line = word;
  }

  if (line && lines.length < maxLines) {
    lines.push(line);
    line = '';
  }

  const dropped = line !== '' || index < words.length;
  if (dropped) {
    const last = lines[lines.length - 1] ?? '';
    lines[lines.length - 1] =
      last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines;
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
  const geom = geometry(opts.compact === undefined ? slice.files.length > COMPACT_THRESHOLD : !!opts.compact);

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

  const wrapped = new Map(keys.map(k => [k, wrapTitle(basenameOf(k), geom.charsPerLine, geom.maxLines)]));
  // One height for every box, set by the longest name in the slice. Boxes of
  // differing heights in a row read as a hierarchy that is not there.
  const tallest = Math.max(1, ...[...wrapped.values()].map(l => l.length));
  const nodeHeight = nodeHeightFor(tallest, geom);

  // How many columns each depth needs, and where its first one starts. Walked
  // in depth order so a level always begins to the right of every shallower
  // one, however many columns those spilled into.
  const countByLevel = new Map();
  for (const key of keys) {
    const level = levels.get(key) ?? 0;
    countByLevel.set(level, (countByLevel.get(level) ?? 0) + 1);
  }
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
   * Order within a column: connected before isolated, then by degree.
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
      lines: wrapped.get(key) ?? [''],
      lang: file.lang,
      repo: file.repo,
      symbols: file.symbols,
      inDeg: inDeg.get(key) || 0,
      outDeg: outDeg.get(key) || 0,
      level,
      x: geom.margin + column * (geom.nodeWidth + geom.colGap),
      y: geom.margin + row * (nodeHeight + geom.rowGap),
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
    dropped: slice.dropped || 0,
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
  wrapTitle,
  nodeHeightFor,
  elideLeft,
  NODE_WIDTH,
  TITLE_TOP,
  TITLE_LEADING,
  TITLE_CHARS_PER_LINE,
  TITLE_MAX_LINES,
  NODE_BOTTOM,
  MAX_ROWS_PER_COLUMN,
};
