/**
 * What an agent would actually be handed for a task, and what it would not.
 *
 * This is the question the whole project exists to answer and it had no surface
 * anywhere — you could run `vnodes pipeline` and read 6,000 tokens of JSON, or
 * you could trust it. Neither is looking at it.
 *
 * The manifest below is sorted by token cost, descending, and not by the rank
 * the pipeline chose. That is the entire diagnostic value of the page: rank
 * tells you what the pipeline thought was relevant, cost tells you what your
 * budget was actually spent on, and the two disagree in exactly the cases worth
 * finding. On this repo, sorting by cost puts a 2,196-token headless-Chrome
 * WASM blob at row one of a capsule about the UI.
 *
 * A clipped pivot is the one place in this app a file's body is shown, and only
 * the head of the clip. Everything else here is a name the reader can open in
 * their own editor; the clip is the one thing their editor cannot show them,
 * because the clip is this program's decision, not the file's content.
 */
import { useEffect, useState } from 'react'
import { Scissors } from 'lucide-react'
import { BarLegend, Microbar, StackedBar } from '../shell/Bar'
import type { Segment } from '../shell/Bar'
import { Centered } from '../shell/Centered'
import { Copyable } from '../shell/Copyable'
import { Input } from '../shell/Input'
import { Stat } from '../shell/Stat'
import { Link, navigate, useRoute } from '../shell/route'
import { useKb } from '../shell/kb'
import { fetchCapsule } from '../shell/api'
import type { Capsule } from '../shell/api'
import { cn } from '../kit/utils'

/** The presets `vnodes pipeline --preset` accepts, in its own order. */
const PRESETS = ['auto', 'explore', 'debug', 'modify', 'refactor']

/** How much of the capsule head to show for a clipped pivot. */
const CLIP_PREVIEW = 2000

export function CapsuleView() {
  const { params } = useRoute()
  const kb = useKb()
  const task = params.get('task') ?? ''
  const preset = params.get('preset') ?? ''
  const maxTokens = params.get('max_tokens') ?? ''

  const [capsule, setCapsule] = useState<Capsule | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

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
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Ask for a task the way an agent would, and see the budget it comes back with.
        </p>
      </header>

      <Query task={task} preset={preset} maxTokens={maxTokens} pending={pending} />

      {!task ? (
        // Nothing to report yet, so nothing is drawn: an empty budget bar over
        // an empty manifest would look like a capsule that came back empty.
        <p className="text-[13px] text-muted-foreground">
          Nothing has been asked yet. Building a capsule runs the whole pipeline, so it happens when
          you ask and never on a timer.
        </p>
      ) : error ? (
        <Centered>
          <p className="mb-1 text-[15px]">no capsule</p>
          <p className="font-mono text-[12px] break-all text-muted-foreground">{error}</p>
          <p className="mt-3 text-[13px] text-muted-foreground">
            The same capsule from a terminal:{' '}
            <Copyable text={`vnodes pipeline "${task}"`} />
          </p>
        </Centered>
      ) : !capsule ? (
        <p className="text-[13px] text-muted-foreground">building the capsule…</p>
      ) : (
        <Result capsule={capsule} task={task} preset={preset} maxTokens={maxTokens} />
      )}
    </div>
  )
}

/**
 * A real GET form, for the same reason the map's is: submitting is a
 * navigation and the result is a URL you can paste into a review comment. The
 * click is intercepted so the bundle is not reparsed, but the markup means the
 * form still works if the interception never runs.
 */
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
        // Built fresh from the draft rather than edited from the current URL,
        // which is what drops anything the draft does not know about — so the
        // knowledge base has to be put back by name.
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
      {/* And again in the markup, because this form carries a real `action`:
          if the interception never runs, the browser submits it and only the
          named inputs survive. */}
      {kb && <input type="hidden" name="kb" value={kb} />}
      <Input
        name="task"
        placeholder="what are you about to do?"
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
        {pending ? 'building…' : 'build'}
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
  // The baseline comes back with the capsule rather than being looked up in the
  // config: the server computed the percentage against it, and reading it from
  // a second place is how the number and its explanation drift apart.
  const baseline = capsule.baseline

  const pivotTokens = capsule.pivots.reduce((sum, row) => sum + row.tokens, 0)
  const skeletonTokens = capsule.skeletons.reduce((sum, row) => sum + row.tokens, 0)
  /**
   * The payload prices files and does not price memories one by one, so their
   * share is what `used_tokens` has left over. Clamped at zero rather than
   * shown negative: if the server's arithmetic and this subtraction ever
   * disagree, an empty segment is a smaller lie than a backwards one.
   */
  const memoryTokens = Math.max(0, capsule.used_tokens - pivotTokens - skeletonTokens)
  const headroom = Math.max(0, capsule.budget_tokens - capsule.used_tokens)

  const segments: Segment[] = [
    { key: 'pivots', label: 'pivots', value: pivotTokens, color: 'var(--accent)' },
    { key: 'skeletons', label: 'skeletons', value: skeletonTokens, color: 'var(--accent-dim)' },
    { key: 'memories', label: 'memories', value: memoryTokens, color: 'var(--group-1)' },
    { key: 'headroom', label: 'headroom', value: headroom, color: 'var(--border)' },
  ].filter((segment) => segment.value > 0)

  // One list, both roles, biggest first. See the file header.
  const manifest = [
    ...capsule.pivots.map((row) => ({ ...row, role: 'pivot' as const })),
    ...capsule.skeletons.map((row) => ({
      ...row,
      role: 'skeleton' as const,
      clipped: false as const,
      full_tokens: undefined,
      content: undefined,
    })),
  ].sort((a, b) => b.tokens - a.tokens)

  // Sorted by cost for the same reason the manifest above is: what was dropped
  // matters most where the most budget was at stake.
  const omitted = [...(capsule.omitted ?? [])].sort((a, b) => b.est_tokens - a.est_tokens)
  const omittedTokens = omitted.reduce((sum, row) => sum + row.est_tokens, 0)

  const mapHref = `/ui/map?task=${encodeURIComponent(task)}`
  // The daemon builds this line itself, so the page and the CLI cannot spell the
  // same invocation two ways. The fallback is only for a daemon that predates it.
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
            title="every note this project has kept"
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

      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-[11px] tracking-wide text-muted-foreground uppercase">
            manifest — by cost
          </h2>
          <Link to={mapHref} className="text-[12px] text-accent hover:underline">
            see this on the map →
          </Link>
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
              {/* "entries", not "files": the omitted list carries dropped
                  observations too, and one of those is a finding nobody can
                  get back by opening a file. */}
              {omitted.length} {omitted.length === 1 ? 'entry was' : 'entries were'} considered and
              left out, {omittedTokens.toLocaleString()} tokens' worth:
            </>
          )}
        </p>
        {omitted.length > 0 && (
          <ul className="flex flex-col">
            {/* Keyed on more than the path: two dropped observations can be
                linked to the same file, and a bare path key collapses them. */}
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
                {/* The reason is the server's own word for it, not a rewrite. */}
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
          The same capsule from a terminal: <Copyable text={command} />
        </p>
      </footer>
    </div>
  )
}

/**
 * The clip. A pivot that did not fit is the only file whose body is worth
 * showing, because "2,800 of 11,400 tokens" is a fact about this program's
 * behaviour that nothing outside it can tell you.
 */
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
          The daemon returned the clip's size but not its text.
        </p>
      )}
    </div>
  )
}
