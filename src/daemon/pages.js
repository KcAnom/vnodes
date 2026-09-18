'use strict';
/**
 * The two pages that must render when the bundle does not.
 *
 * `/ui/status` and the 404 for an unknown `/ui` path, plus the stylesheet that
 * dresses both. They live apart from the router because they answer a different
 * question from everything else the daemon serves: not "what does vnodes know"
 * but "is anything working at all". Nothing here imports the React bundle, the
 * store, or the registry, and nothing here may grow a dependency that could be
 * the reason it fails to render.
 *
 * The navigation each one carries is not decoration. The rail lives inside the
 * bundle, so a reader who follows the rail's own "plain" link, or mistypes a
 * URL, arrives somewhere the rail cannot reach them.
 */

/**
 * The 404 a browser gets for a /ui path nothing serves.
 *
 * Shares the no-bundle stylesheet and the same nav as the plain status page,
 * for the same reason: the rail lives in the bundle, and a reader who mistyped
 * a URL never reached a page that could load it. The page list is the router's
 * own `PAGES`, so it cannot drift from what is actually served.
 */
function uiNotFound(pathname) {
  const { PAGES } = require('../view/shell');
  const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>vnodes — no such page</title>
<link rel="stylesheet" href="/ui/theme.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main>
<nav aria-label="pages">
${[...PAGES.keys()].map(p => `<a href="${p}">${p === '/ui' ? '&larr; overview' : escape(p.replace('/ui/', ''))}</a>`).join('\n')}
<a href="/ui/status">plain status</a>
</nav>
<h1>no such page</h1>
<p><code>${escape(pathname)}</code> is not a page this daemon serves. Every page
it does serve is linked above.</p>
</main></body></html>`;
}

function uiHtml(cfg) {
  // The no-JS floor at /ui/status. This page exists precisely because the rest
  // of /ui is now a React bundle: when the bundle is missing, stale or throws
  // on boot, something still has to answer the question "is the daemon alive
  // and what does it think it has indexed", and it has to answer without
  // depending on any of the machinery that might be what broke. Plain HTML, one
  // fetch loop, no build step. It is also the only remaining reader of
  // cfg.ui.sidebar_refresh_s.
  // Number() before interpolation: a garbage config value used to reach
  // setInterval as NaN, which Node coerces to a 1 ms delay — a thousand
  // fetches a second on the one page that must render when everything else
  // broke. (The multiplication also meant the value could never inject into
  // the inline script; this makes the fallback explicit too.)
  const refreshS = Number(cfg.ui.sidebar_refresh_s) > 0 ? Number(cfg.ui.sidebar_refresh_s) : 10;
  const refreshMs = refreshS * 1000;
  return `<!doctype html><html><head><meta charset="utf-8"><title>vnodes — status</title>
<link rel="stylesheet" href="/ui/theme.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main>
<!-- The way back, before anything else. The rail that carries every other page
     is inside the bundle, so a reader who arrives here has no navigation at all
     unless this page provides its own — and this is a page people reach by
     choice from that rail, not only by falling into it. If the bundle really is
     broken these links land on the missing-bundle notice, which links back
     here, so the loop closes either way. -->
<nav aria-label="pages">
<a href="/ui">&larr; overview</a>
<a href="/ui/bases">knowledge bases</a>
<a href="/ui/map">map</a>
<a href="/ui/capsule">capsule</a>
<a href="/ui/notes">notes</a>
<a href="/ui/index">index composition</a>
</nav>
<h1>vnodes</h1><p id="state">loading…</p>
<dl><dt>Files</dt><dd id="files">–</dd><dt>Nodes</dt><dd id="nodes">–</dd>
<dt>Edges</dt><dd id="edges">–</dd><dt>Repos</dt><dd id="repos">–</dd>
<dt>Last index</dt><dd id="last">–</dd></dl>
<p>This is the plain-HTML status page. It reports on this daemon's own launch
project only — the other pages can be pointed at any knowledge base with
<code>?kb=</code>, and this one cannot. Every page linked above needs the built
bundle; this one is the floor that does not.</p>
<script>
async function tick(){try{const r=await fetch('/status');const s=await r.json();
if(s.index.state==='hub'){document.getElementById('state').textContent=
'hub — no launch project; pick a knowledge base at /ui/bases';
for(const k of ['files','nodes','edges','repos','last'])document.getElementById(k).textContent='– (no project)';
return;}
document.getElementById('state').textContent='daemon running · index '+s.index.state;
for(const k of ['files','nodes','edges'])document.getElementById(k).textContent=s.index[k]??'–';
document.getElementById('repos').textContent=(s.index.repos||[]).join(', ')||'–';
document.getElementById('last').textContent=s.index.last_index?new Date(s.index.last_index).toLocaleString():'–';
}catch(e){document.getElementById('state').textContent='daemon unreachable';}}
tick();setInterval(tick,${refreshMs});
</script></main></body></html>`;
}

function uiThemeCss() {
  // Not the design-system seam any more — that moved into the bundle
  // (ui/src/theme.css) when the whole UI became one React shell. This
  // stylesheet dresses exactly two pages, and both of them are the ones that
  // have to render when the bundle does not: /ui/status and the missing-bundle
  // notice. Keep it small enough to never be the reason either fails.
  return `/* vnodes — the stylesheet for the pages that must work with no bundle:
   /ui/status and the missing-bundle notice. The design system lives in the
   bundle (ui/src/theme.css); nothing here is a seam for it. */
:root { color-scheme: light dark; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; line-height: 1.5; max-width: 46rem; }
dt { font-weight: 600; }
dd { margin: 0 0 0.5rem 0; }
code, pre { font-family: inherit; }
/* Navigation. Laid out with flex-wrap and a gap and nothing else: no colour of
   its own, no custom properties, no border that has to resolve against a theme.
   The default link colour already answers to color-scheme in both themes, and
   this stylesheet dresses the two pages that must render when everything else
   has failed — so every rule here is one that cannot itself be the failure. */
nav { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.75rem; }`;
}

module.exports = { uiHtml, uiThemeCss, uiNotFound };
