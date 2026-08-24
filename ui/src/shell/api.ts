/**
 * Everything the shell asks the daemon for.
 *
 * Two rules hold this file together.
 *
 * The first is the one `ui/src/map/api.ts` already states: no client-side
 * cache. The daemon is on localhost and the index is the only source of truth,
 * so anything cached here could only ever be a way to show something that is no
 * longer true.
 *
 * The second is new and is a product guarantee rather than a preference: this
 * UI is read-only. It never posts to `/rpc`. Not because a GET is tidier, but
 * because every `/rpc` call writes an observation row, and a page that polls
 * would fill the memory feed agents actually read with rows whose summary is
 * literally `{}`. The `/ui/api/*` family exists so the reads can happen without
 * the writes. The strings `save_observation` and `workspace_setup` do not
 * appear anywhere under `ui/src`, and a test asserts it.
 *
 * A third rule arrived with the registry: every one of these calls is about one
 * knowledge base, so every one of them carries `?kb=`. That is the default
 * rather than something four call sites remember, and the three calls that are
 * not about a knowledge base opt out by name.
 *
 * `/tools` is the daemon's own catalog and `/ui/api/kbs` is the registry
 * itself; sending a `kb` to either would be a lie about what the request is.
 * `/status` is the third and it opts out for two reasons at once. It reports on
 * the daemon and its launch project — that is what `doctor()` reads it for when
 * probing a foreign daemon on a held port — and it is matched server-side
 * against the whole request url rather than the pathname, so `/status?kb=…` is
 * a 404 today. Scoping it would not have quietly reported the wrong project; it
 * would have taken the rail's health dot and the whole overview page down on
 * every KB-scoped URL.
 */
import { withKb } from './kb'

/** GET /status — the one endpoint that predates all of this. */
export type Status = {
  daemon: string
  pid: number
  port: number
  project: string
  index: {
    state: string
    files: number
    nodes: number
    edges: number
    repos: string[]
    languages: { lang: string; c: number }[]
    last_index: number | null
    last_index_ms?: number
  }
  workspace: { name?: string; repos?: { alias: string; path: string }[] } | null
}

/**
 * What a knowledge base can be, from the picker's point of view.
 *
 * `missing` and `unreadable` are deliberately not one state. A project
 * directory that is gone has been deleted; a `statSync` that threw EACCES or
 * EIO is an unmounted volume or a permission, and telling a reader their work
 * was deleted because a drive was not plugged in would be the worst thing this
 * page could say.
 */
export type KbState = 'ok' | 'never_completed' | 'engine_removed' | 'missing' | 'unreadable'

/** The pathologies a row can carry. Every one of them is printed, never summed. */
export type KbFlag = 'home_dir' | 'no_edges' | 'oversize_files' | 'oversize_db' | 'never_completed'

export type KbAgent = {
  name: string
  version?: string
  last_seen_ms?: number | null
  sessions?: number
}

/**
 * One registry entry, as `/ui/api/kbs` returns it.
 *
 * Declared here rather than in `ui/src/map/types.ts` on purpose: the picker is
 * the landing page, and an import that reached into `ui/src/map` for a type
 * would pull the map's module graph — React Flow, half the built bytes — into
 * the entry chunk to satisfy something that erases at compile time in theory
 * and is far too easy to turn into a real import in practice.
 *
 * The count fields are optional because they are a cache of the last completed
 * index and a KB can be registered without ever having finished one. The page
 * prints what is present and says what is not; it never renders a zero it was
 * not given.
 */
/**
 * The on-disk scan that finds knowledge bases nobody reindexed.
 *
 * Reported beside the list because a short list and a scan that gave up look
 * identical from the outside, and one of them means a knowledge base is missing
 * from this page.
 */
export type KbDiscovery = {
  roots?: string[]
  scanned?: number
  found?: string[]
  registered?: { id: string; path: string }[]
  truncated?: boolean
  stopped_by?: 'entries' | 'time' | null
  ms?: number
  error?: string
}

export type KbRow = {
  id: string
  name: string
  path: string
  state: KbState
  /** A sentence the server wrote about `state`. Printed verbatim. */
  state_detail: string
  hidden: boolean
  is_launch: boolean
  /** `index.db` has been written since the cached counts were taken. */
  counts_stale: boolean
  /** The health line, in the server's own words. Printed, never re-derived. */
  verdict: string
  flags: KbFlag[]
  agents: KbAgent[]
  last_activity_ms: number | null
  last_indexed_ms?: number | null
  // Explicitly `| null`, not merely optional: the server writes nulls rather
  // than omitting keys, so a `!== undefined` guard lets a null straight through.
  // It did, and the picker threw on the first knowledge base registered without
  // a completed index.
  files?: number | null
  nodes?: number | null
  edges?: number | null
  notes?: number | null
  db_bytes?: number | null
  languages?: { lang: string; c: number }[]
  /** The CLI lines that would hide or forget this entry. Shown, never run. */
  hide_command: string
  forget_command: string
}

/** GET /ui/api/kbs — the whole picker, in one global call that takes no `kb`. */
export type KbList = {
  registry_dir: string
  /** True when this daemon was launched with no project of its own. */
  hub: boolean
  launch_kb: string | null
  sort: string
  scanned: number
  scan_capped: boolean
  shown: number
  hidden_count: number
  /** The last on-disk scan, when the daemon has run one. */
  discovery?: KbDiscovery | null
  total_db_bytes: number
  kbs: KbRow[]
  /** Whatever the server withheld and why. Printed in the footer, always. */
  notes?: string[]
}

/** One row of `vnodes doctor`. `detail` is a sentence the CLI already wrote. */
export type DoctorCheck = { check: string; ok: boolean; detail: string }

/** GET /ui/api/health — doctor, the effective config, and the log tails. */
export type Health = {
  doctor: { project: string; checks: DoctorCheck[]; healthy: boolean }
  llm: {
    state: string
    mode?: string
    runtime?: { provider?: string; cli?: string; model?: string }
    runtime_cli_found?: boolean
  } | null
  /** The whole effective config. Only the keys this UI reads are named. */
  config: {
    ui?: { sidebar_refresh_s?: number; map_refresh_s?: number; map_max_nodes?: number }
    /** A range rather than a number — `"65-70%"` — so it is printed, not compared. */
    capsule?: { savings_baseline?: string; max_tokens?: number }
  }
  logs: { daemon: string[]; index: string[]; tail_lines?: number }
}

export type CapsulePivot = {
  file: string
  tokens: number
  /** Present only when the file did not fit: what it would have cost whole. */
  full_tokens?: number
  clipped?: boolean
  /** The head of the clip, and only for a clipped pivot. See Capsule.tsx. */
  content?: string
}

export type CapsuleSkeleton = { file: string; tokens: number; detail: string }

/** A memory row, as `src/memory.js` returns it through every one of its readers. */
export type Memory = {
  id: number
  ts: number
  session: string
  tool: string
  kind: string
  summary: string
  symbol: string | null
  file: string | null
  stale: boolean
  /** Only on a stale row, and printed verbatim — it is the project's own words. */
  warning?: string
  /** Only in search results: why this row matched. */
  rationale?: string
  current_session?: boolean
}

/** GET /ui/api/capsule?task=&preset=&max_tokens= */
export type Capsule = {
  intent: string
  /** Why that intent was picked. Absent when the preset was given explicitly. */
  intent_reason?: string
  budget_tokens: number
  used_tokens: number
  savings_pct: number
  truncated: boolean
  pivots: CapsulePivot[]
  skeletons: CapsuleSkeleton[]
  memories: Memory[]
  /**
   * What the capsule considered and did not carry, with what each would have
   * cost and why it was dropped. Optional in the type and never optional on the
   * page: when it is absent the footer says the daemon did not report it,
   * rather than showing nothing and implying nothing was left out.
   */
  omitted?: { file: string; est_tokens: number; reason: string }[]
  /**
   * Tokens held back from the content budget for memories before pivots spend.
   *
   * Zero when nothing relevant was stored — the reserve is never larger than
   * the memories actually found, so a task with no history costs the content
   * nothing. Optional because a daemon older than the reserve does not send it.
   */
  memory_reserve_tokens?: number
  /** The daemon's own note on what it withheld from the payload. Printed. */
  stripped?: string
  /** The savings baseline as configured — a range string, shown not computed. */
  baseline?: string
  /** The exact CLI line that reproduces this capsule, built server-side. */
  command?: string
}

/** GET /ui/api/notes?limit=&q= */
export type Notes = {
  /**
   * `sessionContext()` calls its array `observations` and `searchMemory()`
   * calls its `results`. Both are read here rather than asking the server to
   * rename one of its own long-standing return shapes for this page's sake.
   */
  observations?: Memory[]
  results?: Memory[]
  q?: string
  /** Totals behind the returned slice, so the page can say what it cut. */
  counts?: { total: number; manual: number; auto: number; stale: number }
}

/**
 * GET /ui/api/composition — one read over files/nodes/edges.
 *
 * Every list is a slice and every slice carries the total it was cut from,
 * because a "top ten" that does not say what it is the top of is exactly the
 * silent omission this project refuses everywhere else.
 *
 * `no_symbols` and `no_edges` come back as bare paths. `PathRow` accepts an
 * object too, and `rowPath` unwraps either: the two lists are symmetrical today
 * and a page that rendered `[object Object]` the day one of them grew a size
 * field would be a worse failure than four lines of tolerance.
 */
export type PathRow = string | { path?: string; file?: string }

export const rowPath = (row: PathRow): string =>
  typeof row === 'string' ? row : (row.path ?? row.file ?? '')

export type Composition = {
  total_files: number
  total_bytes: number
  by_dir: {
    dir: string
    files: number
    bytes: number
    langs: Record<string, number>
    /** Files under this prefix that parsed to nothing a skeleton could use. */
    inert_files?: number
  }[]
  by_dir_shown: number
  by_dir_total: number
  largest: { path: string; size: number; lang: string; symbols: number }[]
  no_symbols: PathRow[]
  no_symbols_total: number
  no_edges: PathRow[]
  no_edges_total: number
  /** How long any one of these lists is allowed to get. */
  list_cap?: number
  /** `.vnodesignore` lines the daemon would suggest. Shown, never applied. */
  ignore_suggestion?: string[]
  /**
   * What is on disk and deliberately not indexed, with the rule file that made
   * the call. Null when the daemon could not compute it — which is not the same
   * as nothing being excluded, and the page says so rather than showing zero.
   */
  excluded?: {
    subtrees?: { path: string; source: string; pattern: string }[]
    files?: { path: string; lang: string; source: string; pattern: string }[]
    by_source?: Record<string, number>
    truncated?: boolean
    error?: string
  } | null
}

/** GET /tools — used only to notice a view whose backing tool is not exposed. */
export type Tools = { tools: { name: string }[] }

/**
 * One fetch, and one specific kind of honesty in the failure.
 *
 * The daemon's `/ui` catch-all answers an unknown path with a 200 and a page,
 * so an endpoint that does not exist yet arrives here as valid HTML rather than
 * as a 404. Parsing that as JSON would throw somewhere deep with a message
 * about `<` — so the content type is checked first and the error says which
 * route the daemon is not serving.
 */
async function getJson<T>(url: string, { scoped = true }: { scoped?: boolean } = {}): Promise<T> {
  const target = scoped ? withKb(url) : url
  const res = await fetch(target, { headers: { accept: 'application/json' } })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok) throw new Error(`${target} — ${res.status}`)
  if (!type.includes('json')) {
    throw new Error(`${target} answered with ${type || 'no content type'}, not JSON`)
  }
  return res.json() as Promise<T>
}

export const fetchStatus = () => getJson<Status>('/status', { scoped: false })
export const fetchHealth = () => getJson<Health>('/ui/api/health')
export const fetchComposition = () => getJson<Composition>('/ui/api/composition')
export const fetchTools = () => getJson<Tools>('/tools', { scoped: false })
export const fetchKbs = () => getJson<KbList>('/ui/api/kbs', { scoped: false })

export function fetchNotes(q: string, limit = 200): Promise<Notes> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (q) params.set('q', q)
  return getJson<Notes>(`/ui/api/notes?${params}`)
}

export function fetchCapsule(task: string, preset: string, maxTokens: string): Promise<Capsule> {
  const params = new URLSearchParams({ task })
  if (preset) params.set('preset', preset)
  if (maxTokens) params.set('max_tokens', maxTokens)
  return getJson<Capsule>(`/ui/api/capsule?${params}`)
}
