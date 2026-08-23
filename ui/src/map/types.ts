/**
 * The daemon's map payload, mirrored.
 *
 * These shapes are `buildMapView`'s output in src/view/model.js, served as JSON
 * by GET /ui/map/data. Positions arrive computed: dependency depth, column and
 * row are decided server-side by the same code the CLI uses, so the picture
 * cannot disagree with `vnodes impact`. This client lays nothing out — it draws
 * what it is handed.
 */

export type MapNode = {
  id: number
  /** Repo-relative path. The identity of a node everywhere else in the UI. */
  key: string
  name: string
  dir: string
  /**
   * The first path segment — `src`, `ui`, `test`, `bin`, `config` — or `(root)`
   * for a file that lives at the repo root. The server decides it because the
   * server is what knows the scope; the client only colours by it.
   */
  group: string
  lang: string
  repo: string
  symbols: number
  inDeg: number
  outDeg: number
  level: number
  x: number
  y: number
  isRoot: boolean
  /** A capsule pivot, or the resolved target. */
  focus: boolean
  /** A capsule skeleton. */
  supporter: boolean
  inCycle: boolean
  isolated: boolean
}

export type MapEdge = {
  /** The dependency — drawn on the left. */
  from: number
  /** The importer — drawn on the right. */
  to: number
  kind: string
  inCycle: boolean
}

export type MapPayload = {
  root: string
  target: string
  unresolved: boolean
  task: string
  intent: string
  nodes: MapNode[]
  edges: MapEdge[]
  cycles: string[][]
  counts: {
    files: number
    edges: number
    cycles: number
    isolated: number
    focus: number
    symbols: number
  }
  total_files: number
  /** Files in scope that were not drawn. Never omitted, never silent. */
  dropped: number
  /**
   * The row pitch, and the height every node box must be. 82, declared once
   * server-side because pitch is layout — see the contract note in
   * ../kit/NodeShell.tsx, which pins the DOM to it.
   */
  nodeHeight: number
  geom: {
    compact: boolean
    nodeWidth: number
    nodeHeight: number
    colGap: number
    rowGap: number
    margin: number
    maxRows: number
  }
  /** The directory the map was scoped to, resolved. Empty when unscoped. */
  path: string
  /** `code` hides markdown, json and config; `all` draws everything indexed. */
  show: 'code' | 'all'
  /** Files `show=code` withheld, and what they were. Stated, never silent. */
  filtered: { count: number; langs: Record<string, number> }
  /** Files outside `path`. Stated too, for the same reason. */
  out_of_scope: number
  /** Edges with exactly one end drawn: `in` points at the scope, `out` leaves it. */
  crossing: { in: number; out: number }
}

export type FileDetail = {
  file: string
  repo: string
  lang: string
  size: number
  symbols: { name: string; kind: string; line: number; signature: string }[]
  dependencies: { f: string; kind: string }[]
  dependents: { f: string; kind: string }[]
}

export type MapQuery = {
  target?: string
  task?: string
  repo?: string
  depth?: string
  /** Draw only this directory's subtree. */
  path?: string
  /** `all` to include the non-code files `code` withholds. */
  show?: string
  /**
   * `0` for the roomier geometry. Carried here so a link that asks for it keeps
   * asking for it: the server reads this param, and until it was added to
   * `readQuery` the client dropped it on every redraw.
   */
  compact?: string
}
