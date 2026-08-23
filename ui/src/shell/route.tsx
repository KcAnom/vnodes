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
 *
 * The one thing this router does beyond those three jobs is keep `?kb=` on the
 * links it renders, and it does it on the **href attribute**, not only in the
 * click handler. That is not a shortcut, it is the same promise `Link`'s own
 * bail-outs below are already keeping: "copy link address is how a map gets
 * into a review comment". A link whose visible href lacks `kb` but whose
 * onClick adds it is two destinations behind one control, and the one that gets
 * pasted into the review comment is the wrong project's.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { KB_EXEMPT, KB_PARAM, currentKb } from './kb'

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

/**
 * `to`, with the current knowledge base folded in.
 *
 * Twenty `Link` and `navigate` sites across five files each build a `/ui…` URL
 * from scratch. Hand-editing all twenty would work exactly once and regress on
 * the next link somebody adds, with nothing to catch it — so the carrying
 * happens here, where every one of them already passes through.
 *
 * Four conditions, all of them narrowing: only `/ui` paths (a link off this app
 * is not ours to annotate), never `/ui/bases` (see `KB_EXEMPT` — it is how a
 * reader leaves a KB), never over an explicit `?kb=` the caller wrote, and
 * never when there is no KB to carry, which is what keeps every URL in a
 * single-project daemon byte-identical to what it was.
 */
export function withKbHref(to: string): string {
  const kb = currentKb()
  if (!kb) return to
  if (!to.startsWith('/ui')) return to
  const [pathname] = to.split(/[?#]/, 1)
  if (KB_EXEMPT.includes(pathname.replace(/\/+$/, '') || pathname)) return to
  const url = new URL(to, window.location.origin)
  if (url.searchParams.has(KB_PARAM)) return to
  url.searchParams.set(KB_PARAM, kb)
  return url.pathname + url.search + url.hash
}

export function navigate(to: string, options?: { replace?: boolean }) {
  const target = withKbHref(to)
  if (target === currentHref()) return
  window.history[options?.replace ? 'replaceState' : 'pushState']({}, '', target)
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
  // Computed once per render and used for both the attribute and the push, so
  // the address the reader can copy and the address the click goes to are the
  // same string by construction rather than by two call sites agreeing.
  const href = withKbHref(to)
  return (
    <a
      href={href}
      className={className}
      title={title}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(href)
      }}
    >
      {children}
    </a>
  )
}
