/**
 * The two bars this app draws, in CSS.
 *
 * There is no charting dependency and there will not be one: the whole point of
 * a committed bundle is that a reader installs nothing, and a chart library
 * would be a hundred kilobytes of git history per edit to draw a rectangle
 * whose width is a percentage. These are rectangles whose width is a
 * percentage.
 *
 * The palette is the map's directory ramp, reused. A language on the overview
 * and a directory on the index page are both "one of a handful of kinds", and
 * spending a second set of colours on the same idea would mean the reader has
 * to learn twice which colour means nothing in particular.
 */
import { cn } from '../kit/utils'

export type Segment = { key: string; label: string; value: number; color: string }

/** `--group-1` … `--group-5`, then `--group-0`, the muted catch-all. */
export function rampColor(index: number, count = 5): string {
  if (index >= count) return 'var(--group-0)'
  return `var(--group-${(index % count) + 1})`
}

export function StackedBar({
  segments,
  total,
  className,
}: {
  segments: Segment[]
  /**
   * Given explicitly rather than summed, so a bar can be a fraction of a budget
   * and leave the remainder visibly empty. A bar that always filled its track
   * could not show headroom, which on the capsule page is the number that
   * matters most.
   */
  total: number
  className?: string
}) {
  const safe = total > 0 ? total : 1
  return (
    <div className={cn('flex h-2.5 w-full overflow-hidden rounded-full bg-card', className)}>
      {segments.map((segment) => (
        <span
          key={segment.key}
          title={`${segment.label}: ${segment.value.toLocaleString()}`}
          style={{ width: `${(segment.value / safe) * 100}%`, background: segment.color }}
          className="h-full"
        />
      ))}
    </div>
  )
}

/** The swatch-and-name list under a stacked bar. Same table, so same colours. */
export function BarLegend({ segments, total }: { segments: Segment[]; total: number }) {
  const safe = total > 0 ? total : 1
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
      {segments.map((segment) => (
        <li key={segment.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            style={{ background: segment.color }}
            className="inline-block size-2 rounded-[2px]"
          />
          {segment.label}
          <b className="text-foreground">{segment.value.toLocaleString()}</b>
          <span>{Math.round((segment.value / safe) * 100)}%</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * A one-row share, drawn inline in a table. Its job is comparison down a
 * column, not measurement: the number beside it is the measurement.
 */
export function Microbar({ share, tone }: { share: number; tone?: 'accent' | 'muted' }) {
  return (
    <span className="inline-block h-1.5 w-full overflow-hidden rounded-full bg-card align-middle">
      <span
        style={{ width: `${Math.max(1, Math.min(100, share * 100))}%` }}
        className={cn(
          'block h-full rounded-full',
          tone === 'accent' ? 'bg-accent' : 'bg-border-strong',
        )}
      />
    </span>
  )
}
