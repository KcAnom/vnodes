/**
 * The overview: is this index healthy, and is it healthy about the right files.
 *
 * The second question is the one that had no surface anywhere. `/status` and
 * `vnodes doctor` both call this project's index healthy while 181 of its 232
 * files are a headless-Chrome profile that the repo's own screenshot script
 * wrote — an index can be perfectly well-formed and still be mostly not your
 * code. So the headline here is a composition fact, not a count, and it links
 * to the page that breaks it down.
 *
 * Doctor's `detail` strings are printed exactly as the CLI wrote them. Rewording
 * them in the client would let `vnodes doctor` and this page disagree about the
 * same check, which is the failure the server-computed map layout exists to
 * prevent, one layer up.
 */
import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { BarLegend, StackedBar, rampColor } from '../shell/Bar'
import type { Segment } from '../shell/Bar'
import { Copyable } from '../shell/Copyable'
import { Stat } from '../shell/Stat'
import { Link } from '../shell/route'
import { useFeed } from '../shell/status'
import { fetchComposition } from '../shell/api'
import type { Composition, DoctorCheck } from '../shell/api'
import { relativeTime } from '../shell/time'
import { Centered } from '../shell/Centered'
import { cn } from '../kit/utils'

export function Overview() {
  const { status, statusError, health, healthError, refreshMs } = useFeed()

  /**
   * Fetched once, and only for the headline. The counts on this page poll;
   * this deliberately does not — a directory histogram over the whole store is
   * real work, and it changes when the index changes, not every ten seconds.
   */
  const [composition, setComposition] = useState<Composition | null>(null)
  useEffect(() => {
    let live = true
    fetchComposition()
      .then((next) => live && setComposition(next))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [status?.index.last_index])

  if (!status) {
    return statusError ? (
      <Centered>
        <p className="mb-1 text-[15px]">the daemon did not answer</p>
        <p className="font-mono text-[12px] break-all text-muted-foreground">{statusError}</p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Start it with <code>vnodes daemon start</code>, or run any tool call — it restarts itself.
        </p>
      </Centered>
    ) : (
      <Centered>
        <p className="text-muted-foreground">asking the daemon…</p>
      </Centered>
    )
  }

  const index = status.index
  const langs = index.languages ?? []
  const langTotal = langs.reduce((sum, row) => sum + row.c, 0)
  const segments: Segment[] = langs.map((row, position) => ({
    key: row.lang,
    label: row.lang,
    value: row.c,
    color: rampColor(position),
  }))

  const dominant = composition?.by_dir?.[0]
  const share = dominant && index.files > 0 ? dominant.files / index.files : 0

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-[17px]">status</h1>
        <p className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">
          {status.project}
        </p>
      </header>

      {/* The verdict. One sentence, and it is allowed to be uncomfortable. */}
      <p className="text-[14px] leading-relaxed">
        <b>{index.files.toLocaleString()} files indexed</b>
        {dominant && (
          <>
            {' · '}
            <b className={share >= 0.4 ? 'text-accent' : undefined}>
              {dominant.files.toLocaleString()} under {dominant.dir}
            </b>{' '}
            <span className="text-muted-foreground">({Math.round(share * 100)}%)</span>
          </>
        )}
        {' · '}
        <span className="text-muted-foreground">
          index {index.state}
          {index.last_index ? `, last built ${relativeTime(index.last_index)}` : ', never built'}
        </span>
        {'. '}
        <Link to="/ui/index" className="text-accent hover:underline">
          what is in the index →
        </Link>
      </p>

      <ul className="flex flex-wrap items-center gap-1.5">
        <li>
          <Stat label="files" value={index.files} href="/ui/index" title="what is in the index" />
        </li>
        <li>
          <Stat
            label="symbols"
            value={index.nodes}
            href="/ui/index"
            title="parsed symbols, by file"
          />
        </li>
        <li>
          <Stat label="edges" value={index.edges} href="/ui/map" title="draw the dependency map" />
        </li>
        <li>
          <Stat label="repos" value={(index.repos ?? []).length || 1} />
        </li>
        <li>
          <Stat label="languages" value={langs.length} />
        </li>
      </ul>

      <section>
        <H2>language mix</H2>
        {langTotal === 0 ? (
          <Muted>nothing indexed yet — run <code>vnodes index</code>.</Muted>
        ) : (
          <>
            <StackedBar segments={segments} total={langTotal} />
            <BarLegend segments={segments} total={langTotal} />
          </>
        )}
      </section>

      <section>
        <H2>doctor</H2>
        {healthError ? (
          <Missing endpoint="/ui/api/health" message={healthError} />
        ) : !health ? (
          <Muted>running the checks…</Muted>
        ) : (
          <ul className="flex flex-col">
            {health.doctor.checks.map((row) => (
              <CheckRow key={row.check} row={row} />
            ))}
          </ul>
        )}
      </section>

      {health?.llm && (
        <section>
          <H2>llm</H2>
          <p className="font-mono text-[12px] text-muted-foreground">
            {[
              health.llm.state,
              health.llm.mode,
              health.llm.runtime?.provider,
              health.llm.runtime?.model,
              health.llm.runtime_cli_found === false ? 'cli not found' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </section>
      )}

      {health && (
        <section className="flex flex-col gap-2">
          <H2>logs</H2>
          {/* Collapsed: a log tail is what you open when something is wrong, and
              open by default it would be the tallest thing on a healthy page. */}
          <LogTail title="daemon" lines={health.logs?.daemon ?? []} />
          <LogTail title="index" lines={health.logs?.index ?? []} />
          <p className="text-[11px] text-muted-foreground">
            The last {health.logs?.tail_lines ?? 50} lines of each. Everything before that is still
            in the files — <code>vnodes logs daemon --follow</code> reads them whole.
          </p>
        </section>
      )}

      <footer className="border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
        This page shows the index's state and doctor's checks, refreshed every{' '}
        {Math.round(refreshMs / 1000)}s. It does not show the graph (
        <Link to="/ui/map" className="text-accent hover:underline">
          map
        </Link>
        ), what an agent would be handed (
        <Link to="/ui/capsule" className="text-accent hover:underline">
          capsule
        </Link>
        ), or what previous sessions recorded (
        <Link to="/ui/notes" className="text-accent hover:underline">
          notes
        </Link>
        ). Doctor's checks are re-run when this page is opened, not on the timer.
      </footer>
    </div>
  )
}

/**
 * One check. The glyph carries the verdict, the detail carries the CLI's own
 * words, and a `vnodes …` command inside those words is pulled out as something
 * the reader can take to a terminal — without a character of it changing.
 */
function CheckRow({ row }: { row: DoctorCheck }) {
  return (
    <li className="flex items-start gap-2 border-b border-border py-1.5 font-mono text-[12px] last:border-b-0">
      {row.ok ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
      ) : (
        <X className="mt-0.5 size-3.5 shrink-0 text-red-500" />
      )}
      <span className={cn('w-28 shrink-0', row.ok ? 'text-muted-foreground' : 'text-foreground')}>
        {row.check}
      </span>
      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        <WithCommands text={row.detail} />
      </span>
    </li>
  )
}

/**
 * The CLI's own verbs, from `vnodes --help`. Spelled out rather than matched as
 * "vnodes followed by words", because that looser rule turned doctor's English
 * — "vnodes registered in project .mcp.json" — into a copyable command that
 * does not exist. A chip that offers a fake command is worse than no chip.
 */
const COMMANDS =
  'index|reindex|status|pipeline|skeleton|impact|flow|memory|workspace|setup|daemon|call|mcp|doctor|logs|llm|ui|map'

/**
 * Splits a string on the `vnodes …` commands inside it and renders those as
 * copyable chips. Everything between the matches is emitted untouched, so the
 * concatenation of what is drawn is character-for-character the string that
 * arrived — the chip is a rendering of the detail, never a rewrite of it.
 */
function WithCommands({ text }: { text: string }) {
  const pattern = new RegExp(`vnodes (?:${COMMANDS})(?: [a-z][a-z-]*)?`, 'g')
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    parts.push(<Copyable key={at} text={match[0]} />)
    last = at + match[0].length
  }
  if (last === 0) return <>{text}</>
  parts.push(text.slice(last))
  return <>{parts}</>
}

function LogTail({ title, lines }: { title: string; lines: string[] }) {
  return (
    <details className="sheet">
      <summary className="cursor-pointer px-3 py-2 text-[12px] select-none">
        {title} log{' '}
        <span className="text-muted-foreground">
          — {lines.length === 0 ? 'empty' : `last ${lines.length} lines`}
        </span>
      </summary>
      {lines.length === 0 ? (
        <p className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
          nothing written yet.
        </p>
      ) : (
        <pre className="scroll-thin max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed">
          {lines.join('\n')}
        </pre>
      )}
    </details>
  )
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">{children}</h2>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>
}

/** Said out loud, because a section that silently vanished would be a lie. */
export function Missing({ endpoint, message }: { endpoint: string; message: string }) {
  return (
    <div className="surface px-3 py-2.5 text-[12px] leading-relaxed">
      <p>
        The daemon did not answer <code className="font-mono">{endpoint}</code>, so this section is
        empty because it is unknown, not because there is nothing to report.
      </p>
      <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">{message}</p>
    </div>
  )
}
