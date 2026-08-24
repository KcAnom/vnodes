/**
 * Cross-session memory — the most distinctive claim this project makes, and
 * until now the only one with no surface at all.
 *
 * Two decisions carry the page.
 *
 * The diary is what someone chose to write down (`kind: manual`). Pipeline
 * runs and leftover auto-rows are a call log, not findings, and they sit
 * behind a disclosure. Capsules attach the diary, never the log.
 *
 * And the sort is stale-first, not recent-first. A stale note is the only row
 * anywhere in this app that requires the reader to do something: it says a
 * previous session wrote down a conclusion, and the code that conclusion was
 * about has changed underneath it. Recency is the right sort for a log. This is
 * not a log.
 *
 * The `warning` and `rationale` strings are printed verbatim. They are the
 * project's own explanation of its own staleness rule, and a paraphrase here
 * would be a second, quieter rule that nothing tests.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { Centered } from '../shell/Centered'
import { Input } from '../shell/Input'
import { Stat } from '../shell/Stat'
import { Link, navigate, useRoute } from '../shell/route'
import { useKb } from '../shell/kb'
import { fetchNotes, saveNote, forgetNote } from '../shell/api'
import type { Memory, Notes } from '../shell/api'
import { relativeTime } from '../shell/time'
import { cn } from '../kit/utils'

const isNote = (row: Memory) => row.kind === 'manual'

function Compose({ onSaved }: { onSaved: () => void }) {
  const [summary, setSummary] = useState('')
  const [file, setFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const text = summary.trim()
    if (!text) return
    setBusy(true)
    setErr('')
    try {
      await saveNote(text, file.trim() ? { file: file.trim() } : {})
      setSummary('')
      setFile('')
      onSaved()
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={go} className="flex flex-col gap-1.5">
      <textarea
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="write a finding — this is what the next agent should know"
        rows={3}
        className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:border-border-active"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={file}
          onChange={(event) => setFile(event.target.value)}
          placeholder="file (optional, for staleness)"
          className="min-w-0 flex-1 font-mono text-[12px]"
        />
        <button
          type="submit"
          disabled={busy || !summary.trim()}
          className="rounded border border-border px-2.5 py-1 text-[12px] hover:bg-panel-hover disabled:opacity-50"
        >
          {busy ? 'saving…' : 'keep'}
        </button>
      </div>
      {err ? <p className="text-[11px] text-accent">{err}</p> : null}
    </form>
  )
}

/** Stale first, then newest. Both halves matter; the first one matters more. */
const byUrgency = (a: Memory, b: Memory) =>
  Number(Boolean(b.stale)) - Number(Boolean(a.stale)) || b.ts - a.ts

export function NotesView() {
  const { params } = useRoute()
  const q = params.get('q') ?? ''
  const kb = useKb()

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  const [payload, setPayload] = useState<Notes | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setError('')
    fetchNotes(q)
      .then((next) => live && setPayload(next))
      .catch((cause: Error) => live && setError(cause.message))
    return () => {
      live = false
    }
  }, [q, kb])

  const rows = useMemo(
    () => [...(payload?.observations ?? payload?.results ?? [])],
    [payload],
  )

  const notes = rows.filter(isNote).sort(byUrgency)
  const activity = rows.filter((row) => !isNote(row)).sort(byUrgency)
  const stale = rows.filter((row) => row.stale).length
  const manual = rows.filter((row) => row.kind === 'manual').length

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2 border-b border-border pb-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[17px]">notes</h1>
          <p className="text-[13px] text-muted-foreground">
            The diary for this project — findings someone chose to keep. Capsules attach these.
            Tool-call history is a log, not this list.
          </p>
        </div>

        <ul className="flex flex-wrap items-center gap-1.5">
          <li>
            <Stat label="rows" value={rows.length} />
          </li>
          <li>
            <Stat label="notes" value={notes.length} />
          </li>
          <li>
            <Stat label="manual" value={manual} />
          </li>
          <li>
            <Stat label="tool calls" value={activity.length} />
          </li>
          <li>
            <Stat label="stale" value={stale} on={stale > 0} />
          </li>
        </ul>

        <Compose
          onSaved={() => {
            fetchNotes(q)
              .then(setPayload)
              .catch((cause: Error) => setError(cause.message))
          }}
        />

        {/* Sticky rather than a second scroll container: this column already
            scrolls, and a list that scrolls inside a page that scrolls is two
            wheels under one finger. */}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            // The same fresh-string build as the capsule form's submit — a URL
            // assembled from the draft alone knows nothing about the knowledge
            // base — without the no-JS fallback, since this form has no
            // `action` and searching here is JavaScript or nothing.
            const next = new URLSearchParams()
            if (draft) next.set('q', draft)
            if (kb) next.set('kb', kb)
            const encoded = next.toString()
            navigate(`/ui/notes${encoded ? `?${encoded}` : ''}`)
          }}
          className="sticky top-0 z-[var(--z-chrome)] -mx-1 bg-background px-1 py-1"
        >
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="search what was written down…"
              className="w-full pl-7"
            />
          </label>
        </form>
      </header>

      {error ? (
        <Centered>
          <p className="mb-1 text-[15px]">no memory</p>
          <p className="font-mono text-[12px] break-all text-muted-foreground">{error}</p>
          <p className="mt-3 text-[13px] text-muted-foreground">
            From a terminal: <code>vnodes memory recent</code>.
          </p>
        </Centered>
      ) : !payload ? (
        <p className="text-[13px] text-muted-foreground">reading memory…</p>
      ) : q ? (
        <section>
          <H2>
            {rows.length} match{rows.length === 1 ? '' : 'es'} for “{q}”
          </H2>
          {rows.length === 0 ? (
            <p className="surface px-3 py-2.5 text-[13px] text-muted-foreground">
              Nothing found. Search reads the summaries, the linked file paths and the symbol names —
              not the code itself.
            </p>
          ) : (
            <List rows={[...rows].sort(byUrgency)} showRationale />
          )}
        </section>
      ) : (
        <>
          <section>
            {notes.length === 0 ? (
              <p className="surface px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
                Nothing has been written down yet. A note is saved with{' '}
                <code>vnodes memory save "…"</code>, or by an agent calling the save tool — this
                page only ever reads.
              </p>
            ) : (
              <List
                rows={notes}
                onForgotten={() => {
                  fetchNotes(q)
                    .then(setPayload)
                    .catch((cause: Error) => setError(cause.message))
                }}
              />
            )}
          </section>

          {activity.length > 0 && (
            <details className="sheet">
              <summary className="cursor-pointer px-3 py-2 text-[12px] select-none">
                tool activity — a log of calls, not insights{' '}
                <span className="text-muted-foreground">
                  ({activity.length} row{activity.length === 1 ? '' : 's'} — pipeline runs and
                  leftover auto-capture, not findings)
                </span>
              </summary>
              <div className="border-t border-border px-1 py-1">
                <List rows={activity} />
              </div>
            </details>
          )}
        </>
      )}

      <footer className="border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
        Reading this page adds nothing to memory.
        {payload?.staleness_note ? (
          <> {payload.staleness_note}</>
        ) : payload ? (
          <>
            {' '}
            The daemon did not say whether these stale flags were re-checked; they are whatever the
            last write left them.
          </>
        ) : null}
        {payload && payload.staleness_refreshed === true
          ? ' Stale flags were re-checked for this read.'
          : payload && payload.staleness_refreshed === false
            ? ' Stale flags were not re-checked for this read.'
            : null}
      </footer>
    </div>
  )
}

function List({
  rows,
  showRationale,
  onForgotten,
}: {
  rows: Memory[]
  showRationale?: boolean
  onForgotten?: () => void
}) {
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <Row key={row.id} row={row} showRationale={showRationale} onForgotten={onForgotten} />
      ))}
    </ul>
  )
}

function Row({
  row,
  showRationale,
  onForgotten,
}: {
  row: Memory
  showRationale?: boolean
  onForgotten?: () => void
}) {
  return (
    <li
      className={cn(
        'flex flex-col rounded px-2 py-1.5',
        row.stale ? 'border border-red-500/60' : 'border-b border-border last:border-b-0',
        row.stale && 'mb-1',
      )}
    >
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 text-[13px] break-words">
          {row.summary || <span className="text-muted-foreground">(no summary was recorded)</span>}
        </p>
        {row.kind === 'manual' && onForgotten ? (
          <button
            type="button"
            title="remove this finding"
            onClick={async () => {
              if (!window.confirm('Remove this finding?')) return
              await forgetNote(row.id)
              onForgotten()
            }}
            className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-accent"
          >
            remove
          </button>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{row.tool}</span>
      </div>

      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-muted-foreground">
        <span>
          {row.session}
          {row.current_session ? ' (this session)' : ''} · {relativeTime(row.ts)}
        </span>
        {row.file && (
          <Link
            to={`/ui/map?target=${encodeURIComponent(row.file)}`}
            title={`draw the map around ${row.file}`}
            // Struck through on a stale row: the link still works, and the note
            // attached to it no longer describes what is at the other end.
            className={cn('break-all hover:text-accent', row.stale && 'line-through')}
          >
            {row.file}
            {row.symbol ? `:${row.symbol}` : ''}
          </Link>
        )}
      </p>

      {showRationale && row.rationale && (
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.rationale}</p>
      )}

      {row.stale && row.warning && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1 text-[11px] text-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0 text-red-500" />
          {row.warning}
        </p>
      )}
    </li>
  )
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">{children}</h2>
  )
}
