/**
 * The five pages, as an array.
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
 */
import { lazy } from 'react'
import { Database, Gauge, Layers, Network, NotebookPen } from 'lucide-react'
import type { ElementType } from 'react'
import type { LucideIcon } from 'lucide-react'
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

/** The no-JS floor. Reachable from the rail, deliberately not a React route. */
export const PLAIN_STATUS = '/ui/status'
