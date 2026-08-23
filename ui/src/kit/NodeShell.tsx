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
 */
import type { ReactNode } from 'react'
import { cn } from './utils'

export function NodeShell({
  icon,
  title,
  subtitle,
  badge,
  selected,
  tone,
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
  tone?: 'focus' | 'supporter' | 'cycle' | 'isolated'
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
        'flex flex-col overflow-hidden rounded-base border bg-panel text-left transition-[opacity,border-color] duration-150',
        selected ? 'border-border-active' : 'border-border',
        tone === 'focus' && 'border-accent bg-accent-dim/15',
        tone === 'supporter' && 'border-accent-dim/70',
        tone === 'cycle' && 'border-red-500/60',
        tone === 'isolated' && 'border-dashed',
        dimmed && 'opacity-25',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-left hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-none"
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
      {children && <div className="min-h-0 flex-1 px-3 py-2">{children}</div>}
    </div>
  )
}
