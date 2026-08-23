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
 */
import { Component, Suspense, useEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Centered } from './Centered'
import { Rail } from './Rail'
import { Link, useRoute } from './route'
import { PLAIN_STATUS, VIEWS } from './routes'
import { StatusFeed } from './status'
import { fetchTools } from './api'

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
  // `/` only happens under `npm run dev`; the daemon serves the bundle at /ui.
  const wanted = path === '/' ? '/ui' : path
  const view = VIEWS.find((candidate) => candidate.path === wanted)

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {view && <ToolNotice tool={view.tool} />}
      <div className="relative min-h-0 flex-1">
        {!view ? (
          <Document>
            <NoSuchPage path={path} />
          </Document>
        ) : view.canvas ? (
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
      </div>
    </main>
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
