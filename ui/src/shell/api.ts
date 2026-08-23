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
 */

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
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok) throw new Error(`${url} — ${res.status}`)
  if (!type.includes('json')) {
    throw new Error(`${url} answered with ${type || 'no content type'}, not JSON`)
  }
  return res.json() as Promise<T>
}

export const fetchStatus = () => getJson<Status>('/status')
export const fetchHealth = () => getJson<Health>('/ui/api/health')
export const fetchComposition = () => getJson<Composition>('/ui/api/composition')
export const fetchTools = () => getJson<Tools>('/tools')

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
