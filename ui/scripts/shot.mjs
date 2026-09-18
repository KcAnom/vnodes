/**
 * Screenshot the running map through headless Chrome's DevTools Protocol.
 *
 * This exists because the map was once reported as working on the strength of a
 * clean build and a 200 from curl. It compiled, it served, and it rendered a
 * page with every node box clipped. A rendering claim needs a rendered page.
 *
 * CDP rather than `--screenshot`: the map holds an open EventSource, so
 * `--virtual-time-budget` never settles and headless hangs forever. Node 22's
 * global WebSocket means driving the protocol directly costs no dependency.
 *
 *   node ui/scripts/shot.mjs <url> <out.png> [width] [height] [settleMs]
 *
 * Chrome must already be listening: `npm run shots` starts one if it is not.
 */
import { writeFileSync } from 'node:fs'

const [url, out, widthArg, heightArg, settleArg] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node ui/scripts/shot.mjs <url> <out.png> [width] [height] [settleMs]')
  process.exit(2)
}

const width = Number(widthArg || 1600)
const height = Number(heightArg || 1000)
// Long enough for the bundle to parse, the payload to arrive and React Flow to
// run its fit. Shorter and the shot catches an empty canvas mid-mount.
const settle = Number(settleArg || 4000)

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
let page = targets.find((target) => target.type === 'page')
if (!page) {
  // A headless Chrome whose only page was consumed (a previous check.mjs run
  // closes what it opens) lists zero targets, and every shot would die here
  // until someone thought to restart the browser. Create the page instead.
  // Chrome 111+ requires PUT for /json/new; older builds answered GET.
  const created = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (!created) throw new Error('no page target and none could be created — restart chrome with --remote-debugging-port=9222')
  page = created
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
const logs = []
let lastId = 0

socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.consoleAPICalled') {
    const args = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    logs.push(`${message.params.type}: ${args}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    logs.push(`EXCEPTION: ${details.exception?.description ?? details.text}`)
  }
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++lastId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve) => (socket.onopen = resolve))
await send('Runtime.enable')
await send('Page.enable')
// The bundle is served from a fixed filename with no hash in it, so a Chrome
// that already has `map.js` will happily photograph the previous build and
// report a bug that was fixed two builds ago. This script exists to stop
// exactly that class of false evidence, so the cache is off.
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
// deviceScaleFactor 2 so 10px type in a screenshot is still legible to a reader.
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, settle))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))

// The console is reported alongside the image because a page can look right and
// still be throwing on every frame.
console.log(`saved ${out}`)
console.log(logs.length ? logs.join('\n') : 'console: clean')
socket.close()
