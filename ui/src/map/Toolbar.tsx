/**
 * The rail across the top: what is being shown, how much of it, and the two
 * controls that change either — the query and the filter.
 *
 * The query is submitted as a real form so the URL carries it. A map you cannot
 * link to is a map you cannot put in a review comment.
 */
import { useEffect, useState } from 'react'
import { Search, Wifi, WifiOff } from 'lucide-react'
import { queryString } from './api'
import type { MapPayload, MapQuery } from './types'
import { cn } from '../kit/utils'

const MARKS = [
  { key: 'focus', label: 'pivot', className: 'border-accent bg-accent-dim/15' },
  { key: 'supporter', label: 'skeleton', className: 'border-accent-dim/70' },
  { key: 'cycle', label: 'cycle', className: 'border-red-500/60' },
  { key: 'isolated', label: 'isolated', className: 'border-dashed border-border-strong' },
] as const

export function Toolbar({
  payload,
  query,
  filter,
  onFilter,
  live,
}: {
  payload: MapPayload
  query: MapQuery
  filter: string
  onFilter: (next: string) => void
  live: boolean
}) {
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])

  const scope = payload.target
    ? `around ${payload.target}`
    : payload.task
      ? 'capsule for this task'
      : 'whole project'

  return (
    <header className="surface absolute top-3 right-3 left-3 z-20 flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[13px]">{scope}</h1>
        <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {payload.target || payload.task || payload.root}
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
        <Stat label="isolated" value={payload.counts.isolated} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* A GET form, so submitting is a navigation and the result is a URL. */}
        <form action="/ui/map" method="get" className="flex flex-wrap items-center gap-1.5">
          <Field
            name="target"
            placeholder="file or symbol"
            value={draft.target ?? ''}
            onChange={(target) => setDraft((d) => ({ ...d, target }))}
            width="w-44"
          />
          <Field
            name="task"
            placeholder="task, for a capsule overlay"
            value={draft.task ?? ''}
            onChange={(task) => setDraft((d) => ({ ...d, task }))}
            width="w-60"
          />
          <Field
            name="depth"
            placeholder="depth"
            value={draft.depth ?? ''}
            onChange={(depth) => setDraft((d) => ({ ...d, depth }))}
            width="w-16"
          />
          <button
            type="submit"
            className="rounded border border-border px-2.5 py-1 text-[12px] hover:bg-panel-hover"
          >
            draw
          </button>
          {(query.target || query.task || query.depth) && (
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
          <input
            type="search"
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            placeholder="filter by path…"
            className="w-52 rounded border border-border bg-background py-1 pr-2 pl-7 text-[12px] outline-none focus:border-border-active"
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

function Stat({ label, value, on }: { label: string; value: number; on?: boolean }) {
  return (
    <span
      className={cn(
        'rounded border border-border px-1.5 py-0.5',
        on ? 'border-accent text-accent' : 'text-muted-foreground',
      )}
    >
      {label} <b className="text-foreground">{value}</b>
    </span>
  )
}

function Field({
  name,
  placeholder,
  value,
  onChange,
  width,
}: {
  name: string
  placeholder: string
  value: string
  onChange: (next: string) => void
  width: string
}) {
  return (
    <input
      name={name}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        width,
        'rounded border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-border-active',
      )}
    />
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
