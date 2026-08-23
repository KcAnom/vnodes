/**
 * The picker. Every knowledge base this machine knows about, one row each.
 *
 * This is the page that corrects the whole misconception: vnodes is not one
 * project's graph, it is a context engine that many agents point at many
 * projects, and until now the only way to reach a knowledge base was to already
 * be standing in its directory. So the app's front door is a list, not a
 * dashboard, and the list answers exactly one question — "which of my projects,
 * and is it healthy" — before handing off. Every deeper number on every row is
 * already a page one click away, and duplicating it here would mean two places
 * that can disagree about the same index.
 *
 * Three constraints shape what is on a row.
 *
 * It is dense. These are directories, and a reader with fifteen of them is
 * scanning for a name, not admiring a card. Two lines at 64px inside the same
 * 880px reading column the other four pages use, one hairline between rows, no
 * tiles and no grid — the same reason `Shell.tsx` gives for the column itself.
 *
 * It opens no database. `indexStatus()` was measured at 5,819ms for the home
 * KB alone and `openStore` opens in WRITE mode, so a picker that asked each row
 * how it was doing would open every registered project's `index.db` for writing
 * just to draw a list. The counts on a row are the cache the registry already
 * holds, and a row whose `index.db` has been written since that cache was taken
 * says so rather than pretending the numbers are current.
 *
 * And it offers nothing that writes — not one control, not even a tempting one.
 * `index_status` is in `READ_ONLY_TOOLS` and its dispatch still calls
 * `ensureIndexed`, which is precisely how the 541,275-file index of somebody's
 * entire home directory came to exist: an agent asked a read-only question
 * while standing in `$HOME`. The home row in particular offers no re-index at
 * all, because that index has no `schema_version` in `meta` and `runIndex`
 * would open with four `DELETE FROM`s and then re-parse the home directory. The
 * remedy is a `rm -rf ~/.vnodes` the reader runs themselves, exactly the way
 * `ignore_suggestion` on the index page is a line you copy and never a button.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownUp, Home, Library } from 'lucide-react'
import type { KbRow } from '../shell/api'
import { Centered } from '../shell/Centered'
import { Copyable } from '../shell/Copyable'
import { Link } from '../shell/route'
import { Stat } from '../shell/Stat'
import { relativeTime } from '../shell/time'
import { useFeed } from '../shell/status'
import { cn } from '../kit/utils'

/** The two orders. There is no third: a picker with a sort menu is a table. */
type Sort = 'recent' | 'path'

const SORT_LABEL: Record<Sort, string> = {
  recent: 'most recently used first',
  path: 'by path, alphabetical',
}

/**
 * Bytes as the reader would say them. Not `Intl.NumberFormat` with a unit,
 * which renders "1.4 gigabytes" — this sits at the end of a header line and
 * needs to be short enough to read past.
 */
function bytes(n: number | undefined): string {
  if (!n || n < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// Total by construction. A display formatter has no business being able to
// take the page down, and this one did: the server writes explicit nulls for a
// knowledge base that has never finished an index, and every guard against
// `undefined` let them straight through.
const count = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

/**
 * `/Users/someone/code/app` → `~/code/app`.
 *
 * Cosmetic, and only ever cosmetic: the full path is on the row's `title` and
 * the id is what actually addresses the KB. Home is matched by shape rather
 * than asked for, because the browser has no business knowing `$HOME` and the
 * server has no reason to send it just so a path can be shortened.
 */
function collapse(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** The two or three most common languages, as `js/ts`. */
function langs(row: KbRow): string {
  if (!row.languages?.length) return ''
  return row.languages
    .slice(0, 3)
    .map((entry) => entry.lang.replace('javascript', 'js').replace('typescript', 'ts'))
    .join('/')
}

export function Bases() {
  const { kbs, kbsError } = useFeed()
  const [sort, setSort] = useState<Sort>('recent')

  const rows = useMemo(() => {
    if (!kbs) return []
    const list = [...kbs.kbs]
    if (sort === 'path') return list.sort((a, b) => a.path.localeCompare(b.path))
    // The server already sorted by activity; what is re-applied here is only
    // the launch project's promotion, so a reader arriving from a stale `/ui`
    // link finds the thing they expected to see at the top rather than
    // wherever its last index happened to put it.
    return list.sort((a, b) => Number(b.is_launch) - Number(a.is_launch))
  }, [kbs, sort])

  if (kbsError) return <RegistryUnreadable detail={kbsError} />
  if (!kbs) return <Centered>reading the registry…</Centered>
  if (!kbs.kbs.length && !kbs.hidden_count) return <NoBases dir={kbs.registry_dir} />

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="flex items-center gap-2 text-[15px] text-foreground">
          <Library className="size-4 text-muted-foreground" />
          knowledge bases
        </h1>
        {/* The aggregate and the order, verbatim and side by side. A list whose
            order the reader has to infer is a list they will read as a ranking. */}
        <p className="font-mono text-[11px] text-muted-foreground">
          {count(kbs.kbs.length)} knowledge base{kbs.kbs.length === 1 ? '' : 's'}
          {kbs.total_db_bytes ? ` · ${bytes(kbs.total_db_bytes)} indexed` : ''} ·{' '}
          {SORT_LABEL[sort]}
        </p>
        <button
          type="button"
          onClick={() => setSort(sort === 'recent' ? 'path' : 'recent')}
          title={`sort ${SORT_LABEL[sort === 'recent' ? 'path' : 'recent']}`}
          className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-panel-hover hover:text-foreground"
        >
          <ArrowDownUp className="size-3" />
          {sort === 'recent' ? 'by path' : 'by recency'}
        </button>
      </header>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        A knowledge base is one indexed project — <code className="font-mono">{'<project>'}/.vnodes/index.db</code>.
        Any project an agent indexes with vnodes shows up here on its own; this page never starts an
        index and never writes to one.
      </p>

      <ul className="overflow-hidden rounded border border-border">
        {rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>

      <Footer
        hidden={kbs.hidden_count}
        shown={kbs.shown ?? rows.length}
        scanned={kbs.scanned}
        capped={kbs.scan_capped}
        dir={kbs.registry_dir}
        notes={kbs.notes}
      />
    </div>
  )
}

/** Which rows are safe to click into. A gone directory has no pages to show. */
const REACHABLE: KbRow['state'][] = ['ok', 'never_completed']

function Row({ row }: { row: KbRow }) {
  const reachable = REACHABLE.includes(row.state)
  const home = row.flags.includes('home_dir')
  const fresh = row.last_indexed_ms ?? row.last_activity_ms
  /**
   * An index past the oversize thresholds is refused by the pages that would
   * have to walk it whole — `/ui/api/composition` and an unscoped `/ui/map/data`
   * both answer 413 rather than spend minutes of the daemon's single event loop
   * on it. So the chip stops being a link there. A count that offers to show
   * you what it counted and then refuses is a worse promise than a count that
   * never offered, and the title says which it is.
   */
  const oversize = row.flags.includes('oversize_files') || row.flags.includes('oversize_db')
  const chipHref = (path: string) => (reachable && !oversize ? `${path}?kb=${row.id}` : undefined)
  const chipTitle = (what: string) =>
    oversize ? `too large to break down — the daemon refuses a whole-index scan of this KB` : what

  const body = (
    <div
      className={cn(
        'flex h-16 flex-col justify-center gap-0.5 px-4 py-3 max-lg:h-14',
        reachable && 'group-hover:bg-panel-hover',
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            'shrink-0 truncate text-[13px]',
            reachable ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {home ? '~ (your home directory)' : row.name}
        </span>
        {/* Dropped when collapsing the path has produced the same string the
            name column is already showing, which is what the home row does:
            "~ (your home directory)" followed by a lone "~" reads as a
            rendering bug rather than as a path. */}
        {collapse(row.path) !== (home ? '~' : row.name) ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {collapse(row.path)}
          </span>
        ) : (
          // The path span is what pushes the badge and the timestamp to the
          // right edge, so dropping it has to leave the `flex-1` behind or the
          // one row without a path stops lining up with all the others.
          <span className="min-w-0 flex-1" />
        )}
        {row.is_launch && (
          // Muscle memory and every link vnodes has ever printed used to land
          // on this project's overview. It sorts first and says why, so a
          // reader who expected the old `/ui` is one click and one sentence
          // from it rather than looking at a list they did not ask for.
          <span className="shrink-0 rounded border border-accent px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-accent">
            this daemon's own project — what /ui used to show
          </span>
        )}
        {/* A row with no timestamp at all says so. Printing nothing would let
            "never indexed" and "the registry did not record when" look
            identical to a row that simply had nothing to show. */}
        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
          {fresh ? `indexed ${relativeTime(fresh)}` : 'no index on record'}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        {/* The health verdict, in the server's words, on every row including
            the broken ones — a KB that stopped being readable last week still
            has a last-known shape, and the block underneath says why it cannot
            be opened. The reason lives there and not here, so no row ever
            prints the same sentence twice. */}
        <span
          className={cn(
            'min-w-0 truncate',
            row.state === 'ok' && !row.flags.length ? 'text-muted-foreground' : 'text-accent',
          )}
        >
          {row.verdict}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {row.files != null && (
            <Stat
              label="files"
              value={`${count(row.files)}${langs(row) ? ` · ${langs(row)}` : ''}`}
              href={chipHref('/ui/index')}
              title={chipTitle('what is in this index, and what should not be')}
            />
          )}
          {row.notes != null && (
            <Stat
              label="notes"
              value={count(row.notes)}
              // Notes are a memory-store read and never a whole-index scan, so
              // this one stays a link even on an oversize KB.
              href={reachable ? `/ui/notes?kb=${row.id}` : undefined}
              title="cross-session memory for this knowledge base"
            />
          )}
          {row.counts_stale && (
            // The counts are a cache of the last completed index and this
            // project's `index.db` has been written since. Saying "as of last
            // index" everywhere would be noise; saying it on the rows where it
            // is actually load-bearing is the whole point.
            <span
              title="index.db has changed since these counts were taken — they are as of the last completed index"
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-muted-foreground"
            >
              as of last index
            </span>
          )}
        </span>
      </div>
    </div>
  )

  return (
    <li className="border-b border-border last:border-b-0">
      {reachable ? (
        <Link
          to={`/ui?kb=${row.id}`}
          title={`${row.path} — ${row.verdict}`}
          className="group block outline-none"
        >
          {body}
        </Link>
      ) : (
        // Not a link, and deliberately still a row. A KB whose directory is
        // gone or unreadable has no pages to open, but dropping it would make
        // the registry quietly shorter than the truth — and `unreadable` in
        // particular is usually a drive that is not plugged in.
        <div title={row.path}>{body}</div>
      )}
      {home && <HomeAccident row={row} />}
      {!reachable && <Broken row={row} />}
    </li>
  )
}

/**
 * The accident, in full.
 *
 * Somebody's agent ran a read-only vnodes tool while its working directory was
 * `$HOME`, and `ensureIndexed` did what its name says. Nobody was ever told.
 * This block exists so that stops being true: every one of its pathology
 * signals is named on the page, and the two lines that end it are lines the
 * reader runs, because vnodes deleting half a million rows of somebody's data
 * on their behalf is not a thing this project is willing to do — which is also
 * why the registry does not live inside `~/.vnodes` and survives the `rm`.
 */
function HomeAccident({ row }: { row: KbRow }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-accent-dim/10 px-4 py-3">
      <p className="flex items-start gap-2 text-[12px] leading-relaxed text-foreground">
        <Home className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <span>
          {row.state_detail ||
            'indexed once by an agent standing in $HOME; the run did not finish'}
          . Nothing reads it and no agent asked for it. vnodes will not remove it for you — an
          index this size is somebody's data whatever it was made by accident, and deleting it on
          their behalf is not a decision this page gets to make.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Copyable text="rm -rf ~/.vnodes" />
        <span className="text-[11px] text-muted-foreground">
          removes the index itself — the registry lives elsewhere and survives it
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Copyable text={row.hide_command} />
        <span className="text-[11px] text-muted-foreground">
          keeps it on disk and off this list; the count below still says one is hidden
        </span>
      </div>
    </div>
  )
}

/** A row that cannot be opened, and the line that would take it off the list. */
function Broken({ row }: { row: KbRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
      <AlertTriangle className="size-3.5 shrink-0 text-accent" />
      <span className="text-[11px] text-muted-foreground">
        {row.state_detail ||
          (row.state === 'unreadable'
            ? 'this path could not be read — an unmounted volume or a permission, not necessarily a deleted project'
            : row.state === 'missing'
              ? 'the project directory is gone'
              : 'the project is there but its .vnodes/index.db is not')}
        {row.state === 'unreadable'
          ? ' · nothing here has been deleted as far as this page can tell'
          : ''}
      </span>
      {/* The line that takes it off the list, and only that. Nothing on this
          page re-indexes, re-creates or deletes anything. */}
      <Copyable text={row.forget_command} className="ml-auto" />
    </div>
  )
}

function Footer({
  hidden,
  shown,
  scanned,
  capped,
  dir,
  notes,
}: {
  hidden: number
  shown: number
  scanned: number
  capped: boolean
  dir: string
  notes?: string[]
}) {
  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {/* Hiding is not omission. A hidden KB is still counted here, with the
          command that brings it back, because a list that silently shortened
          itself would be the exact failure this project refuses everywhere. */}
      <p>
        {hidden > 0
          ? `${count(hidden)} hidden knowledge base${hidden === 1 ? '' : 's'} not listed above — vnodes kb show <id> puts one back.`
          : 'nothing is hidden — every registry entry is listed above.'}
      </p>
      {capped && (
        <p className="text-accent">
          the registry scan stopped at {count(scanned)} entries and {count(shown)} are drawn; there
          may be more on disk than this page can see.
        </p>
      )}
      {notes?.map((note) => (
        <p key={note}>{note}</p>
      ))}
      <p className="font-mono break-all">registry: {dir}</p>
    </div>
  )
}

/**
 * No knowledge bases at all — which is what a brand new machine looks like, and
 * therefore the state most likely to be read by somebody deciding whether this
 * thing works.
 */
function NoBases({ dir }: { dir: string }) {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">no knowledge bases yet</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        A knowledge base is one indexed project — a{' '}
        <code className="font-mono">.vnodes/index.db</code> inside it. Index one and it appears
        here:
      </p>
      <p className="mt-3 flex justify-center">
        <Copyable text="cd <project> && vnodes index" />
      </p>
      <p className="mt-3 text-[13px] text-muted-foreground">
        Any project an agent indexes with vnodes shows up here on its own — nothing has to register
        it by hand.
      </p>
      <p className="mt-3 font-mono text-[11px] break-all text-muted-foreground">registry: {dir}</p>
    </Centered>
  )
}

/**
 * The registry could not be read. Usually one specific, benign thing: a daemon
 * built before any of this existed, whose `/ui` catch-all answers `/ui/api/kbs`
 * with its list of the four routes it does have.
 */
function RegistryUnreadable({ detail }: { detail: string }) {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">the registry could not be read</p>
      <p className="font-mono text-[12px] break-all text-muted-foreground">{detail}</p>
      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        This page lists what <code className="font-mono">~/.config/vnodes/registry</code> knows
        about. A daemon older than that directory does not serve{' '}
        <code className="font-mono">/ui/api/kbs</code> at all — the other pages still work, and they
        show the project this daemon was started in.
      </p>
    </Centered>
  )
}
