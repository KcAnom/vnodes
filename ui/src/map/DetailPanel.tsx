/**
 * What the indexer knows about one file.
 *
 * Adapted from the kit's SidePanel: same floating surface and the same rule
 * that it lives inside the canvas's stacking context rather than the page's.
 * The contents are the sidebar the old SVG map had — symbols, both edge
 * directions — because that is what `fileDetail` returns and it was already
 * the right answer.
 *
 * Dependencies and dependents are links: following the graph by clicking is the
 * whole reason to draw it, and a dead-end panel would make the map a picture.
 */
import { useEffect, useState } from 'react'
import { X, ArrowLeft, ArrowRight, Crosshair } from 'lucide-react'
import { fetchDetail } from './api'
import type { FileDetail } from './types'
import { cn } from '../kit/utils'

export function DetailPanel({
  file,
  onOpen,
  onClose,
  onScope,
}: {
  file: string
  onOpen: (file: string) => void
  onClose: () => void
  /** Redraw the map around this file. */
  onScope: (file: string) => void
}) {
  const [detail, setDetail] = useState<FileDetail | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')

  useEffect(() => {
    let live = true
    setState('loading')
    fetchDetail(file)
      .then((next) => {
        if (!live) return
        setDetail(next)
        setState(next ? 'ready' : 'missing')
      })
      .catch(() => live && setState('missing'))
    return () => {
      live = false
    }
  }, [file])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="surface scroll-thin absolute top-3 right-3 bottom-3 z-20 flex w-80 flex-col overflow-y-auto">
      <header className="sticky top-0 flex items-start gap-2 border-b border-border bg-panel px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]">{file.split('/').pop()}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">{file}</p>
        </div>
        <button
          type="button"
          onClick={() => onScope(file)}
          title="scope the map to this file"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-panel-hover hover:text-foreground"
        >
          <Crosshair className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="close (esc)"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-panel-hover hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>

      {state === 'loading' && <p className="px-3 py-4 text-muted-foreground">loading…</p>}
      {state === 'missing' && (
        <p className="px-3 py-4 text-muted-foreground">no indexed detail for this file.</p>
      )}

      {state === 'ready' && detail && (
        <div className="flex flex-col gap-4 px-3 py-3">
          <p className="font-mono text-[10px] text-muted-foreground">
            {detail.lang || 'unknown'} · {detail.size} bytes
            {detail.repo && ` · ${detail.repo}`}
          </p>

          <Section title={`symbols (${detail.symbols.length})`}>
            {detail.symbols.length === 0 ? (
              <Empty>no symbols parsed</Empty>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {detail.symbols.map((symbol) => (
                  <li key={`${symbol.name}:${symbol.line}`} className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {symbol.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{symbol.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      L{symbol.line}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`imports (${detail.dependencies.length})`} icon={<ArrowRight className="size-3" />}>
            <FileLinks rows={detail.dependencies} empty="imports nothing indexed" onOpen={onOpen} />
          </Section>

          <Section title={`imported by (${detail.dependents.length})`} icon={<ArrowLeft className="size-3" />}>
            <FileLinks rows={detail.dependents} empty="nothing indexed imports this" onOpen={onOpen} />
          </Section>
        </div>
      )}
    </aside>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="mb-1.5 flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

function FileLinks({
  rows,
  empty,
  onOpen,
}: {
  rows: { f: string; kind: string }[]
  empty: string
  onOpen: (file: string) => void
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <li key={row.f}>
          <button
            type="button"
            onClick={() => onOpen(row.f)}
            className={cn(
              'block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11px]',
              'text-foreground hover:bg-panel-hover',
            )}
          >
            {row.f}
            {row.kind && row.kind !== 'import' && (
              <span className="text-muted-foreground"> · {row.kind}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>
}
