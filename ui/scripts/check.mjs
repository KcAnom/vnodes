/**
 * Render checks for the vnodes UI.
 *
 * This file replaces test/view-parity.md. That document existed for one reason:
 * rendering could not be asserted, so the behaviour a renderer had to keep was
 * written down as a checklist for a human to walk. Every item sat unticked, and
 * the one defect that mattered most — every node box clipping its own last row —
 * would have been caught by any of them.
 *
 * A checklist nobody runs is not weaker than a test. It is a different thing
 * entirely: a record of intent. Once headless Chrome is already in the repo for
 * screenshots, the intent can be executed, so it is executed here.
 *
 * These are not unit tests and do not belong in `npm test`, which must keep
 * running with no toolchain and no browser. They need a built bundle and a live
 * daemon, which is exactly the seam where the interesting failures live.
 *
 *   npm --prefix ui run check
 *
 * Each check names the reader-facing promise it defends, because a failure
 * should say what the reader lost, not which selector moved.
 *
 * The clipping check is mutation-verified: forcing every card back to the 66px
 * the old SVG geometry computed makes it report 21 of 21 clipped. A check that
 * has never failed is not yet a test, and its first version passed on a broken
 * page because it measured a connection handle instead of the card.
 */
import { writeFileSync } from 'node:fs'

const PORT = process.env.VNODES_PORT || '7821'
const ORIGIN = `http://127.0.0.1:${PORT}`

// ---------------------------------------------------------------- CDP client

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find((t) => t.type === 'page')
if (!target) throw new Error('no page target — run `npm --prefix ui run shots` once, or start chrome with --remote-debugging-port=9222')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let lastId = 0

socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++lastId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve) => (socket.onopen = resolve))
await send('Page.enable')
await send('Runtime.enable')

/** Run an async function body in the page and get its value back. */
async function evaluate(body) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

async function open(path, width = 1600, height = 1000) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: ORIGIN + path })
  // React Flow fits on a rAF after the payload lands; measuring before that
  // reads positions that are about to change.
  await new Promise((resolve) => setTimeout(resolve, 3500))
}

// ------------------------------------------------------------ page-side helpers

/**
 * Injected before each check. Kept as a string because it runs in the page, not
 * here — the two sides share no module scope.
 */
const HELPERS = `
  const boxes = (sel) => [...document.querySelectorAll(sel)].map(el => {
    const r = el.getBoundingClientRect()
    return { el, r, text: el.innerText || '' }
  })
  const overlaps = (a, b) =>
    a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2
  // React Flow wraps every node in connection handles, so the card is the child
  // that is not one. Reading firstElementChild here measures a 4px handle, which
  // is how the first version of the clipping check below passed on a page where
  // every card was in fact clipping.
  const cardOf = (el) => [...el.children].find(c => !String(c.className).includes('handle'))
  const nodes = () => boxes('.react-flow__node')
  const text = () => document.body.innerText
  const ok = (detail) => ({ ok: true, detail })
  const bad = (detail) => ({ ok: false, detail })
`

// ------------------------------------------------------------------- checks

const CHECKS = [
  // --- the map -------------------------------------------------------------
  {
    page: '/ui/map?path=src',
    name: 'no node box clips its own content',
    promise: 'a node shows everything it says it shows',
    body: `
      const bad_ = nodes().filter(({ el }) => {
        const card = cardOf(el)
        return card && card.scrollHeight > card.clientHeight + 1
      })
      return bad_.length
        ? bad('clipped: ' + bad_.slice(0, 3).map(n => n.text.split('\\n')[0]).join(', ') + ' (' + bad_.length + ' total)')
        : ok(nodes().length + ' nodes, none clipped')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'no node sits under the chrome',
    promise: 'nothing the reader needs is hidden behind a floating panel',
    body: `
      const chrome = boxes('.surface').map(b => b.r)
      const rail = document.querySelector('nav')
      if (rail) chrome.push(rail.getBoundingClientRect())
      const panel = document.querySelector('aside')
      if (panel) chrome.push(panel.getBoundingClientRect())
      const hidden = nodes().filter(n => chrome.some(c => overlaps(n.r, c)))
      return hidden.length
        ? bad('covered: ' + hidden.slice(0, 3).map(n => n.text.split('\\n')[0]).join(', '))
        : ok(chrome.length + ' chrome panels, no node under any of them')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'edges carry direction',
    promise: 'which file depends on which is readable, not guessable',
    body: `
      const paths = [...document.querySelectorAll('.react-flow__edge-path')]
      if (!paths.length) return bad('no edges drawn at all')
      const undirected = paths.filter(p => !p.getAttribute('marker-end'))
      return undirected.length
        ? bad(undirected.length + ' of ' + paths.length + ' edges have no arrowhead')
        : ok(paths.length + ' edges, all with an arrowhead')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'a node states what the indexer knows',
    promise: 'language, symbol count and both degrees, on the node itself',
    body: `
      const first = nodes()[0]
      if (!first) return bad('no nodes')
      const t = first.text
      const missing = ['sym', '↓', '↑'].filter(m => !t.includes(m))
      return missing.length ? bad('node text missing ' + missing.join(', ') + ' — got: ' + JSON.stringify(t))
                            : ok(JSON.stringify(t.replace(/\\n/g, ' ')))
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'the legend names every mark',
    promise: 'a colour on a node can be looked up',
    body: `
      const t = text()
      const missing = ['pivot', 'skeleton', 'cycle', 'isolated'].filter(m => !t.includes(m))
      return missing.length ? bad('legend missing: ' + missing.join(', ')) : ok('all four marks named')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'omission is stated',
    promise: 'a map that leaves files out says so, with a way to see them',
    body: `
      const payload = await (await fetch('/ui/map/data?path=src')).json()
      const left = (payload.dropped || 0) + (payload.out_of_scope || 0) + (payload.filtered?.count || 0)
      if (!left) return ok('nothing was left out')
      const t = text()
      return /not drawn|are not drawn|Showing \\d+ of/.test(t)
        ? ok(left + ' files left out, and the page says so')
        : bad(left + ' files left out with no notice on the page')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'every node is reachable by keyboard',
    promise: 'the map is not mouse-only',
    body: `
      const unreachable = nodes().filter(({ el }) => !el.querySelector('button, a, [tabindex]'))
      return unreachable.length ? bad(unreachable.length + ' nodes with nothing focusable inside')
                                : ok(nodes().length + ' nodes, all focusable')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'clicking a node opens its detail, Escape closes it',
    promise: 'the graph can be walked, not just looked at',
    body: `
      const first = nodes()[0]
      if (!first) return bad('no nodes')
      const label = first.text.split('\\n')[0]
      first.el.querySelector('button')?.click()
      await new Promise(r => setTimeout(r, 700))
      const panel = document.querySelector('aside')
      if (!panel) return bad('clicking ' + label + ' opened no panel')
      // Guard against the selector drifting back onto a navigation region:
      // this check once matched the rail and reported its link text as detail.
      if (panel.querySelectorAll('a[href^="/ui"]').length > 3) return bad('matched the rail, not a detail panel')
      const shown = panel.innerText
      if (!shown.includes(label)) return bad('panel opened but does not name ' + label)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(r => setTimeout(r, 400))
      return document.querySelector('aside')
        ? bad('Escape did not close the panel')
        : ok('opened on ' + label + ', closed on Escape')
    `,
  },
  {
    page: '/ui/map?path=src',
    name: 'the filter dims rather than hides',
    promise: 'a filtered file is still where it was',
    body: `
      const box = document.querySelector('input[type=search]')
      if (!box) return bad('no filter box')
      const before = nodes().length
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(box, 'daemon')
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 600))
      const after = nodes()
      if (after.length !== before) return bad('filtering removed nodes: ' + before + ' -> ' + after.length)
      const lit = after.filter(({ el }) => Number(getComputedStyle(cardOf(el)).opacity) > 0.9)
      const named = lit.map(n => n.text.split('\\n')[0])
      if (!lit.length) return bad('every node dimmed, including the ones that match')
      if (lit.length === after.length) return bad('nothing dimmed — the filter did not take')
      const wrong = named.filter(n => !n.toLowerCase().includes('daemon'))
      return wrong.length
        ? bad('left lit without matching: ' + wrong.join(', '))
        : ok(named.join(', ') + ' lit, ' + (after.length - lit.length) + ' dimmed, none removed')
    `,
  },
  {
    page: '/ui/map?target=zzz-no-such-file',
    name: 'an unresolved target says so',
    promise: 'never silently falls back to drawing everything',
    body: `
      const t = text()
      if (nodes().length) return bad('drew ' + nodes().length + ' nodes for a target that resolves to nothing')
      return /no match/i.test(t) ? ok('says "no match" and draws nothing')
                                 : bad('drew nothing but did not say why: ' + JSON.stringify(t.slice(0, 120)))
    `,
  },
  // --- the picker and the kb parameter -------------------------------------
  {
    page: '/ui/bases',
    name: 'every knowledge base row states its health',
    promise: 'no row is a name you have to open to find out about',
    body: `
      const list = await (await fetch('/ui/api/kbs')).json()
      if (!list.kbs?.length) return ok('no knowledge bases registered — nothing to state')
      const rows = [...document.querySelectorAll('ul li')].filter(li => li.innerText.trim())
      const named = list.kbs.filter(kb => text().includes(kb.verdict))
      return named.length === list.kbs.length
        ? ok(named.length + ' of ' + list.kbs.length + ' rows carry their verdict verbatim')
        : bad((list.kbs.length - named.length) + ' of ' + list.kbs.length + ' rows drawn without the health verdict the server sent (' + rows.length + ' rows in the DOM)')
    `,
  },
  {
    page: '/ui/bases',
    name: 'the picker states its own sort order',
    promise: 'a list nobody has to guess the ranking of',
    body: `
      const t = text()
      return /most recently used first|by path, alphabetical/.test(t)
        ? ok('order stated in the header')
        : bad('the header does not say what order these are in: ' + JSON.stringify(t.slice(0, 160)))
    `,
  },
  {
    page: '/ui/bases',
    name: 'nothing on the picker writes',
    promise: 'opening a page never indexes, deletes or forgets anything',
    body: `
      // The exact shape of the accident this page exists to surface: one
      // read-only tool call, made while standing somewhere nobody meant to
      // index, is what created a 541,275-file knowledge base.
      const posts = [...document.querySelectorAll('form')].filter(f => (f.method || '').toLowerCase() === 'post')
      if (posts.length) return bad(posts.length + ' post form(s) on the picker')
      const acting = [...document.querySelectorAll('button')]
        .filter(b => /index|delete|forget|remove|rebuild/i.test(b.innerText))
        // A Copyable is a button whose whole job is to put text on the
        // clipboard; its label IS the command, and that is the point.
        .filter(b => (b.title || '') !== 'copy' && (b.title || '') !== 'copied')
      return acting.length
        ? bad('buttons that read as actions: ' + acting.map(b => JSON.stringify(b.innerText)).join(', '))
        : ok('no post form, and no button that offers to change anything')
    `,
  },
  {
    page: '/ui/map?kb=0000000000000000',
    name: 'an unresolvable kb says so and draws nothing',
    promise: 'never silently falls back to the launch project',
    body: `
      if (nodes().length) return bad('drew ' + nodes().length + ' nodes for a kb that resolves to nothing')
      const t = text()
      return /no knowledge base with that id/i.test(t)
        ? ok('names the id and draws no graph')
        : bad('drew no graph but did not say why: ' + JSON.stringify(t.slice(0, 160)))
    `,
  },
  {
    page: '/ui/map?task=wire%20a%20new%20agent%20into%20setup',
    name: 'the capsule overlay explains itself',
    promise: 'the task, the resolved intent, and the command that reproduces it',
    body: `
      const t = text()
      const missing = []
      if (!t.includes('wire a new agent into setup')) missing.push('the task')
      if (!/intent/i.test(t)) missing.push('the intent')
      if (!t.includes('vnodes pipeline')) missing.push('the reproducing command')
      return missing.length ? bad('capsule banner missing ' + missing.join(', '))
                            : ok('task, intent and command all stated')
    `,
  },
]

/**
 * The two checks that stop `kb` being silently deleted again.
 *
 * Both submit paths on the map replace the whole query string — the toolbar's
 * form is a real GET navigation with no `preventDefault`, and "clear" is a raw
 * anchor — so each of them is a place the parameter can be dropped without
 * anything visible happening except a different project appearing.
 *
 * The id is resolved from the registry rather than written down, because ids
 * are `sha256(realpath)` and differ on every machine.
 */
const liveKb = await (async () => {
  try {
    const list = await (await fetch(ORIGIN + '/ui/api/kbs')).json()
    return (list.kbs || []).map((row) => row.id).find((id) => /^[0-9a-f]{16}$/.test(id)) || ''
  } catch {
    return ''
  }
})()

if (liveKb) {
  CHECKS.push({
    page: `/ui/map?path=src&kb=${liveKb}`,
    name: 'drawing again keeps the knowledge base',
    promise: 'redrawing a map never changes which project it is of',
    body: `
      const form = document.querySelector('form[action="/ui/map"]')
      if (!form) return bad('no map query form')
      // The submission is computed rather than performed. Pressing the button
      // is a real navigation, and a navigation tears down the context this
      // check is running in — the first version of this reported "Inspected
      // target navigated or closed" and took the next check down with it by
      // leaving the page somewhere else. A GET form submits exactly its named
      // inputs, so FormData over the form IS the query string the browser
      // would build, and a missing hidden input fails here identically.
      const submitted = new URLSearchParams([...new FormData(form)].filter(([, v]) => v))
      const kept = submitted.get('kb')
      return kept === ${JSON.stringify(liveKb)}
        ? ok('the draw button submits ?' + submitted.toString())
        : bad('drawing would navigate to /ui/map?' + submitted.toString() + ' — kb is ' + JSON.stringify(kept) + ', expected ' + ${JSON.stringify(liveKb)})
    `,
  })
  CHECKS.push({
    page: `/ui/map?path=src&kb=${liveKb}`,
    name: 'clearing the query keeps the knowledge base',
    promise: 'dropping a path filter is not also a change of project',
    body: `
      const clear = [...document.querySelectorAll('a')].find(a => a.innerText.trim() === 'clear')
      if (!clear) return bad('no clear link — the map was not drawn scoped')
      const target = new URL(clear.href)
      return target.searchParams.get('kb') === ${JSON.stringify(liveKb)}
        ? ok('the clear link carries the kb: ' + target.pathname + target.search)
        : bad('clear points at ' + target.pathname + target.search + ' — the kb is gone')
    `,
  })
} else {
  console.log('\x1b[33m•\x1b[0m kb checks skipped — /ui/api/kbs listed no knowledge base to name')
}

// The shell pages share one contract, so it is checked once per page rather
// than written out five times.
const SHELL_PAGES = ['/ui', '/ui/capsule?task=wire%20a%20new%20agent%20into%20setup', '/ui/notes', '/ui/index', '/ui/map', '/ui/bases']

for (const page of SHELL_PAGES) {
  CHECKS.push({
    page,
    name: `reaches no host but this one`,
    promise: 'zero outbound network — no CDN, no web font, no telemetry',
    body: `
      const foreign = performance.getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => !n.startsWith(location.origin) && !n.startsWith('data:') && !n.startsWith('blob:'))
      return foreign.length ? bad('requested ' + foreign.join(', ')) : ok('every request same-origin')
    `,
  })
  CHECKS.push({
    page,
    name: 'the rail reaches every page',
    promise: 'no page is a dead end',
    body: `
      // Pathnames only, and an exact-match list. This assertion, the
      // ui-readonly bijection regex, and the daemon's PAGES.has(url.pathname)
      // are the three exact-match mechanisms that made ?kb= a query
      // parameter instead of a path segment, so this comparison must keep
      // ignoring the query string. It already tolerates extra rail links, so
      // the KB switcher needs nothing here beyond its own destination.
      const links = [...document.querySelectorAll('nav a')].map(a => new URL(a.href).pathname)
      const want = ['/ui', '/ui/map', '/ui/capsule', '/ui/notes', '/ui/index', '/ui/bases']
      const missing = want.filter(w => !links.includes(w))
      return missing.length ? bad('rail is missing ' + missing.join(', ')) : ok(links.length + ' rail links')
    `,
  })
  CHECKS.push({
    page,
    name: 'the page does not scroll sideways',
    promise: 'nothing runs off the edge at a narrow window',
    width: 900,
    height: 800,
    body: `
      const el = document.documentElement
      const over = el.scrollWidth - el.clientWidth
      if (over <= 1) return ok('no horizontal overflow at ' + el.clientWidth + 'px')
      const culprit = [...document.querySelectorAll('body *')]
        .find(n => n.getBoundingClientRect().right > el.clientWidth + 1)
      return bad('overflows by ' + over + 'px, first past the edge: ' +
        (culprit ? culprit.tagName.toLowerCase() + '.' + String(culprit.className).slice(0, 60) : 'unknown'))
    `,
  })
}

// ---------------------------------------------------------------------- run

const results = []
let current = null

for (const check of CHECKS) {
  const key = `${check.page}@${check.width ?? 1600}`
  if (key !== current) {
    await open(check.page, check.width, check.height)
    current = key
  }
  let outcome
  try {
    outcome = await evaluate(HELPERS + check.body)
  } catch (cause) {
    outcome = { ok: false, detail: `threw: ${cause.message}` }
  }
  results.push({ ...check, ...outcome })
  const mark = outcome.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'
  console.log(`${mark} ${check.name}`)
  console.log(`  ${check.page} — ${outcome.detail}`)
  if (!outcome.ok) console.log(`  promise broken: ${check.promise}`)
}

const failed = results.filter((r) => !r.ok)
writeFileSync(
  new URL('../.shots/check.json', import.meta.url),
  JSON.stringify(results.map(({ name, page, promise, ok, detail }) => ({ name, page, promise, ok, detail })), null, 2),
)

console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
socket.close()
process.exit(failed.length ? 1 : 0)
