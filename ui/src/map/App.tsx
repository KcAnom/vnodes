/**
 * The vnodes dependency map.
 *
 * Read-only by construction. Positions arrive from the daemon, which computes
 * them with the same code the CLI uses, so the picture and `vnodes impact`
 * cannot disagree. Nothing here writes: no store to persist, no layout to save,
 * no node to add. What the reader controls is what is *drawn* — the query — and
 * what stands out — the filter and the selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeTypes,
  type FitViewOptions,
  type NodeTypes,
} from '@xyflow/react'
import { FileNode, type FileFlowNode } from './FileNode'
import { DetailPanel } from './DetailPanel'
import { GutterEdge } from './GutterEdge'
import { Notices } from './Notices'
import { Toolbar } from './Toolbar'
import { fetchMap, queryString, readQuery, subscribe } from './api'
import type { MapHello } from './api'
import { Centered } from '../shell/Centered'
import { navigate, useRoute } from '../shell/route'
import type { MapEdge, MapPayload, MapQuery } from './types'

// React Flow remounts every node when this object changes identity, so it is
// built once at module scope rather than per render. The same is true of the
// edge table, which is why the gutter edge is registered here and not inline.
const NODE_TYPES: NodeTypes = { file: FileNode }
const EDGE_TYPES: EdgeTypes = { gutter: GutterEdge }

/**
 * Which edges paint over which. Only the closure edges used to carry a zIndex,
 * so every ordinary edge defaulted to 0 and painted *under* the node boxes —
 * which is why a dependency map's dependencies kept disappearing behind the
 * things they connect. Ranked by how much the reader asked for it: a dimmed
 * edge is background, a cycle is a defect, and the closure is the answer to the
 * question they clicked.
 */
const EDGE_Z = { dimmed: 0, base: 1, lit: 2, cycle: 3, closure: 4 }

/**
 * Arrowheads, in the four colours an edge can be. A dependency map's one
 * irreducible job is to say which way a dependency runs, and geometry cannot
 * say it — every edge here already runs left to right, so without a head the
 * picture is direction-free. React Flow keys its `<marker>` defs by these
 * props, so four colours cost four defs no matter how many edges wear them.
 */
const marker = (color: string) => ({
  type: MarkerType.ArrowClosed,
  width: 20,
  height: 20,
  color,
})

const EDGE_COLORS = {
  base: 'var(--edge-strong)',
  lit: 'var(--accent)',
  cycle: 'color-mix(in oklab, red 55%, var(--edge-strong))',
  up: 'var(--edge-up)',
  down: 'var(--edge-down)',
}

const DEFAULT_EDGE_OPTIONS = {
  type: 'gutter',
  markerEnd: marker(EDGE_COLORS.base),
}

const px = (value: number) => `${Math.round(value)}px` as `${number}px`

/**
 * What fitView must keep clear. React Flow's scalar `padding` is a fraction of
 * the *viewport*, so one number cannot describe chrome that is a fixed number
 * of pixels tall on one edge and a different number wide on another — 0.12 put
 * 53px above the graph and buried a 110px toolbar's worth of nodes under it.
 * Each figure below is a real control plus a 24px breath: the minimap is 150
 * tall, the zoom column 26 wide, the detail panel 320 wide, and the toolbar
 * reflows with the window so its height is measured rather than assumed.
 */
const fitPad = (
  headerHeight: number,
  panelOpen: boolean,
  noticesHeight: number,
): FitViewOptions => ({
  padding: {
    top: px(headerHeight + 24),
    // 174 is the minimap plus breath, and it was the only thing reserved down
    // here. The notice stack is allowed to grow to 38% of the viewport and
    // reflows with its own content, so on a trimmed or cyclic graph fitView was
    // framing nodes into the space the notices were about to occupy. Measured,
    // for the same reason the toolbar's height is measured.
    bottom: px(Math.max(174, noticesHeight + 24)),
    // The rail is a static column outside this container, so the canvas's own
    // left edge is still the zoom controls' edge and 50 is still correct.
    left: px(50),
    right: px(panelOpen ? 344 : 224),
  },
})

export function App() {
  /**
   * Derived from the router, and keyed on the href STRING.
   *
   * This is the sharpest edge in the whole migration and it is invisible in a
   * screenshot. `readQuery` returns a fresh object every call, so a query
   * derived without this memo would be a new object on every render, the
   * subscribe effect below would tear down and re-open its EventSource every
   * render, and `mapEvents()` opens an interval per connection server-side. With
   * `?task=` in the URL, every one of those ticks re-runs the entire capsule
   * pipeline. The page would look perfect and the daemon would be on fire.
   */
  const { href, params } = useRoute()
  const query = useMemo<MapQuery>(() => readQuery(params), [href])
  const [payload, setPayload] = useState<MapPayload | null>(null)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  /**
   * What the stream said about itself on connect, or null from a daemon that
   * does not say. Kept separate from `live` because they answer different
   * questions: `live` is whether this socket is attached, and this is whether
   * anything is indexing the knowledge base on the other end of it.
   */
  const [hello, setHello] = useState<MapHello | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    setHello(null)
    fetchMap(query)
      .then(setPayload)
      .catch((cause: Error) => setError(cause.message))
    return subscribe(query, setPayload, setLive, setHello)
  }, [query])

  const scope = useCallback(
    (file: string) => {
      // A route change now, not a reload: the shell stays mounted, so scoping
      // the map no longer costs a re-parse of the bundle.
      navigate(`/ui/map${queryString({ ...query, target: file })}`)
    },
    [query],
  )

  if (error) return <Fatal message={error} />
  if (!payload) return <Loading />
  if (payload.unresolved) return <Unresolved target={payload.target} query={query} />
  if (payload.nodes.length === 0) return <Unindexed />

  return (
    <ReactFlowProvider>
      <Graph
        payload={payload}
        query={query}
        filter={filter}
        onFilter={setFilter}
        live={live}
        hello={hello}
        selected={selected}
        onSelect={setSelected}
        onScope={scope}
      />
    </ReactFlowProvider>
  )
}

/** Everything reachable from `start` along one adjacency map, `limit` hops out. */
function reach(edges: Map<number, number[]>, start: number, limit: number): Set<number> {
  const seen = new Set<number>()
  let frontier = [start]
  for (let hop = 0; hop < limit && frontier.length > 0; hop += 1) {
    const next: number[] = []
    for (const id of frontier) {
      for (const neighbour of edges.get(id) ?? []) {
        if (neighbour === start || seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
      }
    }
    frontier = next
  }
  return seen
}

function Graph({
  payload,
  query,
  filter,
  onFilter,
  live,
  hello,
  selected,
  onSelect,
  onScope,
}: {
  payload: MapPayload
  query: MapQuery
  filter: string
  onFilter: (next: string) => void
  live: boolean
  hello: MapHello | null
  selected: string | null
  onSelect: (file: string | null) => void
  onScope: (file: string) => void
}) {
  const { fitView } = useReactFlow()
  const needle = filter.trim().toLowerCase()
  const wrapper = useRef<HTMLDivElement>(null)
  // Once the reader has moved the view themselves, it is theirs; refitting on a
  // resize after that would throw away where they had chosen to be looking.
  const touched = useRef(false)
  const [headerHeight, setHeaderHeight] = useState(122)
  const [noticesHeight, setNoticesHeight] = useState(0)
  const [hovered, setHovered] = useState<number | null>(null)
  const panelOpen = selected !== null

  /**
   * The graph in both directions. `deps` walks from a file to what it imports,
   * `importers` from a file to what imports it — the payload already carries
   * every edge, so a closure is a traversal rather than another round trip.
   */
  const { deps, importers, idByKey } = useMemo(() => {
    const deps = new Map<number, number[]>()
    const importers = new Map<number, number[]>()
    const add = (map: Map<number, number[]>, from: number, to: number) => {
      const list = map.get(from)
      if (list) list.push(to)
      else map.set(from, [to])
    }
    for (const edge of payload.edges) {
      add(deps, edge.to, edge.from)
      add(importers, edge.from, edge.to)
    }
    return {
      deps,
      importers,
      idByKey: new Map(payload.nodes.map((node) => [node.key, node.id])),
    }
  }, [payload])

  /**
   * What the reader is asking about, and its two answers: everything the file
   * needs, and everything that needs it. Selecting takes the whole transitive
   * closure because that is the question worth asking of a dependency graph;
   * hovering stops at one hop, so sweeping the canvas stays readable.
   */
  const closure = useMemo(() => {
    const anchor = selected !== null ? (idByKey.get(selected) ?? null) : hovered
    if (anchor === null) return null
    const limit = selected !== null ? Number.POSITIVE_INFINITY : 1
    return {
      anchor,
      up: reach(deps, anchor, limit),
      down: reach(importers, anchor, limit),
    }
  }, [selected, hovered, deps, importers, idByKey])

  const nodes = useMemo<FileFlowNode[]>(
    () =>
      payload.nodes.map((node) => {
        const filtered = needle.length > 0 && !node.key.toLowerCase().includes(needle)
        const outside =
          closure !== null &&
          node.id !== closure.anchor &&
          !closure.up.has(node.id) &&
          !closure.down.has(node.id)
        return {
          id: String(node.id),
          type: 'file' as const,
          position: { x: node.x, y: node.y },
          // The layout already decided the box; React Flow needs to know it too,
          // or fitView measures nothing and frames the graph wrong on first paint.
          width: payload.geom.nodeWidth,
          height: payload.nodeHeight,
          selected: node.key === selected,
          draggable: false,
          connectable: false,
          data: {
            ...node,
            width: payload.geom.nodeWidth,
            height: payload.nodeHeight,
            // Two reasons to recede, and either is enough: the filter did not
            // match, or this file has nothing to do with what is selected.
            dimmed: filtered || outside,
            onOpen: onSelect,
          },
        }
      }),
    [payload, needle, selected, onSelect, closure],
  )

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(payload.nodes.map((node) => [node.id, node]))
    const lit = (id: number) => {
      const node = byId.get(id)
      return Boolean(node && (node.focus || node.supporter))
    }
    const visible = (id: number) => {
      if (!needle) return true
      const node = byId.get(id)
      return Boolean(node && node.key.toLowerCase().includes(needle))
    }
    // Inside the closure an edge belongs to whichever tree it was reached by:
    // upstream if its importer is the anchor or already upstream, downstream if
    // its dependency is. Nothing can be both, because a cycle through the
    // anchor would have put the anchor in its own closure, which `reach` skips.
    const tier = (edge: MapEdge) => {
      if (!closure) return null
      const from = edge.from
      const to = edge.to
      if (closure.up.has(from) && (to === closure.anchor || closure.up.has(to))) return 'up'
      if (closure.down.has(to) && (from === closure.anchor || closure.down.has(from))) return 'down'
      return 'dimmed'
    }
    // Which lane in its column's gutter each edge turns in. Counted per column
    // rather than per node, because the gutter belongs to the column: two
    // different files leaving column 3 share the same 96px of empty canvas.
    const laneOf = new Map<number, number>()
    const nextLane = (id: number) => {
      const column = byId.get(id)?.level ?? 0
      const used = laneOf.get(column) ?? 0
      laneOf.set(column, used + 1)
      return used
    }

    return payload.edges.map((edge) => {
      const base = {
        id: `${edge.from}-${edge.to}`,
        // Dependency-first: the imported file on the left, the importer on the
        // right, so the arrow points the way the dependency actually runs.
        source: String(edge.from),
        target: String(edge.to),
        animated: false,
        data: { lane: nextLane(edge.from) },
      }
      const inClosure = tier(edge)
      if (inClosure) {
        return {
          ...base,
          className: inClosure,
          // Above the node boxes, so the answer to "what does this touch" is
          // not half-hidden behind the things it touches.
          zIndex: inClosure === 'dimmed' ? EDGE_Z.dimmed : EDGE_Z.closure,
          markerEnd: marker(
            inClosure === 'up'
              ? EDGE_COLORS.up
              : inClosure === 'down'
                ? EDGE_COLORS.down
                : EDGE_COLORS.base,
          ),
        }
      }
      if (edge.inCycle)
        return {
          ...base,
          className: 'cycle',
          zIndex: EDGE_Z.cycle,
          markerEnd: marker(EDGE_COLORS.cycle),
        }
      if (!visible(edge.from) && !visible(edge.to))
        return { ...base, className: 'dimmed', zIndex: EDGE_Z.dimmed }
      if (lit(edge.from) && lit(edge.to))
        return {
          ...base,
          className: 'lit',
          zIndex: EDGE_Z.lit,
          markerEnd: marker(EDGE_COLORS.lit),
        }
      return { ...base, zIndex: EDGE_Z.base }
    })
  }, [payload, needle, closure])

  // A live frame can change the graph under the reader. Reframing on every one
  // would yank the view; reframing when the node count changes keeps a reindex
  // that added files from leaving them off-screen with no hint they exist.
  // Opening the panel is the same problem in miniature — it takes 320px of the
  // canvas away, so what was framed no longer is.
  useEffect(() => {
    fitView({ ...fitPad(headerHeight, panelOpen, noticesHeight), duration: 200 })
  }, [fitView, payload.counts.files, headerHeight, panelOpen, noticesHeight])

  /**
   * A window that got smaller leaves nodes past its edge with no scrollbar and
   * no hint they are there. Refit — but only while the view is still the one
   * this page chose, never over a view the reader panned or zoomed to.
   */
  useEffect(() => {
    const node = wrapper.current
    if (!node) return
    let timer = 0
    const observer = new ResizeObserver(() => {
      if (touched.current) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => fitView(fitPad(headerHeight, panelOpen, noticesHeight)), 120)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [fitView, headerHeight, panelOpen, noticesHeight])

  return (
    <div ref={wrapper} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        colorMode="system"
        minZoom={0.15}
        maxZoom={2}
        // A trackpad's two-finger swipe is a pan here, not a zoom: this canvas
        // is read at one scale and walked across, the way a map is.
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        // The header is a button. Double-clicking it must open the file, not
        // open the file and zoom the canvas out from under the reader.
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={fitPad(headerHeight, panelOpen, noticesHeight)}
        // Programmatic transforms arrive with a null event; only a real one
        // means the reader took the view over.
        onMoveEnd={(event) => {
          if (event) touched.current = true
        }}
        onNodeMouseEnter={(_event, node) => setHovered(Number(node.id))}
        onNodeMouseLeave={() => setHovered(null)}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dots)" />
        <Controls showInteractive={false} className="!bottom-3 !left-3" />
        {/* Slid clear of the detail panel: on a graph this size the minimap is
            how the reader knows where they are, and the panel's rectangle
            covered it completely from the first click onward. */}
        <MiniMap
          pannable
          zoomable
          className={
            panelOpen
              ? '!right-[344px] !bottom-3 !border !border-border !bg-panel'
              : '!right-3 !bottom-3 !border !border-border !bg-panel'
          }
          maskColor="var(--overlay)"
          nodeColor={(node) => {
            const data = node.data as unknown as { focus: boolean; supporter: boolean }
            if (data.focus) return 'var(--accent)'
            if (data.supporter) return 'var(--accent-dim)'
            return 'var(--border-strong)'
          }}
        />
      </ReactFlow>

      <Toolbar
        payload={payload}
        query={query}
        filter={filter}
        onFilter={onFilter}
        live={live}
        hello={hello}
        onHeight={setHeaderHeight}
      />
      <Notices payload={payload} query={query} onHeight={setNoticesHeight} />
      {selected && (
        <DetailPanel
          file={selected}
          onOpen={onSelect}
          onClose={() => onSelect(null)}
          onScope={onScope}
        />
      )}
    </div>
  )
}

function Loading() {
  return (
    <Centered>
      <p className="text-muted-foreground">drawing…</p>
    </Centered>
  )
}

function Fatal({ message }: { message: string }) {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">the daemon did not answer</p>
      <p className="font-mono text-[12px] text-muted-foreground">{message}</p>
      <p className="mt-3 text-[13px] text-muted-foreground">
        Start it with <code>vnodes daemon start</code>, or run any tool call — it restarts itself.
      </p>
    </Centered>
  )
}

function Unresolved({ target, query }: { target: string; query: MapQuery }) {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">no match</p>
      <p className="font-mono text-[12px] break-all text-muted-foreground">{target}</p>
      <p className="mt-3 text-[13px] text-muted-foreground">
        No file or symbol by that name is indexed. Try a path suffix (<code>src/parser.js</code>) or
        an exported symbol name.
      </p>
      <p className="mt-3">
        {/* A raw anchor rather than a Link, because leaving an unresolved
            target means leaving the mounted query behind entirely — and it
            still has to keep the KB, or clearing a bad target would quietly
            change which project is drawn. */}
        <a className="text-accent hover:underline" href={`/ui/map${queryString({ kb: query.kb })}`}>
          draw the whole project
        </a>
      </p>
    </Centered>
  )
}

function Unindexed() {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">nothing indexed yet</p>
      <p className="text-[13px] text-muted-foreground">
        Run <code>vnodes index</code> — this page fills in by itself.
      </p>
    </Centered>
  )
}
