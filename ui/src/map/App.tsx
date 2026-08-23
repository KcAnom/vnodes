/**
 * The vnodes dependency map.
 *
 * Read-only by construction. Positions arrive from the daemon, which computes
 * them with the same code the CLI uses, so the picture and `vnodes impact`
 * cannot disagree. Nothing here writes: no store to persist, no layout to save,
 * no node to add. What the reader controls is what is *drawn* — the query — and
 * what stands out — the filter and the selection.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react'
import { FileNode, type FileFlowNode } from './FileNode'
import { DetailPanel } from './DetailPanel'
import { Notices } from './Notices'
import { Toolbar } from './Toolbar'
import { fetchMap, queryFromLocation, queryString, subscribe } from './api'
import type { MapPayload, MapQuery } from './types'

// React Flow remounts every node when this object changes identity, so it is
// built once at module scope rather than per render.
const NODE_TYPES: NodeTypes = { file: FileNode }

export function App() {
  const [query] = useState<MapQuery>(queryFromLocation)
  const [payload, setPayload] = useState<MapPayload | null>(null)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    fetchMap(query)
      .then(setPayload)
      .catch((cause: Error) => setError(cause.message))
    return subscribe(query, setPayload, setLive)
  }, [query])

  const scope = useCallback(
    (file: string) => {
      window.location.href = `/ui/map${queryString({ ...query, target: file })}`
    },
    [query],
  )

  if (error) return <Fatal message={error} />
  if (!payload) return <Loading />
  if (payload.unresolved) return <Unresolved target={payload.target} />
  if (payload.nodes.length === 0) return <Unindexed />

  return (
    <ReactFlowProvider>
      <Graph
        payload={payload}
        query={query}
        filter={filter}
        onFilter={setFilter}
        live={live}
        selected={selected}
        onSelect={setSelected}
        onScope={scope}
      />
    </ReactFlowProvider>
  )
}

function Graph({
  payload,
  query,
  filter,
  onFilter,
  live,
  selected,
  onSelect,
  onScope,
}: {
  payload: MapPayload
  query: MapQuery
  filter: string
  onFilter: (next: string) => void
  live: boolean
  selected: string | null
  onSelect: (file: string | null) => void
  onScope: (file: string) => void
}) {
  const { fitView } = useReactFlow()
  const needle = filter.trim().toLowerCase()

  const nodes = useMemo<FileFlowNode[]>(
    () =>
      payload.nodes.map((node) => ({
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
          dimmed: needle.length > 0 && !node.key.toLowerCase().includes(needle),
          onOpen: onSelect,
        },
      })),
    [payload, needle, selected, onSelect],
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
    return payload.edges.map((edge) => ({
      id: `${edge.from}-${edge.to}`,
      // Dependency-first: the imported file on the left, the importer on the
      // right, so the arrow points the way the dependency actually runs.
      source: String(edge.from),
      target: String(edge.to),
      className: edge.inCycle
        ? 'cycle'
        : !visible(edge.from) && !visible(edge.to)
          ? 'dimmed'
          : lit(edge.from) && lit(edge.to)
            ? 'lit'
            : undefined,
      animated: false,
    }))
  }, [payload, needle])

  // A live frame can change the graph under the reader. Reframing on every one
  // would yank the view; reframing when the node count changes keeps a reindex
  // that added files from leaving them off-screen with no hint they exist.
  useEffect(() => {
    fitView({ padding: 0.12, duration: 200 })
  }, [fitView, payload.counts.files])

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        minZoom={0.05}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dots)" />
        <Controls showInteractive={false} className="!bottom-3 !left-3" />
        <MiniMap
          pannable
          zoomable
          className="!right-3 !bottom-3 !border !border-border !bg-panel"
          maskColor="var(--overlay)"
          nodeColor={(node) => {
            const data = node.data as unknown as { focus: boolean; supporter: boolean }
            if (data.focus) return 'var(--accent)'
            if (data.supporter) return 'var(--accent-dim)'
            return 'var(--border-strong)'
          }}
        />
      </ReactFlow>

      <Toolbar payload={payload} query={query} filter={filter} onFilter={onFilter} live={live} />
      <Notices payload={payload} />
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-md text-center">{children}</div>
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

function Unresolved({ target }: { target: string }) {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">no match</p>
      <p className="font-mono text-[12px] break-all text-muted-foreground">{target}</p>
      <p className="mt-3 text-[13px] text-muted-foreground">
        No file or symbol by that name is indexed. Try a path suffix (<code>src/parser.js</code>) or
        an exported symbol name.
      </p>
      <p className="mt-3">
        <a className="text-accent hover:underline" href="/ui/map">
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
