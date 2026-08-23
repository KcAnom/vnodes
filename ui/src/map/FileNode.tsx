/**
 * One file on the canvas.
 *
 * Built on the kit's NodeShell so it carries the same header, divider and
 * selection language as any other node canvas — but a file is not an authored
 * node, so the body is what the indexer knows rather than fields to fill in.
 *
 * At most one tone per node. A file can be a pivot *and* in a cycle, and drawing
 * both would leave every node wearing something, which is the same as none of
 * them wearing anything. Capsule membership wins because it is the answer to the
 * question the map was opened with.
 */
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { FileCode2, Circle, RefreshCw, Unlink } from 'lucide-react'
import { NodeShell, TONE_CLASSES, type NodeTone } from '../kit/NodeShell'
import type { MapNode } from './types'

export { TONE_CLASSES }

/**
 * The directories the ramp names, in the order they take colours. Anything else
 * hashes into the same five, so a project whose top level is not vnodes' own
 * still gets stable per-directory colour rather than one grey for everything.
 * `(root)` and the unknown take --group-0, the muted one, because a file at the
 * repo root belongs to no subsystem and should not look like it belongs to one.
 */
const GROUP_RAMP = ['src', 'ui', 'test', 'bin', 'config']

export function groupColor(group: string): string {
  if (!group || group === '(root)') return 'var(--group-0)'
  const named = GROUP_RAMP.indexOf(group)
  if (named >= 0) return `var(--group-${named + 1})`
  let hash = 0
  for (let i = 0; i < group.length; i += 1) hash = (hash * 31 + group.charCodeAt(i)) >>> 0
  return `var(--group-${(hash % GROUP_RAMP.length) + 1})`
}

export type FileNodeData = MapNode & {
  width: number
  height: number
  dimmed: boolean
  onOpen: (file: string) => void
}

export type FileFlowNode = Node<FileNodeData, 'file'>

function toneOf(data: MapNode): NodeTone | undefined {
  if (data.focus) return 'focus'
  if (data.supporter) return 'supporter'
  if (data.inCycle) return 'cycle'
  if (data.isolated) return 'isolated'
  return undefined
}

function iconOf(data: MapNode) {
  if (data.inCycle) return <RefreshCw className="size-3.5" />
  if (data.isolated) return <Unlink className="size-3.5" />
  if (data.focus) return <Circle className="size-3.5 fill-current" />
  return <FileCode2 className="size-3.5" />
}

export function FileNode({ data, selected }: NodeProps<FileFlowNode>) {
  const degree = `${data.inDeg}↓ ${data.outDeg}↑`
  return (
    <>
      {/* Hidden because the wiring is the codebase's, not the reader's — there
          is nothing here to connect, only something to see. */}
      <Handle type="target" position={Position.Left} className="!opacity-0" isConnectable={false} />
      <NodeShell
        icon={iconOf(data)}
        title={data.name}
        // Always a subtitle, even for a root-level file whose `dir` is empty:
        // the header's stack has to be the same three lines on every node or
        // the box stops being the 82px the server put it in a row for.
        subtitle={data.dir || ' '}
        badge={data.lang}
        selected={selected}
        tone={toneOf(data)}
        rail={groupColor(data.group)}
        dimmed={data.dimmed}
        width={data.width}
        height={data.height}
        onOpen={() => data.onOpen(data.key)}
      >
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>{data.symbols} sym</span>
          <span aria-hidden>·</span>
          <span title="imported by / imports">{degree}</span>
          {data.repo && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{data.repo}</span>
            </>
          )}
        </div>
      </NodeShell>
      <Handle type="source" position={Position.Right} className="!opacity-0" isConnectable={false} />
    </>
  )
}
