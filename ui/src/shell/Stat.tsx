/**
 * A counted thing, and — given an href — the control that reveals it.
 *
 * Moved out of `ui/src/map/Toolbar.tsx` unchanged, because the rule it encodes
 * is worth having once for the whole surface rather than once for the map. The
 * `isolated` chip is the proof: it reports how many files are unconnected and
 * clicking it draws them. A number the reader cannot follow is a number they
 * have to take on faith, and every page here now has numbers.
 */
import type { ReactNode } from 'react'
import { cn } from '../kit/utils'
import { Link } from './route'

export function Stat({
  label,
  value,
  on,
  href,
  title,
}: {
  label: string
  value: ReactNode
  on?: boolean
  /** Given, the chip is the control for the thing it counts. */
  href?: string
  title?: string
}) {
  const className = cn(
    'rounded border border-border px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap',
    on ? 'border-accent text-accent' : 'text-muted-foreground',
    href && 'hover:bg-panel-hover',
  )
  const body = (
    <>
      {label} <b className="text-foreground">{value}</b>
    </>
  )
  if (!href) return <span className={className}>{body}</span>
  // An href that leaves this origin, or leaves the shell, is a real navigation;
  // everything inside /ui is a route change. `Link` renders a real anchor
  // either way, so the distinction never reaches the reader's right-click menu.
  return (
    <Link to={href} title={title} className={className}>
      {body}
    </Link>
  )
}
