/**
 * An edge that turns in the gutter instead of inside a node box.
 *
 * React Flow's smoothstep path puts its vertical run at the midpoint between
 * the two handles. At this layout's proportions — 208px boxes with a 96px
 * column gap — the midpoint of a two-column edge lands *inside* the box in
 * between, so the wire disappears into a panel and reappears out the other
 * side. That is the common case here, not an edge case.
 *
 * So the turn is moved into the column gutter, at one of five 12px-spaced
 * lanes. The lanes exist because several edges leaving one column at once
 * would otherwise stack their vertical runs into a single line, and a line that
 * five wires share tells you nothing about any of them.
 *
 * Be honest about what this is not: it is not obstacle-avoiding routing. A long
 * edge still runs horizontally at its target's row, and that run still crosses
 * whatever boxes are in the way. What changed is that it now crosses them
 * visibly — the halo below paints a channel in the canvas colour under the
 * stroke, so a crossing reads as passing over rather than as vanishing behind.
 */
import { getSmoothStepPath, Position } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

/** How many lanes a gutter is divided into, and how far apart they sit. */
const LANES = 5
const LANE_GAP = 12
/** Clear of the node's own border before the first lane. */
const LANE_INSET = 24

export function GutterEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
}: EdgeProps) {
  const lane = typeof data?.lane === 'number' ? data.lane : 0
  const wanted = sourceX + LANE_INSET + (lane % LANES) * LANE_GAP

  /**
   * Only used when it is actually between the two ends. An edge that runs
   * right-to-left — every edge inside an import cycle does — would otherwise be
   * asked to turn past its own target, and React Flow's fallback is better than
   * a path folded back on itself.
   */
  const usable = wanted > Math.min(sourceX, targetX) && wanted < Math.max(sourceX, targetX)

  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
    borderRadius: 8,
    ...(usable ? { centerX: wanted } : {}),
  })

  return (
    <>
      {/* The channel. Drawn first, in the canvas colour, and deliberately not
          interactive — it is a hole in what is behind the wire, not a wire. */}
      <path
        d={path}
        fill="none"
        stroke="var(--background)"
        strokeWidth={5}
        strokeLinecap="round"
        style={{ pointerEvents: 'none' }}
      />
      {/* The class is React Flow's own, so the tone rules in theme.css —
          `.react-flow__edge.up .react-flow__edge-path` and its three siblings —
          keep colouring this exactly as they coloured the built-in path. */}
      <path className="react-flow__edge-path" d={path} markerEnd={markerEnd} fill="none" />
    </>
  )
}
