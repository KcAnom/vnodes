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

/** Whether the bundle has been built. Drives the message below rather than a 404. */
function bundleReady() {
  return fs.existsSync(path.join(STATIC_DIR, 'map.js'));
}

function renderShell() {
  if (!bundleReady()) return renderMissingBundle();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>vnodes — dependency map</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/ui/static/map.css">
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
function renderMissingBundle() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>vnodes — map not built</title>
<link rel="stylesheet" href="/ui/theme.css">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
<h1>the map is not built</h1>
<p><code>src/view/static/map.js</code> is missing. It is committed, so this is a
working tree where it was removed or never checked out.</p>
<pre>cd ui &amp;&amp; npm install &amp;&amp; npm run build</pre>
<p>The data is fine either way — <a href="/ui/map/data">/ui/map/data</a> is the
payload the page would have drawn.</p>
</body>
</html>`;
}

module.exports = { readAsset, renderShell, bundleReady, STATIC_DIR };
