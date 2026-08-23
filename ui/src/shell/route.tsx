/**
 * The router. All of it.
 *
 * `ui/src/map/api.ts` already states the model this app runs on — "the URL is
 * the state; there is no other" — and a data router would be a second answer to
 * a question that already has one. What is actually needed is three things: read
 * the current URL, change it without a reload, and render a link that is a real
 * link. That is this file.
 *
 * The snapshot `useSyncExternalStore` hands back is deliberately the href
 * *string*. Returning the parsed `{path, params}` object would return a fresh
 * object on every store read, React would see the snapshot change on every
 * render, and the page would re-render until the tab died. The parse happens in
 * a `useMemo` keyed on that string instead.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode } from 'react'

/**
 * `pushState` fires nothing — `popstate` is only the back button. So a push
 * notifies this set by hand, and a pop arrives through the event.
 */
const listeners = new Set<() => void>()

const currentHref = () => window.location.pathname + window.location.search

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener('popstate', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('popstate', onChange)
  }
}

export function navigate(to: string, options?: { replace?: boolean }) {
  if (to === currentHref()) return
  window.history[options?.replace ? 'replaceState' : 'pushState']({}, '', to)
  for (const listener of listeners) listener()
}

export type Route = {
  /** `pathname + search`, the whole state as one comparable string. */
  href: string
  /** Trailing slash stripped, so `/ui/notes/` and `/ui/notes` are one page. */
  path: string
  params: URLSearchParams
}

export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, currentHref)
  return useMemo(() => {
    const url = new URL(href, window.location.origin)
    return {
      href,
      path: url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname,
      params: url.searchParams,
    }
  }, [href])
}

/**
 * A real `<a href>` that happens to avoid a reload.
 *
 * The bail-outs are not polish. Cmd-click opens a tab, middle-click opens a
 * tab, and "copy link address" is how a map gets into a review comment — this
 * project already holds itself to deep links that survive being pasted, and a
 * handler that swallowed every click would quietly take all three away.
 */
export function Link({
  to,
  className,
  title,
  children,
  onClick,
}: {
  to: string
  className?: string
  title?: string
  children: ReactNode
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  return (
    <a
      href={to}
      className={className}
      title={title}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
