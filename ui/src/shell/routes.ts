/**
 * The six pages, as an array.
 *
 * nodekit registers its verticals through a registry — 496 lines of contracts
 * across fourteen seams — so that a vertical can be deleted or contributed
 * without the shell knowing about it. That is the right shape for a template
 * other people build on. It is the wrong shape here: these four verticals *are*
 * vnodes, no third-party vertical can exist (zero runtime dependencies, a
 * committed bundle, no plugin path), and thirteen of the fourteen seams would
 * ship with nothing consuming them — the exact failure nodekit's own
 * ARCHITECTURE.md records having made once already. A four-field record with
 * five instances is an array literal. The day a view arrives from outside
 * `ui/src`, this becomes a registry and not a day sooner.
 *
 * It is six now, and the sixth is the picker. The path literals in this array
 * are one half of a bijection `test/ui-readonly.test.js` asserts against
 * `PAGES` in `src/view/shell.js`, matched by a regex that allows one lowercase
 * segment under `/ui` — which is the mechanism that made `?kb=` a query
 * parameter and not a path segment, and the reason `/ui/bases` is spelled the
 * way it is.
 */
import { lazy } from 'react'
import { Database, Gauge, Layers, Library, Network, NotebookPen } from 'lucide-react'
import type { ElementType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bases } from '../views/Bases'
import { Overview } from '../views/Overview'
import { CapsuleView } from '../views/Capsule'
import { NotesView } from '../views/Notes'
import { IndexView } from '../views/IndexView'

/**
 * The map, and the only `lazy()` in the app. React Flow is about half of the
 * built bytes and exactly one of these five pages draws with it; splitting it
 * out means editing a status page no longer rewrites React Flow into the git
 * history of a committed bundle.
 */
const MapView = lazy(() => import('../map/App').then((module) => ({ default: module.App })))

export type View = {
  path: string
  /** The rail's caption. Two syllables where possible; it sits under a 18px icon. */
  label: string
  /** The `title`, which is also the accessible name. A sentence, not a repeat. */
  hint: string
  icon: LucideIcon
  element: ElementType
  /**
   * The MCP tool this view's data ultimately comes from. The page does not call
   * it — `/ui/api/*` reaches the same functions without writing an observation
   * row — but if the daemon has stopped exposing it, the numbers on the page
   * are coming from somewhere the agents cannot reach, and the shell says so.
   */
  tool?: string
  /** The map owns the viewport; the documents scroll inside a column. */
  canvas?: boolean
}

export const VIEWS: View[] = [
  {
    path: '/ui/bases',
    label: 'bases',
    hint: 'every knowledge base on this machine',
    icon: Library,
    element: Bases,
  },
  {
    path: '/ui',
    label: 'status',
    hint: 'index state, doctor checks and the log tails',
    icon: Gauge,
    element: Overview,
    tool: 'index_status',
  },
  {
    path: '/ui/map',
    label: 'map',
    hint: 'the dependency graph, laid out by the daemon',
    icon: Network,
    element: MapView,
    canvas: true,
  },
  {
    path: '/ui/capsule',
    label: 'capsule',
    hint: 'what an agent would actually be handed for a task',
    icon: Layers,
    element: CapsuleView,
    tool: 'get_context_capsule',
  },
  {
    path: '/ui/notes',
    label: 'notes',
    hint: 'cross-session memory, stale rows first',
    icon: NotebookPen,
    element: NotesView,
    tool: 'search_memory',
  },
  {
    path: '/ui/index',
    label: 'index',
    hint: 'what is in the index, and what should not be',
    icon: Database,
    element: IndexView,
    tool: 'index_status',
  },
]

/**
 * The picker's path, named once.
 *
 * Read off the first entry rather than written out a second time, so this file
 * contains exactly one `/ui/bases` string. The bijection `test/ui-readonly.test.js`
 * asserts is between the daemon's `PAGES` and the route literals matched here,
 * and a path spelled twice is a path that appears twice in whatever the test
 * collects — which is a difference between the two sides that means nothing.
 * The picker being first in the array is what makes this correct, and it is
 * first because it is the landing page.
 *
 * It is a `View` like the other five so that `Main` can find it, `NoSuchPage`
 * can list it and the bijection test can see it — but it is not one of the rail's
 * five page buttons. The rail reaches it through the KB switcher at the top of
 * the column, which is where "which project am I looking at" belongs, and a
 * second control for the same destination three rows below would be two answers
 * to one question.
 */
export const PICKER = VIEWS[0].path

/** The five per-project pages, in rail order. */
export const PAGE_VIEWS = VIEWS.filter((view) => view.path !== PICKER)

/** The no-JS floor. Reachable from the rail, deliberately not a React route. */
export const PLAIN_STATUS = '/ui/status'
