'use strict';
/**
 * The map's HTML shell, and the static assets it loads.
 *
 * There is almost nothing here on purpose. The map used to be rendered on the
 * server — 1066 lines of HTML, inline SVG and hand-written client JS in
 * page.js — and every interaction it grew (pan, zoom, hover emphasis, a filter,
 * a detail panel, restoring scroll across a live frame) was written from
 * scratch against the DOM. That is now a React Flow canvas built from ui/, and
 * the server's job shrank to two things: hand over the payload as JSON, and
 * serve the bundle that draws it.
 *
 * The bundle is committed. vnodes ships no runtime dependencies and asks nobody
 * to run a build to use it; the toolchain lives in ui/ and only a contributor
 * changing the map ever runs it. Nothing here reaches the network — the assets
 * are files on disk, served by the local daemon like everything else.
 */
const fs = require('node:fs');
const path = require('node:path');

const STATIC_DIR = path.join(__dirname, 'static');

/** Types for the handful of files a Vite build emits. Anything else is refused. */
const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * One asset, by the name in the URL.
 *
 * `path.basename` is not decoration: it is what keeps `/ui/static/../../etc` —
 * or any other traversal — from resolving outside the bundle directory. The
 * daemon binds to localhost, but a bug that reads arbitrary files is a bug at
 * any address.
 */
function readAsset(name) {
  const safe = path.basename(String(name || ''));
  const type = CONTENT_TYPES[path.extname(safe)];
  if (!type) return null;
  const file = path.join(STATIC_DIR, safe);
  try {
    return { body: fs.readFileSync(file), type };
  } catch {
    return null;
  }
}

/**
 * Every page the React shell draws, and the title it draws under.
 *
 * The title used to be the literal string "dependency map" for whatever the
 * client happened to render, which was fine while the map was the only page and
 * becomes a lie on four routes the moment it is not — the browser tab and the
 * history entry both say it before React has booted. The daemon dispatches off
 * this same Map, so a page that exists here exists at that URL and a URL that
 * is not here is a 404 rather than a silently wrong page.
 */
const PAGES = new Map([
  ['/ui', 'vnodes — overview'],
  ['/ui/map', 'vnodes — dependency map'],
  ['/ui/capsule', 'vnodes — capsule preview'],
  ['/ui/notes', 'vnodes — notes'],
  ['/ui/index', 'vnodes — index composition'],
]);

/** What the shell cannot render without. */
const ENTRY_ASSETS = ['map.js', 'map.css'];
/** Chunks the entry loads lazily, named in the entry's own source when they exist. */
const LAZY_ASSETS = ['map-App.js'];

let entryCache = { key: '', text: '' };
function entrySource() {
  const file = path.join(STATIC_DIR, 'map.js');
  try {
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    if (entryCache.key !== key) entryCache = { key, text: fs.readFileSync(file, 'utf8') };
    return entryCache.text;
  } catch { return ''; }
}

/**
 * Which required files are absent, by name.
 *
 * React Flow is split out of the entry with `lazy()`, so a missing chunk is not
 * a missing stylesheet — it rejects at import time and React renders nothing,
 * which is exactly the silent blank page the omission rule exists to prevent.
 * The chunk is only demanded when the entry actually names it: an unsplit build
 * never emits it, and failing a page over a file its own bundle does not want
 * would be a second way to black out something that works.
 */
function missingAssets() {
  const missing = ENTRY_ASSETS.filter(n => !fs.existsSync(path.join(STATIC_DIR, n)));
  if (missing.includes('map.js')) return missing;
  const entry = entrySource();
  for (const n of LAZY_ASSETS) {
    if (entry.includes(n) && !fs.existsSync(path.join(STATIC_DIR, n))) missing.push(n);
  }
  return missing;
}

/** Whether the bundle has been built. Drives the message below rather than a 404. */
function bundleReady() {
  return missingAssets().length === 0;
}

function renderShell(pathname = '/ui/map') {
  const missing = missingAssets();
  if (missing.length) return renderMissingBundle(missing);
  const title = PAGES.get(pathname) || 'vnodes';
  // Only the map pays for the React Flow chunk up front. On the other four
  // pages it is a quarter-megabyte the reader will probably never open, and
  // preloading it there would undo the split that made the pages cheap.
  const preload = pathname === '/ui/map' && fs.existsSync(path.join(STATIC_DIR, 'map-App.js'))
    ? '\n<link rel="modulepreload" href="/ui/static/map-App.js">' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/ui/static/map.css">${preload}
</head>
<body>
<div id="root"></div>
<script type="module" src="/ui/static/map.js"></script>
</body>
</html>`;
}

/**
 * A checkout with no bundle is a working tree mid-change, not a broken install —
 * the published repo carries the built files. Say which case it is and how to
 * get out of it, rather than serving a blank page.
 */
function renderMissingBundle(missing = missingAssets()) {
  const names = missing.map(n => `<code>src/view/static/${n}</code>`).join(', ') || '<code>the bundle</code>';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>vnodes — UI not built</title>
<link rel="stylesheet" href="/ui/theme.css">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
<h1>the UI is not built</h1>
<p>${names} ${missing.length === 1 ? 'is' : 'are'} missing. The bundle is
committed, so this is a working tree where it was removed or never checked
out.</p>
<pre>cd ui &amp;&amp; npm install &amp;&amp; npm run build</pre>
<p>Nothing else is broken. <a href="/ui/status">/ui/status</a> is the plain-HTML
status page, which needs no bundle at all, and
<a href="/ui/map/data">/ui/map/data</a> is the payload the map would have
drawn.</p>
</body>
</html>`;
}

module.exports = { readAsset, renderShell, renderMissingBundle, bundleReady, missingAssets, PAGES, STATIC_DIR };
