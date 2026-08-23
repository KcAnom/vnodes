/**
 * Everything this page asks the daemon for. Four calls, no client-side cache:
 * the daemon is on localhost and the index is the only source of truth, so a
 * cache here could only ever be a way to show something that is no longer true.
 */
import { withKb } from '../shell/kb'
import type { FileDetail, MapPayload, MapQuery } from './types'

export function queryString(query: MapQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // `show=code` is what the server does without being asked, so spelling it
    // out would only lengthen every shared link and make `?show=all` — which is
    // a deliberate act — read as though it were one of a pair of equals.
    //
    // `kb` is never elided this way and there is no equivalent shortcut for it.
    // `show=code` can be dropped because the server does the same thing without
    // it; dropping `kb` would change which project answers, and the daemon's
    // fallback when it is absent is the project it happens to have been
    // launched in — a different graph, drawn under the same URL.
    if (key === 'show' && value === 'code') continue
    if (value) params.set(key, value)
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

/**
 * The query, read off a set of params. The URL is the state; there is no other.
 *
 * `compact` is in this list because it was missing from it, and that was a bug
 * with a URL on the must-keep-working list: the server honours `?compact=0`
 * (nodeWidth 280, colGap 120, maxRows 14 instead of 208/96/11), but this client
 * rebuilt every request from the keys it read, so the param was dropped on the
 * first fetch and on every SSE reconnect alike. A key the client does not read
 * is a key the client silently deletes.
 *
 * `kb` is the second instance of the same bug and the more expensive one. A
 * dropped `compact` costs the reader a geometry they chose; a dropped `kb`
 * means `/ui/map?kb=abc` draws the launch project's graph while the address bar
 * says otherwise — on the first fetch and on every reconnect, with nothing on
 * the page to suggest anything happened.
 */
export function readQuery(params: URLSearchParams): MapQuery {
  return {
    target: params.get('target') ?? '',
    task: params.get('task') ?? '',
    repo: params.get('repo') ?? '',
    depth: params.get('depth') ?? '',
    path: params.get('path') ?? '',
    show: params.get('show') ?? '',
    compact: params.get('compact') ?? '',
    kb: params.get('kb') ?? '',
  }
}

/** The query the page was opened with, for a caller that has no router. */
export function queryFromLocation(): MapQuery {
  return readQuery(new URLSearchParams(window.location.search))
}

export async function fetchMap(query: MapQuery): Promise<MapPayload> {
  const res = await fetch(`/ui/map/data${queryString(query)}`)
  if (!res.ok) throw new Error(`map unavailable (${res.status})`)
  return res.json()
}

export async function fetchDetail(file: string): Promise<FileDetail | null> {
  // The only URL on this page that `queryString` does not build, so it is the
  // only one that needs the KB folded in by hand.
  const res = await fetch(withKb(`/ui/map/node?file=${encodeURIComponent(file)}`))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`detail unavailable (${res.status})`)
  return res.json()
}

/**
 * What the stream says about itself on connect.
 *
 * The daemon polls the KB's index stamp and pushes when it moves, which means
 * it reports a re-index done by any process — but it does not mean anything is
 * indexing this KB at all. A KB nothing watches produces a socket that opens
 * and then stays silent forever, which is a different fact from a live one and
 * used to be indistinguishable from it.
 */
export type MapHello = {
  kb: string | null
  watched_by_this_daemon: boolean
  last_index: number | null
  owner_pid: number | null
}

/**
 * Live frames. The daemon pushes on an index generation change, not on a timer,
 * so a frame arriving means the code actually changed. `onState` reports the
 * connection so the page can say it has gone quiet rather than showing stale
 * numbers as though they were current.
 *
 * `onHello` is what stops the page overstating that. Before it, `live` went
 * true because the socket opened, which for a KB nobody is indexing — the home
 * accident's `meta` is empty and its stamp is 0 forever — was a permanent lie.
 * A daemon that does not send the frame leaves `onHello` uncalled and the page
 * falls back to exactly what it said before.
 */
export function subscribe(
  query: MapQuery,
  onFrame: (payload: MapPayload) => void,
  onState: (live: boolean) => void,
  onHello?: (hello: MapHello) => void,
): () => void {
  const source = new EventSource(`/ui/map/events${queryString(query)}`)
  source.onopen = () => onState(true)
  source.addEventListener('hello', (event) => {
    try {
      onHello?.(JSON.parse((event as MessageEvent).data))
    } catch {
      /* Same reasoning as a malformed frame: this is a label, not the data. */
    }
  })
  source.onmessage = (event) => {
    try {
      onFrame(JSON.parse(event.data))
      onState(true)
    } catch {
      /* A malformed frame is not worth tearing the page down for. */
    }
  }
  source.onerror = () => onState(false)
  return () => source.close()
}
