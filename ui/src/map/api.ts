/**
 * Everything this page asks the daemon for. Four calls, no client-side cache:
 * the daemon is on localhost and the index is the only source of truth, so a
 * cache here could only ever be a way to show something that is no longer true.
 */
import type { FileDetail, MapPayload, MapQuery } from './types'

export function queryString(query: MapQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value)
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

/** The query the page was opened with. The URL is the state; there is no other. */
export function queryFromLocation(): MapQuery {
  const params = new URLSearchParams(window.location.search)
  return {
    target: params.get('target') ?? '',
    task: params.get('task') ?? '',
    repo: params.get('repo') ?? '',
    depth: params.get('depth') ?? '',
  }
}

export async function fetchMap(query: MapQuery): Promise<MapPayload> {
  const res = await fetch(`/ui/map/data${queryString(query)}`)
  if (!res.ok) throw new Error(`map unavailable (${res.status})`)
  return res.json()
}

export async function fetchDetail(file: string): Promise<FileDetail | null> {
  const res = await fetch(`/ui/map/node?file=${encodeURIComponent(file)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`detail unavailable (${res.status})`)
  return res.json()
}

/**
 * Live frames. The daemon pushes on an index generation change, not on a timer,
 * so a frame arriving means the code actually changed. `onState` reports the
 * connection so the page can say it has gone quiet rather than showing stale
 * numbers as though they were current.
 */
export function subscribe(
  query: MapQuery,
  onFrame: (payload: MapPayload) => void,
  onState: (live: boolean) => void,
): () => void {
  const source = new EventSource(`/ui/map/events${queryString(query)}`)
  source.onopen = () => onState(true)
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
