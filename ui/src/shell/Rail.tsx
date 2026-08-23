/**
 * The left rail — from nodekit's `src/kit/components/LeftRail.tsx`.
 *
 * vnodes has had no navigation of any kind: the only link off `/ui` was a
 * single `<a href="/ui/map">` inside a template string, and nothing anywhere
 * led back. So what is kept from the kit is the whole navigational idea, plus
 * the details that make it read as one control — the flex column, the `flex-1`
 * spacer that pushes state to the bottom, the square button with its active
 * fill, and the status dot ringed in the rail's own colour so it reads as a
 * badge on the icon rather than a stray pixel beside it.
 *
 * What is dropped is everything that assumed the kit's app: the registry the
 * buttons came from, the credential list (there are no credentials — nothing
 * here leaves the machine), the import button (it writes), the theme cycler
 * (it needs a JS theme store that `theme.css` deliberately does not have — see
 * its header), and the tooltip component, which needs a provider at the root
 * and its own keyframes to replace a `title` that is already reachable by
 * keyboard and by a screen reader.
 *
 * The one deliberate divergence is geometry: the kit floats its rail over the
 * canvas at `absolute left-3`, and this one is a static 72px column. That is
 * what keeps every absolute coordinate already inside the map — the toolbar's
 * `left-3`, the zoom column's `!left-3`, the minimap's `!right-3`, the notice
 * stack's `left-[56px]`, `fitPad`'s `left: 50` — correct with no arithmetic,
 * and it gives the four document pages a normal scrolling column instead of a
 * page that has to pretend it is a canvas.
 */
import { ChevronsUpDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../kit/utils'
import { useKb } from './kb'
import { Link, useRoute } from './route'
import { PAGE_VIEWS, PICKER, PLAIN_STATUS, VIEWS } from './routes'
import { useFeed } from './status'

export function Rail() {
  const { path } = useRoute()
  const kb = useKb()
  const { status, statusError } = useFeed()

  const state = status?.index.state ?? ''
  // Anything that is not a ready index is a red dot. "starting", "missing" and
  // "the daemon did not answer" are different sentences in the title, but they
  // are the same fact to a reader deciding whether to trust the numbers.
  const healthy = state === 'ready'
  const health = statusError
    ? `daemon unreachable — ${statusError}`
    : state
      ? `index: ${state}`
      : 'index: asking…'

  return (
    // A <nav>, not an <aside>: this is the page's navigation, and it was the
    // only route between the five pages while announcing itself as a
    // complementary region. It also left the document with no navigation
    // landmark at all, so a screen-reader user had nothing to jump to.
    <nav
      aria-label="vnodes sections"
      className="flex w-[72px] shrink-0 flex-col items-center gap-1 border-r border-border bg-rail py-3 max-lg:w-[52px]"
    >
      <Switcher kb={kb} />

      {PAGE_VIEWS.map((view) => (
        <RailLink
          key={view.path}
          // Built explicitly rather than left to the router's normalizer. Both
          // produce the same string, but this is the one place where being able
          // to read the rendered href and see the project in it is the whole
          // reason the parameter exists — and a normalizer is a thing that can
          // be changed by somebody who never opened this file.
          to={view.path + (kb ? `?kb=${kb}` : '')}
          icon={view.icon}
          label={view.label}
          hint={view.hint}
          // `/ui` is a prefix of every other page, so it can only match whole.
          // Pathname only: a page is the same page whichever KB it is showing.
          // The one extra condition is that bare `/ui` with no KB draws the
          // picker, so lighting `status` there would point at a page that is
          // not on screen.
          active={view.path === '/ui' ? path === '/ui' && Boolean(kb) : path.startsWith(view.path)}
        />
      ))}

      <div className="flex-1" />

      {/* The floor. It is plain HTML with an inline script, so it is the page
          that still answers when this bundle is missing or throws — which is
          exactly when a reader most needs to know whether the index is ready.
          A real anchor, not a Link: leaving the app is the point. */}
      <RailLink
        to={PLAIN_STATUS}
        external
        icon={VIEWS[0].icon}
        label="plain"
        // It reports on the daemon's launch project and only ever that one, so
        // it says which. Now that the page beside it can be scoped to a
        // different KB, a hint reading "the status page" would leave a reader
        // with two sets of numbers and no way to know they are about two
        // different projects.
        hint={`${health} · the no-JavaScript status page for ${status?.project ?? "this daemon's own project"}`}
        status={healthy ? 'ok' : 'missing'}
      />
    </nav>
  )
}

/**
 * Which knowledge base is open, and the way out of it.
 *
 * This slot held a decorative dot on a white square. It sits at the top of the
 * navigation column, which is exactly where "what am I looking at" belongs —
 * and the failure being corrected here is that this question had no answer
 * anywhere on screen. So it is the name of the open KB over a control that
 * goes to the picker.
 *
 * With no `kb` in the URL the daemon's launch project is what every page is
 * showing, and it is labelled as that rather than dressed up as a choice: a
 * reader who never picked anything should not be shown a name that implies they
 * did. Below 1024px the rail is 52px and every caption in it is hidden, so the
 * name goes too and the `title` carries it.
 */
function Switcher({ kb }: { kb: string }) {
  const { status, kbs } = useFeed()
  const open = kb ? kbs?.kbs.find((row) => row.id === kb) : undefined
  const launchPath = status?.project ?? ''

  const name = open
    ? open.name
    : kb
      ? kb
      : launchPath
        ? launchPath.split('/').filter(Boolean).pop() || launchPath
        : 'no project'

  const detail = open
    ? open.path
    : kb
      ? 'the registry does not list this id'
      : launchPath || 'this daemon was started without a project'

  return (
    <Link
      to={PICKER}
      title={`${name} — ${detail} · switch knowledge base`}
      className="group mb-3 flex w-full flex-col items-center gap-0.5 outline-none"
    >
      <span className="sr-only">switch knowledge base — currently {name}</span>
      <span className="max-w-[64px] truncate text-[9px] leading-none text-foreground max-lg:hidden">
        {name}
      </span>
      {!open && !kb && (
        // Not a chosen KB. Saying so costs one line and stops the rail from
        // implying a selection the reader never made.
        <span className="max-w-[64px] truncate text-[8px] leading-none text-muted-foreground max-lg:hidden">
          this daemon's project
        </span>
      )}
      <span className="flex size-6 items-center justify-center rounded-md text-muted-foreground group-hover:bg-panel-hover group-hover:text-foreground">
        <ChevronsUpDown className="size-3.5" />
      </span>
    </Link>
  )
}

function RailLink({
  to,
  icon: Icon,
  label,
  hint,
  active,
  status,
  external,
}: {
  to: string
  icon: LucideIcon
  label: string
  hint: string
  active?: boolean
  status?: 'ok' | 'missing'
  external?: boolean
}) {
  const body = (
    <>
      <span
        className={cn(
          'relative flex size-9 items-center justify-center rounded-md transition-colors duration-150',
          active
            ? 'bg-panel-hover text-foreground'
            : 'text-muted-foreground group-hover:bg-panel-hover group-hover:text-foreground',
        )}
      >
        <Icon className="size-[18px]" />
        {status && (
          <span
            className={cn(
              'absolute right-1.5 bottom-1.5 size-1.5 rounded-full ring-2 ring-rail',
              status === 'ok' ? 'bg-emerald-400' : 'bg-red-500',
            )}
          />
        )}
      </span>
      {/* Hidden rather than shrunk below 1024px: a 9px caption that has to
          truncate says less than the icon it sits under already did. */}
      <span
        className={cn(
          'text-[9px] leading-none max-lg:hidden',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </>
  )

  const className = 'group flex w-full flex-col items-center gap-1 outline-none'
  if (external) {
    return (
      <a href={to} title={hint} aria-label={hint} className={className}>
        {body}
      </a>
    )
  }
  return (
    <Link to={to} title={hint} className={className}>
      {/* aria-label belongs on the anchor; Link forwards title only, so the
          hint is repeated here as text a screen reader can reach. */}
      <span className="sr-only">{hint}</span>
      {body}
    </Link>
  )
}
