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

// The shell pages share one contract, so it is checked once per page rather
// than written out five times.
const SHELL_PAGES = ['/ui', '/ui/capsule?task=wire%20a%20new%20agent%20into%20setup', '/ui/notes', '/ui/index', '/ui/map']

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
      const links = [...document.querySelectorAll('nav a')].map(a => new URL(a.href).pathname)
      const want = ['/ui', '/ui/map', '/ui/capsule', '/ui/notes', '/ui/index']
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
