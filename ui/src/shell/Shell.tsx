/**
 * The application. One rail, one main column, five pages.
 *
 * Everything under `/ui` now lands here rather than on four unrelated
 * documents, which is the whole point of the migration: the map was already a
 * React page and everything else was a `<dl>` of counts polling `/status`, so
 * the operator's picture of their own index was split across two centuries of
 * web design with no link between them.
 *
 * Two of this file's jobs are invariants rather than layout.
 *
 * The map is behind `lazy()`, and a `lazy()` whose import rejects renders
 * nothing at all — a blank page where a canvas should be, which is silent
 * omission in its purest form. So the boundary below names the file that failed
 * and the command that rebuilds it.
 *
 * And the pages report numbers that agents reach through MCP tools. If the
 * daemon has stopped exposing one of those tools, the page is still correct and
 * the agents are still broken, and only the page can say so.
 *
 * The third job is new, and it is the reason `?kb=` can be trusted. Every one
 * of the five pages is scoped to one knowledge base, and not one of them knows
 * what a knowledge base is: the guard below decides, once, whether the `kb` in
 * the URL names something that exists, and a view that would have drawn the
 * wrong project's numbers never mounts. It must not fall back to the launch
 * project when the id does not resolve. A 200 drawn from a different project
 * under the sender's URL is a wrong page that looks right — the same failure
 * `src/daemon.js` already closed once for pathnames, arriving a second time
 * through a query parameter.
 */
import { Component, Suspense, useEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, Library } from 'lucide-react'
import { Centered } from './Centered'
import { Rail } from './Rail'
import { Link, useRoute } from './route'
import { PICKER, PLAIN_STATUS, VIEWS } from './routes'
import { StatusFeed, useFeed } from './status'
import { fetchTools } from './api'
import { useKb } from './kb'

export function Shell() {
  return (
    <StatusFeed>
      <div className="flex h-full w-full overflow-hidden">
        <Rail />
        <Main />
      </div>
    </StatusFeed>
  )
}

function Main() {
  const { path } = useRoute()
  const kb = useKb()
  const { kbsError } = useFeed()
  // `/` only happens under `npm run dev`; the daemon serves the bundle at /ui.
  const requested = path === '/' ? '/ui' : path
  /**
   * Bare `/ui` is the picker now.
   *
   * Resolved here rather than by a redirect, because a `replaceState` would
   * rewrite the address bar out from under a reader who typed `/ui`, and every
   * link vnodes has ever printed points at that exact string. The URL stays
   * what they asked for; only what is drawn under it changes, and the picker's
   * first row says in words what used to be there.
   *
   * Not when the registry cannot be read at all, though. A daemon older than
   * `/ui/api/kbs` serves exactly one project and has nothing to pick between,
   * so turning its front page into a list that cannot be built would replace a
   * working overview with an error — and `/ui` is the URL `bin/vnodes.js` has
   * printed since the first milestone. There is nothing to choose, so the
   * choice is not offered; `/ui/bases` still explains itself to anyone who asks
   * for it by name.
   */
  const wanted = requested === '/ui' && !kb && !kbsError ? PICKER : requested
  const view = VIEWS.find((candidate) => candidate.path === wanted)
  const scoped = Boolean(view) && wanted !== PICKER

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {view && <ToolNotice tool={view.tool} />}
      <div className="relative min-h-0 flex-1">
        {!view ? (
          <Document>
            <NoSuchPage path={path} />
          </Document>
        ) : (
          <KbGuard scoped={scoped} kb={kb}>
            {view.canvas ? (
              // The canvas owns its box and does not scroll: React Flow pans.
              <div className="map-surface h-full w-full">
                <MapBoundary>
                  <Suspense fallback={<Centered>drawing…</Centered>}>
                    <view.element />
                  </Suspense>
                </MapBoundary>
              </div>
            ) : (
              <Document>
                <view.element />
              </Document>
            )}
          </KbGuard>
        )}
      </div>
    </main>
  )
}

/**
 * One gate in front of the five scoped pages, so no view ever learns what a
 * knowledge base is.
 *
 * Three outcomes, and the ordering between them matters.
 *
 * A `kb` in the URL that the registry does not list is refused outright — the
 * view does not mount, does not fetch, and does not draw a graph. That is the
 * whole point: the failure this closes is a link from another machine, whose
 * ids are different, rendering as somebody else's project under a URL that
 * looks like it worked.
 *
 * A daemon in hub mode with no `kb` in the URL has no project to be scoped to
 * at all, so the page says so and points at the picker rather than showing five
 * empty panels and letting the reader conclude their index is broken.
 *
 * And a registry that cannot be read at all decides nothing. A daemon older
 * than `/ui/api/kbs` answers it with an api index, which is not evidence about
 * any particular id — so the guard steps aside and the page behaves exactly as
 * it did before the registry existed.
 */
function KbGuard({ scoped, kb, children }: { scoped: boolean; kb: string; children: ReactNode }) {
  const { kbs, kbsError } = useFeed()

  if (!scoped || kbsError) return <>{children}</>

  if (kb) {
    // Still in flight. Rendering the view now and pulling it back a moment
    // later would open an EventSource against a KB that may not exist and
    // flash a graph the reader is about to be told is the wrong one.
    if (!kbs) return <Centered>checking which knowledge base that is…</Centered>
    if (!kbs.kbs.some((row) => row.id === kb)) return <UnknownKb id={kb} />
    return <>{children}</>
  }

  if (kbs?.hub) return <HubHasNoProject />
  return <>{children}</>
}

function UnknownKb({ id }: { id: string }) {
  const { kbs } = useFeed()
  return (
    <Centered>
      <p className="mb-1 text-[15px]">no knowledge base with that id</p>
      <p className="font-mono text-[12px] break-all text-muted-foreground">{id}</p>
      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        A <code className="font-mono">?kb=</code> is a key in this machine's registry, not a path,
        and every machine derives its own. This is what a link from somebody else's laptop looks
        like here — the project it names may well be on this disk under a different id.
      </p>
      {kbs && kbs.kbs.length > 0 && (
        <ul className="mt-4 flex flex-col items-center gap-1 text-[13px]">
          {kbs.kbs.slice(0, 8).map((row) => (
            <li key={row.id}>
              <Link to={`/ui?kb=${row.id}`} className="text-accent hover:underline">
                {row.name}
              </Link>{' '}
              <span className="font-mono text-[11px] text-muted-foreground">{row.path}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[13px]">
        <Link to={PICKER} className="text-accent hover:underline">
          every knowledge base on this machine →
        </Link>
      </p>
    </Centered>
  )
}

function HubHasNoProject() {
  return (
    <Centered>
      <Library className="mx-auto mb-2 size-5 text-muted-foreground" />
      <p className="mb-1 text-[15px]">this daemon serves the registry and no project of its own</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        It was started without a launch project, so there is nothing for this page to be about until
        one is named. Every page here works once a knowledge base is chosen.
      </p>
      <p className="mt-3 text-[13px]">
        <Link to={PICKER} className="text-accent hover:underline">
          pick one →
        </Link>
      </p>
    </Centered>
  )
}

/**
 * The reading column. 880px because these pages are prose and tables of file
 * paths, and a path list set 1500px wide is a list nobody's eye can walk back
 * to the start of.
 */
function Document({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[880px] px-6 py-6">{children}</div>
    </div>
  )
}

/**
 * Fifteen lines instead of a registry seam. `/tools` is fetched once; a view
 * whose backing tool is missing from that list gets a named notice, because a
 * page that keeps rendering perfect numbers while the agents that need them get
 * a "no such tool" is the most expensive kind of quiet.
 */
function ToolNotice({ tool }: { tool?: string }) {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!tool) return
    let live = true
    fetchTools()
      .then((next) => live && setMissing(!next.tools.some((row) => row.name === tool)))
      // A `/tools` that cannot be read says nothing about any one tool, and
      // guessing here would be a false alarm on every page at once.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [tool])

  if (!tool || !missing) return null
  return (
    <p className="flex items-start gap-2 border-b border-border bg-accent-dim/10 px-4 py-2 text-[12px] text-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-accent" />
      <span>
        This page reads what <code className="font-mono">{tool}</code> returns, and the daemon is not
        exposing that tool. What is drawn below is still true; an agent asking for it is not getting
        an answer.
      </span>
    </p>
  )
}

function NoSuchPage({ path }: { path: string }) {
  return (
    <Centered>
      <p className="mb-1 text-[15px]">no such page</p>
      <p className="font-mono text-[12px] break-all text-muted-foreground">{path}</p>
      <ul className="mt-4 flex flex-col items-center gap-1 text-[13px]">
        {VIEWS.map((view) => (
          <li key={view.path}>
            <Link to={view.path} className="text-accent hover:underline">
              {view.path}
            </Link>{' '}
            <span className="text-muted-foreground">— {view.hint}</span>
          </li>
        ))}
        <li>
          <a href={PLAIN_STATUS} className="text-accent hover:underline">
            {PLAIN_STATUS}
          </a>{' '}
          <span className="text-muted-foreground">— the plain page, no JavaScript</span>
        </li>
      </ul>
    </Centered>
  )
}

/**
 * Why a class: `Suspense` catches the wait, not the failure. If the chunk 404s
 * — a bundle rebuilt without being committed, a stale `src/view/static` — the
 * rejection lands as a render error and React unmounts the tree to a blank
 * page unless something is here to catch it.
 */
class MapBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: '' }

  static getDerivedStateFromError(error: Error) {
    return { message: error.message }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on the console as well as on the page: `ui/scripts/shot.mjs` reports
    // the console alongside every screenshot, so a failure that is drawn is
    // also a failure the screenshot harness prints.
    console.error('vnodes map failed to load', error, info.componentStack)
  }

  render() {
    if (!this.state.message) return this.props.children
    return (
      <Centered>
        <p className="mb-1 text-[15px]">the map did not load</p>
        <p className="font-mono text-[12px] break-all text-muted-foreground">
          {this.state.message}
        </p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          The canvas is a separate chunk — <code>src/view/static/map-App.js</code>. If it is missing
          or stale, rebuild the committed bundle with <code>cd ui && npm run build</code>.
        </p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          The other pages do not need it: <Link to="/ui" className="text-accent hover:underline">
            status
          </Link>{' '}
          still works.
        </p>
      </Centered>
    )
  }
}
