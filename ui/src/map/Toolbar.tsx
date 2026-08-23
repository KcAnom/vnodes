/**
 * The rail across the top: what is being shown, how much of it, and the three
 * controls that change either — the query, the filter, and the directory rail.
 *
 * The query is submitted as a real form so the URL carries it. A map you cannot
 * link to is a map you cannot put in a review comment.
 */
import { useEffect, useRef, useState } from 'react'
import { Search, Wifi, WifiOff } from 'lucide-react'
import { queryString } from './api'
import { TONE_CLASSES, groupColor } from './FileNode'
import type { MapPayload, MapQuery } from './types'
import { cn } from '../kit/utils'
import { Input } from '../shell/Input'
import { Stat } from '../shell/Stat'

// Re-exported because this rail is where the chip vocabulary started: it now
// lives in the shell so every page counts things the same way, and importing it
// from here keeps the map's own call sites reading as they did.
export { Stat }

// The legend and the nodes read from one table, so a swatch here can never be a
// different colour from the mark it names.
const MARKS = [
  { key: 'focus', label: 'pivot', className: TONE_CLASSES.focus },
  { key: 'supporter', label: 'skeleton', className: TONE_CLASSES.supporter },
  { key: 'cycle', label: 'cycle', className: TONE_CLASSES.cycle },
  { key: 'isolated', label: 'isolated', className: TONE_CLASSES.isolated },
] as const

export function Toolbar({
  payload,
  query,
  filter,
  onFilter,
  live,
  onHeight,
}: {
  payload: MapPayload
  query: MapQuery
  filter: string
  onFilter: (next: string) => void
  live: boolean
  /**
   * This rail's real height. It floats over the canvas and reflows with the
   * window, so fitView can only keep the top row of nodes clear of it by being
   * told what it currently measures rather than by assuming.
   */
  onHeight: (height: number) => void
}) {
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])

  const header = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = header.current
    if (!node) return
    const observer = new ResizeObserver(() => onHeight(node.getBoundingClientRect().height))
    observer.observe(node)
    return () => observer.disconnect()
  }, [onHeight])

  // Where the map is standing, what it is willing to draw, and how much of the
  // graph that leaves — including the edges that leave the picture, which are
  // the ones a scoped map would otherwise silently drop.
  const where = payload.path
    ? `${payload.path}/ subtree`
    : payload.target
      ? `around ${payload.target}`
      : payload.task
        ? 'capsule for this task'
        : 'whole project'
  const scope = [
    where,
    payload.show === 'all' ? 'everything indexed' : 'code only',
    `${payload.counts.files} files, ${payload.counts.edges} edges inside`,
    payload.crossing.in + payload.crossing.out > 0
      ? `${payload.crossing.in} in / ${payload.crossing.out} out`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')

  // The directories the map is drawing, biggest first. The payload already
  // knows this — a reader should not have to guess a path to scope by one.
  const tally = new Map<string, number>()
  for (const node of payload.nodes) tally.set(node.group, (tally.get(node.group) ?? 0) + 1)
  const groups = [...tally].sort((a, b) => b[1] - a[1])

  const href = (next: Partial<MapQuery>) => `/ui/map${queryString({ ...query, ...next })}`
  const showAll = payload.show === 'all'

  return (
    <header
      ref={header}
      className="surface absolute top-3 right-3 left-3 z-[var(--z-chrome)] flex flex-col gap-2.5 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[13px]">{scope}</h1>
        <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {payload.path || payload.target || payload.task || payload.root}
        </p>
        <Live live={live} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
        <Stat label="indexed" value={payload.total_files} />
        <Stat label="drawn" value={payload.counts.files} />
        <Stat label="edges" value={payload.counts.edges} />
        <Stat label="symbols" value={payload.counts.symbols} />
        <Stat label="focus" value={payload.counts.focus} on={payload.counts.focus > 0} />
        <Stat label="cycles" value={payload.counts.cycles} on={payload.counts.cycles > 0} />
        {/* The same chip both reports the unconnected files and reveals the
            ones the code-only default is holding back, which are mostly the
            same files. One word on the page rather than two. */}
        <Stat
          label="isolated"
          value={payload.counts.isolated}
          on={showAll}
          href={href({ show: showAll ? 'code' : 'all' })}
          title={
            showAll
              ? 'back to code only — hide markdown, json and config'
              : 'draw everything indexed, markdown and json included'
          }
        />

        {groups.length > 1 && (
          <ul className="flex flex-wrap items-center gap-1.5">
            {groups.map(([group, count]) => {
              const chip = (
                <>
                  <span
                    aria-hidden
                    style={{ background: groupColor(group) }}
                    className="inline-block size-2 rounded-[2px]"
                  />
                  {group} <b className="text-foreground">{count}</b>
                </>
              )
              const active = payload.path === group
              const className = cn(
                'flex items-center gap-1 rounded border px-1.5 py-0.5',
                active ? 'border-accent text-accent' : 'border-border text-muted-foreground',
              )
              // A root-level file belongs to no directory, so there is nothing
              // for it to link to — it stays a count.
              return (
                <li key={group}>
                  {group === '(root)' ? (
                    <span className={className}>{chip}</span>
                  ) : (
                    <a
                      href={active ? href({ path: '' }) : href({ path: group })}
                      title={active ? 'draw the whole project again' : `draw only ${group}/`}
                      className={cn(className, 'hover:bg-panel-hover hover:text-foreground')}
                    >
                      {chip}
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* A GET form, so submitting is a navigation and the result is a URL. */}
        <form action="/ui/map" method="get" className="flex flex-wrap items-center gap-1.5">
          <Input
            name="path"
            placeholder="directory"
            value={draft.path ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, path: event.target.value }))}
            className="w-32"
          />
          <Input
            name="target"
            placeholder="file or symbol"
            value={draft.target ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, target: event.target.value }))}
            className="w-44"
          />
          <Input
            name="task"
            placeholder="task, for a capsule overlay"
            value={draft.task ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, task: event.target.value }))}
            className="w-60"
          />
          <Input
            name="depth"
            placeholder="depth"
            value={draft.depth ?? ''}
            onChange={(event) => setDraft((d) => ({ ...d, depth: event.target.value }))}
            className="w-16"
          />
          {/* Carried through every redraw, and only when it is not the default:
              the server reads `compact`, so dropping it here would quietly undo
              a reader's choice of the roomier geometry on the next submit. */}
          {draft.compact && <input type="hidden" name="compact" value={draft.compact} />}
          {/* Carried, not shown: redrawing must not quietly re-hide the files
              the reader asked to see. Absent at the default, so the URL only
              ever spells out the deliberate choice. */}
          {draft.show === 'all' && <input type="hidden" name="show" value="all" />}
          <button
            type="submit"
            className="rounded border border-border px-2.5 py-1 text-[12px] hover:bg-panel-hover"
          >
            draw
          </button>
          {(query.target || query.task || query.depth || query.path) && (
            <a
              href="/ui/map"
              className="rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-panel-hover hover:text-foreground"
            >
              clear
            </a>
          )}
        </form>

        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            placeholder="filter by path…"
            className="w-52 pr-2 pl-7"
          />
        </label>

        <ul className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          {MARKS.map((mark) => (
            <li key={mark.key} className="flex items-center gap-1">
              <span className={cn('inline-block size-2.5 rounded-[3px] border', mark.className)} />
              {mark.label}
            </li>
          ))}
        </ul>
      </div>
    </header>
  )
}

/**
 * Whether the live stream is attached. Shown because the alternative is a page
 * that quietly stops updating and keeps presenting old counts as current.
 */
function Live({ live }: { live: boolean }) {
  return (
    <span
      title={live ? 'live: frames arrive when the index changes' : 'not receiving updates'}
      className={cn(
        'flex shrink-0 items-center gap-1 font-mono text-[10px]',
        live ? 'text-muted-foreground' : 'text-accent',
      )}
    >
      {live ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
      {live ? 'live' : 'offline'}
    </span>
  )
}

export { queryString }
