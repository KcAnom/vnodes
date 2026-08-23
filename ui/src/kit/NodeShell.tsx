/**
 * Shared chrome for a canvas node — adapted from nodekit's `src/kit/NodeShell`.
 *
 * The original carries a per-node menu (duplicate, delete) and a resize handle,
 * because a canvas whose nodes are authored needs both. Nothing here is
 * authored: a node is a file the indexer found, and the only honest actions on
 * it are "look at it" and "scope the map to it". So the menu and the resizer are
 * gone and the header is a button.
 *
 * What is kept is the part worth keeping — the layout language. Icon, title,
 * subtitle, badge, a body below a divider, and selection shown as a border lift
 * rather than a colour, so the accent stays scarce enough to mean something.
 *
 * The rows below are fixed rather than intrinsic. The server decides row pitch,
 * because pitch is layout, and it decides it without being able to measure the
 * reader's font stack — so the only way the two can agree is for this box to
 * stop varying. 1 + 49 + 31 + 1 = 82 = geometry().nodeHeight in
 * src/view/model.js — these two numbers are one contract. Change either and the
 * boxes clip or the rows stop being level.
 */
import type { ReactNode } from 'react'
import { cn } from './utils'

/**
 * The four marks a node can wear, as the classes that draw them. Exported
 * because a legend that names a mark has to be the same colour as the mark, and
 * the only way to guarantee that is for there to be one table rather than two.
 */
export const TONE_CLASSES = {
  focus: 'border-accent bg-accent-dim/15',
  supporter: 'border-accent-dim/70',
  cycle: 'border-red-500/60',
  isolated: 'border-dashed border-border-strong',
} as const

export type NodeTone = keyof typeof TONE_CLASSES

export function NodeShell({
  icon,
  title,
  subtitle,
  badge,
  selected,
  tone,
  rail,
  dimmed,
  width,
  height,
  onOpen,
  children,
}: {
  icon: ReactNode
  title: string
  subtitle?: string
  /** Small muted label on the right of the header. */
  badge?: ReactNode
  selected?: boolean
  /** The one mark this node carries, if any. Scarcity is the point. */
  tone?: NodeTone
  /**
   * A colour for the stripe down the left edge — a grouping the caller has,
   * kept as a colour rather than a name so this file stays domain-free.
   */
  rail?: string
  /** Filtered out: still drawn, still positioned, just not competing. */
  dimmed?: boolean
  width: number
  height: number
  onOpen: () => void
  children?: ReactNode
}) {
  return (
    <div
      style={{ width, height }}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-base border bg-panel text-left transition-[opacity,border-color] duration-150',
        selected ? 'border-border-active' : 'border-border',
        tone && TONE_CLASSES[tone],
        dimmed && 'opacity-25',
      )}
    >
      {rail && (
        <span
          aria-hidden
          style={{ background: rail }}
          className="absolute inset-y-0 left-0 w-[3px] rounded-l-[10px]"
        />
      )}
      <button
        type="button"
        onClick={onOpen}
        className="flex h-[49px] shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-left hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-none"
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight">{title}</span>
          {subtitle && (
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {subtitle}
            </span>
          )}
        </span>
        {badge && (
          <span className="shrink-0 font-mono text-[10px] whitespace-nowrap text-muted-foreground">
            {badge}
          </span>
        )}
      </button>
      {/* Unconditional: an absent body would be a shorter box, and a shorter box
          is a box that disagrees with the row the server put it in. */}
      <div className="h-[31px] px-3 py-2">{children}</div>
    </div>
  )
}
