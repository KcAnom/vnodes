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
  lines: string[]
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
  nodeHeight: number
  geom: { nodeWidth: number; margin: number; compact: boolean }
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
}
