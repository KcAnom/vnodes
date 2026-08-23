/**
 * Which knowledge base this page is looking at.
 *
 * A knowledge base is one indexed project — `<root>/.vnodes/index.db` — and the
 * daemon can now serve any of the ones the registry knows about. The browser
 * names one with `?kb=<id>`, a 16-hex-char registry *key*. It is never a path
 * and it never becomes one on this side of the wire: the client's whole job is
 * to carry the same sixteen characters it was given, unaltered, into every
 * request and every link it builds. `resolveKb()` in `src/registry.js` is the
 * only code anywhere that turns it into a directory.
 *
 * The value is read out of `window.location` at call time and never cached in a
 * module variable. `ui/src/map/api.ts` already states the model this app runs on
 * — "the URL is the state; there is no other" — and a cached copy of the current
 * KB would be a second answer to that question, wrong for exactly as long as it
 * took a route change to notice.
 *
 * This module and `route.tsx` import each other: `useKb` needs the router's
 * parsed params, and the router's link normalizer needs `currentKb` and
 * `KB_EXEMPT`. Neither touches the other's bindings while the modules are
 * evaluating — every use is inside a function body — so the cycle resolves the
 * way ES modules promise it will. It is written down here because a cycle
 * nobody documented is a cycle somebody eventually "fixes" by moving one of
 * these functions into the wrong file.
 */
import { useRoute } from './route'

export const KB_PARAM = 'kb'

/**
 * The one link that must never be rewritten to stay inside the current KB.
 *
 * The picker is how a reader leaves a knowledge base. If the normalizer treated
 * it like every other `/ui` link, `/ui/bases` would be reachable only from a
 * page that has no KB — which is to say, unreachable from the place a reader is
 * standing when they want it. Exempting it by name rather than by a special
 * case inside the normalizer keeps the exception readable from here.
 */
export const KB_EXEMPT = ['/ui/bases']

/** The KB in the address bar, or '' for none. Read fresh, every time. */
export function currentKb(): string {
  return new URLSearchParams(window.location.search).get(KB_PARAM) ?? ''
}

/**
 * The same url, carrying the current KB — unless it already names one.
 *
 * An explicit `?kb=` in the url always wins, because the only reason to write
 * one by hand is to point somewhere other than here. An empty `kb` appends
 * nothing at all, so every URL this app builds outside a knowledge base stays
 * byte-identical to what it was before any of this existed.
 */
export function withKb(url: string, kb = currentKb()): string {
  if (!kb) return url
  const parsed = new URL(url, window.location.origin)
  // A url that leaves this origin is not ours to annotate, and rebuilding it
  // from pathname + search below would silently drop its host.
  if (parsed.origin !== window.location.origin) return url
  if (parsed.searchParams.has(KB_PARAM)) return url
  parsed.searchParams.set(KB_PARAM, kb)
  return parsed.pathname + parsed.search + parsed.hash
}

/** The router's answer to the same question, for a component that re-renders. */
export function useKb(): string {
  return useRoute().params.get(KB_PARAM) ?? ''
}
