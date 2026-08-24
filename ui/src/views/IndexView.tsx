/**
 * What is actually in the index.
 *
 * This is the panel that would have caught the thing nothing caught: 181 of
 * this repo's 232 indexed files are a headless-Chrome profile that the repo's
 * own screenshot script wrote into `ui/.shots/`, and both `/status` and
 * `vnodes doctor` call that index healthy — because it is healthy. It is a
 * correct index of the wrong files, and every capsule built from it spends a
 * quarter of its budget on a WASM blob.
 *
 * The largest-file list is sorted by BYTES rather than by symbol count, because
 * bytes are where token cost comes from: a minified bundle with four symbols in
 * it will never appear at the top of a symbol ranking and is exactly the file
 * you want to find.
 *
 * Every remedy on this page is a `.vnodesignore` line rendered as text. There
 * is no button that applies one and there will not be: the UI is read-only, so
 * it diagnoses and the operator applies. That is not a limitation to work
 * around — it is what makes the page safe to leave open.
 */
import { useEffect, useState } from 'react'
import { Microbar, StackedBar, rampColor } from '../shell/Bar'
import type { Segment } from '../shell/Bar'
import { Centered } from '../shell/Centered'
import { Copyable } from '../shell/Copyable'
import { Stat } from '../shell/Stat'
import { Link } from '../shell/route'
import { fetchComposition, rowPath } from '../shell/api'
import type { Composition } from '../shell/api'
import { useFeed } from '../shell/status'
import { useKb } from '../shell/kb'

const bytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : value >= 1024
      ? `${Math.round(value / 1024)} KB`
      : `${value} B`

export function IndexView() {
  const { status } = useFeed()
  const kb = useKb()
  const [composition, setComposition] = useState<Composition | null>(null)
  const [error, setError] = useState('')

  // Refetched when the index generation moves, not on a clock: this is a scan
  // over every file row, and it cannot change while the index does not.
  useEffect(() => {
    let live = true
    setError('')
    fetchComposition()
      .then((next) => live && setComposition(next))
      .catch((cause: Error) => live && setError(cause.message))
    return () => {
      live = false
    }
  }, [kb, status?.index.last_index])

  if (error) {
    return (
      <Centered>
        <p className="mb-1 text-[15px]">no composition</p>
        <p className="font-mono text-[12px] break-all text-muted-foreground">{error}</p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          This page needs <code>/ui/api/composition</code>. The counts on{' '}
          <Link to="/ui" className="text-accent hover:underline">
            status
          </Link>{' '}
          come from <code>/status</code> and are unaffected.
        </p>
      </Centered>
    )
  }

  if (!composition) return <p className="text-[13px] text-muted-foreground">reading the index…</p>

  const dirs = composition.by_dir ?? []
  const widest = dirs.reduce((most, row) => Math.max(most, row.files), 0)

  /**
   * One colour per language across the whole page, ranked by total file count.
   * Colouring each row by its own rank was the obvious thing and it was wrong:
   * blue meant typescript on the `ui/src` bar and javascript on the `src` bar
   * directly under it, so the bars could not be compared to each other at all —
   * which is the only reason to draw them side by side.
   */
  const langTotals = new Map<string, number>()
  for (const dir of dirs) {
    for (const [lang, count] of Object.entries(dir.langs ?? {})) {
      langTotals.set(lang, (langTotals.get(lang) ?? 0) + count)
    }
  }
  const ranked = [...langTotals].sort((a, b) => b[1] - a[1])
  const langColor = new Map(ranked.map(([lang], position) => [lang, rampColor(position)]))
  const dominant = dirs[0]
  const share =
    dominant && composition.total_files > 0 ? dominant.files / composition.total_files : 0
  const suggestions = composition.ignore_suggestion ?? []

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-[17px]">index</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          What the indexer walked, sorted by how much of your token budget it can cost.
        </p>
      </header>

      <p className="text-[14px] leading-relaxed">
        <b>{composition.total_files.toLocaleString()} files</b>, {bytes(composition.total_bytes ?? 0)}
        {dominant && (
          <>
            {' — '}
            <b className={share >= 0.4 ? 'text-accent' : undefined}>
              {Math.round(share * 100)}% of them under {dominant.dir}
            </b>
          </>
        )}
        . A file in the index is a file a capsule can spend tokens on, whether or not you wrote it.
      </p>

      <ul className="flex flex-wrap items-center gap-1.5">
        <li>
          <Stat label="files" value={composition.total_files} />
        </li>
        <li>
          <Stat label="directories" value={composition.by_dir_total ?? dirs.length} />
        </li>
        <li>
          <Stat label="no symbols" value={composition.no_symbols_total ?? 0} />
        </li>
        <li>
          <Stat label="no edges" value={composition.no_edges_total ?? 0} />
        </li>
      </ul>

      <section>
        <H2>
          directories — {composition.by_dir_shown ?? dirs.length} shown of{' '}
          {composition.by_dir_total ?? dirs.length}
        </H2>
        {/* The key for every bar below, once. Same table the bars read from. */}
        <ul className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
          {ranked.map(([lang, count]) => (
            <li key={lang} className="flex items-center gap-1.5">
              <span
                aria-hidden
                style={{ background: langColor.get(lang) }}
                className="inline-block size-2 rounded-[2px]"
              />
              {lang}
              <b className="text-foreground">{count}</b>
            </li>
          ))}
        </ul>
        <ul className="flex flex-col gap-2">
          {dirs.map((dir) => {
            const langs = Object.entries(dir.langs ?? {}).sort((a, b) => b[1] - a[1])
            const segments: Segment[] = langs.map(([lang, count]) => ({
              key: lang,
              label: lang,
              value: count,
              color: langColor.get(lang) ?? 'var(--group-0)',
            }))
            return (
              <li key={dir.dir} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <Link
                    to={`/ui/map?path=${encodeURIComponent(dir.dir)}`}
                    title={`draw only ${dir.dir}`}
                    className="min-w-0 flex-1 truncate font-mono text-[12px] hover:text-accent hover:underline"
                  >
                    {dir.dir}
                  </Link>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {dir.files.toLocaleString()} files · {bytes(dir.bytes ?? 0)}
                    {dir.inert_files ? ` · ${dir.inert_files} inert` : ''}
                  </span>
                  {/* The chip copies one line. Applying it is the operator's.
                      `(root)` is not a directory — it is the files that live at
                      the repo root — so there is no ignore line to offer for it,
                      the same rule the map's toolbar already applies. */}
                  {dir.dir !== '(root)' && <Copyable text={`${dir.dir}/`} className="shrink-0" />}
                </div>
                {/* Width against the biggest directory, so the bars compare to
                    each other rather than each filling its own row. */}
                <div style={{ width: `${widest > 0 ? (dir.files / widest) * 100 : 0}%` }}>
                  <StackedBar segments={segments} total={dir.files} />
                </div>
              </li>
            )
          })}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          Each chip copies one <code>.vnodesignore</code> line. Paste the ones you mean into that
          file and run <Copyable text="vnodes reindex" /> — nothing on this page writes.
        </p>
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-muted-foreground">the daemon suggests:</span>
            {suggestions.map((line) => (
              <Copyable key={line} text={line} />
            ))}
          </div>
        )}
      </section>

      <section>
        <H2>largest files — by bytes</H2>
        <ul className="flex flex-col">
          {(composition.largest ?? []).map((row) => (
            <li key={row.path} className="flex items-center gap-3 border-b border-border py-1.5 last:border-b-0">
              <Link
                to={`/ui/map?target=${encodeURIComponent(row.path)}`}
                title={`draw the map around ${row.path}`}
                className="min-w-0 flex-1 truncate font-mono text-[12px] hover:text-accent hover:underline"
              >
                {row.path}
              </Link>
              <span className="w-20 shrink-0">
                <Microbar
                  share={composition.largest[0]?.size ? row.size / composition.largest[0].size : 0}
                />
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {bytes(row.size)}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {row.symbols} sym
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        <FileList
          title="parsed to zero symbols"
          why="Indexed, walked, and it yielded nothing a skeleton could be built from — data, minified output, or a language the parser does not read."
          rows={(composition.no_symbols ?? []).map((row) => ({ file: rowPath(row), note: '' }))}
          shown={(composition.no_symbols ?? []).length}
          total={composition.no_symbols_total ?? 0}
        />
        <FileList
          title="no edges either way"
          why="Nothing imports it and it imports nothing indexed. The map marks these isolated, but only inside the slice it draws — this list is the whole index."
          rows={(composition.no_edges ?? []).map((row) => ({ file: rowPath(row), note: '' }))}
          shown={(composition.no_edges ?? []).length}
          total={composition.no_edges_total ?? 0}
        />
      </div>

      <Excluded excluded={composition.excluded} />

      <footer className="border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
        Every list here is a slice and says what it is a slice of. Symbol and edge counts come from
        the same store the{' '}
        <Link to="/ui/map" className="text-accent hover:underline">
          map
        </Link>{' '}
        draws from, so a file missing here is a file the map cannot draw either.
      </footer>
    </div>
  )
}

function FileList({
  title,
  why,
  rows,
  shown,
  total,
}: {
  title: string
  why: string
  rows: { file: string; note: string }[]
  shown: number
  total: number
}) {
  return (
    <section>
      <H2>
        {title} — {shown} shown of {total}
      </H2>
      <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">{why}</p>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">none.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.file}
              className="flex items-baseline gap-2 border-b border-border py-1 last:border-b-0"
            >
              <Link
                to={`/ui/map?target=${encodeURIComponent(row.file)}`}
                className="min-w-0 flex-1 truncate font-mono text-[11px] hover:text-accent hover:underline"
              >
                {row.file}
              </Link>
              {row.note && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {row.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">{children}</h2>
  )
}


/**
 * What the index left out, and which rule file left it out.
 *
 * The counterpart to everything above it: a page that answers "what is in here"
 * is not finished until it answers "and what is not". This is the view of the
 * decision that once let 181 files of browser cache become 78% of an index
 * while every status check reported healthy — the ignore line that fixed it took
 * a minute, and the two commits it went unnoticed for were the expensive part.
 *
 * Each row names the rule FILE, not just that a rule exists: someone who
 * disagrees with an exclusion needs to know which file to edit.
 */
function Excluded({ excluded }: { excluded: Composition['excluded'] }) {
  if (!excluded) {
    return (
      <section className="border-t border-border pt-4">
        <h2 className="mb-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">excluded</h2>
        <p className="text-[13px] text-muted-foreground">
          This daemon did not report what it excluded. That is not the same as nothing being
          excluded — it means this page cannot say.
        </p>
      </section>
    )
  }
  if (excluded.error) {
    return (
      <section className="border-t border-border pt-4">
        <h2 className="mb-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">excluded</h2>
        <p className="text-[13px] text-muted-foreground">
          Reading the ignore rules failed: <code>{excluded.error}</code>
        </p>
      </section>
    )
  }

  const subtrees = excluded.subtrees ?? []
  const files = excluded.files ?? []
  const bySource = Object.entries(excluded.by_source ?? {}).sort((a, b) => b[1] - a[1])

  return (
    <section className="border-t border-border pt-4">
      <h2 className="mb-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">
        excluded — on disk, not in the index
      </h2>
      <p className="mb-3 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
        Nothing here is in any capsule, any impact query or any answer an agent gives, on any
        provider. Each row names the rule file that decided it, so a disagreement has somewhere to
        go.
      </p>

      {bySource.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {bySource.map(([source, count]) => (
            <span
              key={source}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {source} <b className="text-foreground">{count}</b>
            </span>
          ))}
        </div>
      )}

      {subtrees.length + files.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Nothing on disk is excluded. Every file the parser recognises is indexed.
        </p>
      ) : (
        <ul className="flex flex-col">
          {[...subtrees, ...files].map((row) => (
            <li
              key={row.path}
              className="flex items-baseline gap-3 border-b border-border py-1.5 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{row.path}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {row.source}
                {row.pattern && (
                  <span className="opacity-70">
                    {' · '}
                    {row.pattern}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {excluded.truncated && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          The walk stopped at its entry budget, so this list is partial — and says so rather than
          reading as complete.
        </p>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        An excluded directory is named once and not walked into. Counting every file under{' '}
        <code>node_modules</code> costs more than the answer is worth.
      </p>
    </section>
  )
}
