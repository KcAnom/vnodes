/**
 * Everything that has to be true before a change is finished.
 *
 * Four stages, in the order their failures are cheapest to read: unit tests,
 * then the UI typecheck and build, then a daemon, then the render checks
 * against it.
 *
 * The render checks and the screenshots exist because a map was once reported
 * as working on the strength of a clean build. Leaving them as commands a
 * person may remember to type is the same failure one level up, which is why
 * they are wired in here.
 *
 * A stage that cannot run is REPORTED and FAILS. That is deliberate: a verify
 * that silently skips the browser stage on a machine with no browser tells you
 * everything passed, which is the exact shape of the bug this repo keeps
 * finding. Pass --allow-skip when a skip is genuinely acceptable — a CI box
 * with no Chrome, say — and it downgrades to a warning that still prints.
 *
 *   npm run verify
 *   npm run verify -- --allow-skip
 *
 * Nothing here is left running that was not running before: a daemon or a
 * Chrome this script started is stopped on the way out, and one it found
 * already up is left alone.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const allowSkip = process.argv.includes('--allow-skip')
const PORT = process.env.VNODES_PORT || '7821'
const DEBUG_PORT = '9222'

const results = []
let startedDaemon = false
let chrome = null

const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', encoding: 'utf8', ...options })

// Awaits whatever the stage returns. The first version did not, so an async
// stage pushed a Promise, spread to nothing, and reported `undefined` while the
// run exited 0 — a verify that skipped its own browser stage and called the
// build a pass, which is the precise failure this script exists to prevent.
async function stage(name, fn) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`)
  const outcome = await fn()
  if (!outcome || !outcome.state) {
    const broken = fail(`the stage returned ${JSON.stringify(outcome)} instead of a result`)
    results.push({ name, ...broken })
    return broken.state
  }
  results.push({ name, ...outcome })
  return outcome.state
}

const pass = (detail) => ({ state: 'pass', detail })
const fail = (detail) => ({ state: 'fail', detail })
const skip = (detail, fix) => ({ state: 'skip', detail, fix })

const alive = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Poll until a URL answers, so a stage never races the thing it just started. */
async function waitFor(url, tries = 25) {
  for (let i = 0; i < tries; i++) {
    if (await alive(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

/**
 * Returns a path, or throws with the reason.
 *
 * An explicitly set CHROME that does not exist is an error, not a cue to look
 * elsewhere: someone who names a browser has a reason, and quietly running a
 * different one produces a pass that answers a question nobody asked.
 */
function findChrome() {
  if (process.env.CHROME) {
    if (existsSync(process.env.CHROME)) return process.env.CHROME
    throw new Error(`CHROME is set to ${process.env.CHROME}, which does not exist`)
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(mac)) return mac
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  return null
}

// ------------------------------------------------------------------ stages

await stage('index freshness', () => {
  const out = run('node', ['bin/vnodes.js', 'check'])
  return out.status === 0 ? pass('manifest matches the tree') : fail(`vnodes check exited ${out.status}`)
})

await stage('unit tests', () => {
  // Expanded here rather than by a shell: passing args through `shell: true`
  // concatenates them unescaped, and a path with a space would silently run
  // the wrong files.
  const files = readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join('test', name))
  if (!files.length) return fail('no test files found under test/')
  const out = run('node', ['--test', ...files])
  return out.status === 0 ? pass(`${files.length} files, all passing`) : fail(`node --test exited ${out.status}`)
})

const built = await stage('ui typecheck + build', () => {
  if (!existsSync(join(ROOT, 'ui/node_modules'))) {
    return skip('ui/node_modules is missing', 'npm --prefix ui ci')
  }
  const out = run('npm', ['--prefix', 'ui', 'run', 'build'])
  return out.status === 0 ? pass('tsc and vite both clean') : fail(`build exited ${out.status}`)
})

if (built === 'pass') {
  const daemonUp = await alive(`http://127.0.0.1:${PORT}/status`)
  if (!daemonUp) {
    run('node', ['bin/vnodes.js', 'daemon', 'start'], { stdio: 'ignore' })
    startedDaemon = await waitFor(`http://127.0.0.1:${PORT}/status`)
  }

  await stage('render checks', async () => {
    if (!(await alive(`http://127.0.0.1:${PORT}/status`))) {
      return skip(`no daemon on ${PORT}`, `VNODES_PORT=${PORT} vnodes daemon start`)
    }
    let binary
    try {
      binary = findChrome()
    } catch (cause) {
      return fail(cause.message)
    }
    if (!binary) return skip('no Chrome found', 'set CHROME=/path/to/chrome')

    if (!(await alive(`http://127.0.0.1:${DEBUG_PORT}/json/version`))) {
      chrome = spawn(
        binary,
        [
          '--headless=new', '--disable-gpu', '--no-sandbox',
          `--remote-debugging-port=${DEBUG_PORT}`,
          // Inside ui/.shots, which .vnodesignore excludes. A Chrome profile
          // written anywhere the indexer walks ends up ranked into capsules —
          // it happened, and it cost 2,196 tokens of an 8,000 budget.
          `--user-data-dir=${join(ROOT, 'ui/.shots/.chrome')}`,
          'about:blank',
        ],
        { stdio: 'ignore', detached: false },
      )
      if (!(await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`))) {
        return fail('chrome started but never answered on the debugging port')
      }
    }
    const out = run('node', ['ui/scripts/check.mjs'])
    return out.status === 0 ? pass('every promise held') : fail(`checks exited ${out.status}`)
  })
} else {
  results.push({ name: 'render checks', state: 'skip', detail: 'the bundle was not built', fix: 'npm --prefix ui ci' })
}

// ----------------------------------------------------------------- cleanup

if (chrome) chrome.kill()
if (startedDaemon) run('node', ['bin/vnodes.js', 'daemon', 'stop'], { stdio: 'ignore' })

// ------------------------------------------------------------------ report

console.log('\n\x1b[1m── verify\x1b[0m')
const mark = { pass: '\x1b[32m✔\x1b[0m', fail: '\x1b[31m✖\x1b[0m', skip: '\x1b[33m▲\x1b[0m' }
for (const result of results) {
  console.log(`${mark[result.state]} ${result.name} — ${result.detail}`)
  if (result.fix) console.log(`    fix: ${result.fix}`)
}

const failed = results.filter((r) => r.state === 'fail')
const skipped = results.filter((r) => r.state === 'skip')

if (failed.length) {
  console.log(`\n${failed.length} stage(s) failed.`)
  process.exit(1)
}
if (skipped.length && !allowSkip) {
  console.log(
    `\n${skipped.length} stage(s) could not run, so this is not a pass.` +
      '\nFix them, or re-run with --allow-skip to accept the gap knowingly.',
  )
  process.exit(1)
}
console.log(skipped.length ? '\nPassed, with skips accepted.' : '\nPassed.')
