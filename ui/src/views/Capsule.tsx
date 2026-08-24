/**
 * Inspect the agent orientation payload.
 *
 * vnodes exists so an agent can call `run_pipeline` once and get pivot files,
 * supporter skeletons, and prior findings inside a token budget. That call is
 * the product. This page is not a place to do the work — it is how you look at
 * what that call selected, and whether agents on this knowledge base are using
 * it at all.
 *
 * Default order is the order the pipeline handed over (pivots, then skeletons).
 * Sorting by cost is a diagnostic of waste, not the payload.
 */
import { useEffect, useMemo, useState } from 'react'
import { Scissors } from 'lucide-react'
import { BarLegend, Microbar, StackedBar } from '../shell/Bar'
import type { Segment } from '../shell/Bar'
import { Centered } from '../shell/Centered'
import { Copyable } from '../shell/Copyable'
import { Input } from '../shell/Input'
import { Stat } from '../shell/Stat'
import { Link, navigate, useRoute } from '../shell/route'
import { useKb } from '../shell/kb'
import { fetchCapsule, fetchNotes } from '../shell/api'
import type { Capsule, Memory } from '../shell/api'
import { relativeTime } from '../shell/time'
import { cn } from '../kit/utils'

const PRESETS = ['auto', 'explore', 'debug', 'modify', 'refactor']
const CLIP_PREVIEW = 2000
const ORIENTS = new Set(['run_pipeline', 'get_context_capsule'])

function taskFromSummary(summary: string): string {
  const m = summary.match(/^task:\s*(.*?)\s*→/)
  return (m ? m[1] : summary).trim()
}

export function CapsuleView() {
  const { params } = useRoute()
  const kb = useKb()
  const task = params.get('task') ?? ''
  const preset = params.get('preset') ?? ''
  const maxTokens = params.get('max_tokens') ?? ''

  const [capsule, setCapsule] = useState<Capsule | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [orientations, setOrientations] = useState<Memory[] | null>(null)

  useEffect(() => {
    let live = true
    fetchNotes('')
      .then((notes) => {
        if (!live) return
        const rows = [...(notes.observations ?? notes.results ?? [])].filter((row) =>
          ORIENTS.has(row.tool),
        )
        setOrientations(rows)
      })
      .catch(() => live && setOrientations([]))
    return () => {
      live = false
    }
  }, [kb])

  useEffect(() => {
    if (!task) {
      setCapsule(null)
      setError('')
      return
    }
    let live = true
    setPending(true)
    setError('')
    fetchCapsule(task, preset, maxTokens)
      .then((next) => live && setCapsule(next))
      .catch((cause: Error) => live && setError(cause.message))
      .finally(() => live && setPending(false))
    return () => {
      live = false
    }
  }, [task, preset, maxTokens, kb])

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-[17px]">capsule</h1>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          The product is one MCP call — <code className="font-mono text-foreground">run_pipeline</code>{' '}
          — that hands an agent the pivot files, supporter skeletons and prior findings for a task,
          inside a token budget. This page inspects that payload. It is not a place to do the task.
        </p>
      </header>

      <RecentOrientations
        rows={orientations}
        active={task}
        onPick={(next) => {
          const q = new URLSearchParams()
          q.set('task', next)
          if (preset) q.set('preset', preset)
          if (maxTokens) q.set('max_tokens', maxTokens)
          if (kb) q.set('kb', kb)
          navigate(`/ui/capsule?${q}`)
        }}
      />

      <Query task={task} preset={preset} maxTokens={maxTokens} pending={pending} />

      {!task ? (
        <p className="text-[13px] text-muted-foreground">
          Pick a recent orientation above, or replay a task to see what{' '}
          <code className="font-mono">run_pipeline</code> would select right now.
        </p>
      ) : error ? (
        <Centered>
          <p className="mb-1 text-[15px]">no capsule</p>
          <p className="font-mono text-[12px] break-all text-muted-foreground">{error}</p>
        </Centered>
      ) : !capsule ? (
        <p className="text-[13px] text-muted-foreground">building the capsule…</p>
      ) : (
        <Result capsule={capsule} task={task} preset={preset} maxTokens={maxTokens} />
      )}
    </div>
  )
}

function RecentOrientations({
  rows,
  active,
  onPick,
}: {
  rows: Memory[] | null
  active: string
  onPick: (task: string) => void
}) {
  if (rows == null) return null
  if (rows.length === 0) {
    return (
      <p className="rounded border border-border px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
        No agent has called <code className="font-mono text-foreground">run_pipeline</code> on this
        knowledge base yet. Until one does, the graph is indexed and unused — the reason this
        project exists is that orientation call, not this form.
      </p>
    )
  }
  return (
    <section>
      <h2 className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">
        recent orientations — what agents actually asked
      </h2>
      <ul className="flex flex-col rounded border border-border">
        {rows.slice(0, 8).map((row) => {
          const asked = taskFromSummary(row.summary)
          const on = asked === active
          return (
            <li key={row.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onPick(asked)}
                className={cn(
                  'flex w-full items-baseline gap-3 px-3 py-1.5 text-left hover:bg-panel-hover',
                  on && 'bg-accent-dim/10',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{asked}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {row.tool}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {relativeTime(row.ts)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Query({
  task,
  preset,
  maxTokens,
  pending,
}: {
  task: string
  preset: string
  maxTokens: string
  pending: boolean
}) {
  const [draft, setDraft] = useState({ task, preset, maxTokens })
  const kb = useKb()
  useEffect(() => setDraft({ task, preset, maxTokens }), [task, preset, maxTokens])

  return (
    <form
      action="/ui/capsule"
      method="get"
      onSubmit={(event) => {
        event.preventDefault()
        const next = new URLSearchParams()
        if (draft.task) next.set('task', draft.task)
        if (draft.preset) next.set('preset', draft.preset)
        if (draft.maxTokens) next.set('max_tokens', draft.maxTokens)
        if (kb) next.set('kb', kb)
        const encoded = next.toString()
        navigate(`/ui/capsule${encoded ? `?${encoded}` : ''}`)
      }}
      className="flex flex-wrap items-center gap-1.5"
    >
      {kb && <input type="hidden" name="kb" value={kb} />}
      <Input
        name="task"
        placeholder="replay a task to inspect the payload"
        value={draft.task}
        onChange={(event) => setDraft((d) => ({ ...d, task: event.target.value }))}
        className="min-w-0 flex-1"
      />
      <select
        name="preset"
        value={draft.preset}
        onChange={(event) => setDraft((d) => ({ ...d, preset: event.target.value }))}
        className="rounded border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-border-active"
      >
        <option value="">preset: auto</option>
        {PRESETS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <Input
        name="max_tokens"
        placeholder="budget"
        value={draft.maxTokens}
        onChange={(event) => setDraft((d) => ({ ...d, maxTokens: event.target.value }))}
        className="w-20"
      />
      <button
        type="submit"
        className="rounded border border-border px-2.5 py-1 text-[12px] hover:bg-panel-hover"
      >
        {pending ? 'inspecting…' : 'inspect'}
      </button>
    </form>
  )
}

function Result({
  capsule,
  task,
  preset,
  maxTokens,
}: {
  capsule: Capsule
  task: string
  preset: string
  maxTokens: string
}) {
  const [byCost, setByCost] = useState(false)
  const baseline = capsule.baseline

  const pivotTokens = capsule.pivots.reduce((sum, row) => sum + row.tokens, 0)
  const skeletonTokens = capsule.skeletons.reduce((sum, row) => sum + row.tokens, 0)
  const memoryTokens = Math.max(0, capsule.used_tokens - pivotTokens - skeletonTokens)
  const headroom = Math.max(0, capsule.budget_tokens - capsule.used_tokens)

  const segments: Segment[] = [
    { key: 'pivots', label: 'pivots', value: pivotTokens, color: 'var(--accent)' },
    { key: 'skeletons', label: 'skeletons', value: skeletonTokens, color: 'var(--accent-dim)' },
    { key: 'memories', label: 'memories', value: memoryTokens, color: 'var(--group-1)' },
    { key: 'headroom', label: 'headroom', value: headroom, color: 'var(--border)' },
  ].filter((segment) => segment.value > 0)

  const handed = useMemo(
    () => [
      ...capsule.pivots.map((row, i) => ({ ...row, role: 'pivot' as const, rank: i + 1 })),
      ...capsule.skeletons.map((row, i) => ({
        ...row,
        role: 'skeleton' as const,
        rank: capsule.pivots.length + i + 1,
        clipped: false as const,
        full_tokens: undefined,
        content: undefined,
      })),
    ],
    [capsule],
  )
  const manifest = byCost ? [...handed].sort((a, b) => b.tokens - a.tokens) : handed

  const omitted = [...(capsule.omitted ?? [])].sort((a, b) => b.est_tokens - a.est_tokens)
  const omittedTokens = omitted.reduce((sum, row) => sum + row.est_tokens, 0)

  const mapHref = `/ui/map?task=${encodeURIComponent(task)}`
  const command =
    capsule.command ??
    [
      `vnodes pipeline "${task}"`,
      preset ? `--preset ${preset}` : '',
      maxTokens ? `--max-tokens ${maxTokens}` : '',
    ]
      .filter(Boolean)
      .join(' ')

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-wrap items-center gap-1.5">
        <li>
          <Stat label="intent" value={capsule.intent} on />
        </li>
        <li>
          <Stat
            label="used"
            value={`${capsule.used_tokens.toLocaleString()}/${capsule.budget_tokens.toLocaleString()}`}
          />
        </li>
        <li>
          <Stat
            label="saved"
            value={`${capsule.savings_pct}%`}
            title={
              baseline
                ? `against the configured baseline of ${baseline}`
                : 'against the configured baseline — the daemon did not report which'
            }
          />
        </li>
        <li>
          <Stat label="pivots" value={capsule.pivots.length} />
        </li>
        <li>
          <Stat label="skeletons" value={capsule.skeletons.length} />
        </li>
        <li>
          <Stat
            label="memories"
            value={capsule.memories.length}
            href="/ui/notes"
            title="notes that attached to this payload"
          />
        </li>
      </ul>

      {capsule.intent_reason && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Intent <code className="font-mono text-foreground">{capsule.intent}</code>:{' '}
          {capsule.intent_reason}
        </p>
      )}

      <section>
        <StackedBar segments={segments} total={capsule.budget_tokens} />
        <BarLegend segments={segments} total={capsule.budget_tokens} />
      </section>

      {capsule.memories.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">
            prior findings handed with the files
          </h2>
          <ul className="flex flex-col">
            {capsule.memories.map((row) => (
              <li key={row.id} className="border-b border-border py-1.5 last:border-b-0">
                <p className="text-[13px] leading-relaxed">{row.summary}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {row.file || row.tool}
                  {row.stale ? ' · stale' : ''}
                  {row.rationale ? ` · ${row.rationale}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[11px] tracking-wide text-muted-foreground uppercase">
            {byCost ? 'manifest — by cost (waste diagnostic)' : 'as handed — pipeline order'}
          </h2>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setByCost((v) => !v)}
              className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              {byCost ? 'show pipeline order' : 'show by cost'}
            </button>
            <Link to={mapHref} className="text-[12px] text-accent hover:underline">
              see this on the map →
            </Link>
          </div>
        </div>
        {manifest.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            The capsule carries no files at all — only memories, if any.
          </p>
        ) : (
          <ul className="flex flex-col">
            {manifest.map((row) => (
              <li key={`${row.role}:${row.file}`} className="border-b border-border last:border-b-0">
                <div className="flex items-center gap-3 py-1.5">
                  <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {row.rank}
                  </span>
                  <span
                    className={cn(
                      'w-16 shrink-0 rounded border px-1.5 py-0.5 text-center font-mono text-[10px]',
                      row.role === 'pivot'
                        ? 'border-accent text-accent'
                        : 'border-accent-dim/70 text-muted-foreground',
                    )}
                  >
                    {row.role}
                  </span>
                  <Link
                    to={`/ui/map?target=${encodeURIComponent(row.file)}`}
                    title={`draw the map around ${row.file}`}
                    className="min-w-0 flex-1 truncate font-mono text-[12px] hover:text-accent hover:underline"
                  >
                    {row.file}
                  </Link>
                  <span className="w-24 shrink-0">
                    <Microbar
                      share={capsule.used_tokens > 0 ? row.tokens / capsule.used_tokens : 0}
                      tone={row.role === 'pivot' ? 'accent' : 'muted'}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {row.tokens.toLocaleString()}
                  </span>
                </div>
                {row.clipped && <Clip row={row} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="flex flex-col gap-2 border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
        <p>
          {capsule.truncated
            ? 'The budget ran out: the pipeline had more it wanted to send and stopped.'
            : 'Everything the pipeline selected fitted inside the budget.'}{' '}
          {!capsule.omitted ? (
            <>
              The daemon did not report an <code className="font-mono">omitted</code> list for this
              capsule, so what was considered and dropped is unknown here — it is not a claim that
              nothing was.
            </>
          ) : omitted.length === 0 ? (
            <>Nothing else was considered and dropped.</>
          ) : (
            <>
              {omitted.length} {omitted.length === 1 ? 'entry was' : 'entries were'} considered and
              left out, {omittedTokens.toLocaleString()} tokens&apos; worth:
            </>
          )}
        </p>
        {omitted.length > 0 && (
          <ul className="flex flex-col">
            {omitted.map((row, i) => (
              <li
                key={`${row.reason}:${row.file}:${i}`}
                className="flex items-baseline gap-3 border-b border-border py-1 last:border-b-0"
              >
                <Link
                  to={`/ui/map?target=${encodeURIComponent(row.file)}`}
                  className="min-w-0 flex-1 truncate font-mono text-[11px] hover:text-accent hover:underline"
                >
                  {row.file}
                </Link>
                <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">
                  {row.reason}
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-[11px]">
                  {row.est_tokens.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        {capsule.stripped && <p>{capsule.stripped}</p>}
        <p>
          Reproduce from a terminal: <Copyable text={command} />
        </p>
      </footer>
    </div>
  )
}

function Clip({ row }: { row: { tokens: number; full_tokens?: number; content?: string } }) {
  const full = row.full_tokens ?? 0
  return (
    <div className="mb-2 rounded border border-red-500/60 bg-card">
      <p className="flex items-center gap-2 border-b border-red-500/40 px-2.5 py-1.5 font-mono text-[11px]">
        <Scissors className="size-3 shrink-0 text-red-500" />
        {row.tokens.toLocaleString()} of {full.toLocaleString()} tokens — the rest was cut
      </p>
      {row.content ? (
        <pre className="scroll-thin max-h-64 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          {row.content.slice(0, CLIP_PREVIEW)}
          {row.content.length > CLIP_PREVIEW ? '\n…' : ''}
        </pre>
      ) : (
        <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
          The daemon returned the clip&apos;s size but not its text.
        </p>
      )}
    </div>
  )
}
