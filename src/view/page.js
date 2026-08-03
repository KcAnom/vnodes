'use strict';
/**
 * HTML rendering for the vnodes dependency map.
 *
 * Ported from trailhead's `05-view/src/page.ts` (MIT, github.com/KcAnom/trailhead).
 * The page is generated from source rather than served from a static file for
 * the same reason it was there: this is a zero-dependency package with no build
 * step, and a loose .html/.css would be one more thing to keep in sync with the
 * module that fills it in.
 *
 * `renderPage` produces the whole document once; `renderApp` produces just the
 * part live updates replace. Both go through the same renderer, so there is no
 * second implementation in the browser that could drift.
 *
 * Styling note (owner build directive 2): `/ui/theme.css` stays the design
 * system insertion seam. The map ships its own baseline inline — an unstyled
 * SVG graph is not a degraded map, it is an unreadable one — and then links
 * theme.css *after* it, so anything dropped there still wins.
 */
// Node measurements arrive on the view (`view.geom`) rather than being imported
// here. The renderer and the layout must agree on box size to the pixel, and
// two modules reading the same constant is not agreement — it is a coincidence
// that survives until one of them starts choosing between two sizes.

/**
 * Every value on this page comes off disk — file paths, symbol names, the
 * task string the operator typed. A file named `<script>.js` is text, not
 * markup.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Void black, one bone-white ink at four opacities, hairline alpha borders
 * instead of shadows, 20px cards / 12px controls, one easing curve.
 *
 * Two places where the look meets this tool rather than the other way round:
 *
 * - **Lime is focus.** The accent is reserved for "active / alive", and its
 *   power is scarcity. On this map the live thing is what the query is about —
 *   the resolved target, or a capsule's pivot files. Nothing else gets it.
 *   Capsule supporters (skeletons, not full content) are amber: present, but
 *   not the subject.
 * - **Fonts are named but never fetched.** This is a tool whose whole claim is
 *   zero outbound network calls; it may not reach a font CDN. The named faces
 *   lead each stack and are used if installed, system faces follow.
 */
const STYLE = `
:root {
  --vn-void: #0A0A0A;
  --vn-surface: rgba(233,236,224,0.03);
  --vn-surface-hover: rgba(233,236,224,0.05);
  --vn-border: rgba(233,236,224,0.08);
  --vn-border-hover: rgba(233,236,224,0.12);
  --vn-border-strong: rgba(233,236,224,0.18);

  --vn-accent: #9DD522;
  --vn-accent-bright: #D3ED2F;
  --vn-accent-muted: rgba(157,213,34,0.12);

  --vn-text-primary: #E9ECE0;
  --vn-text-secondary: rgba(233,236,224,0.65);
  --vn-text-tertiary: rgba(233,236,224,0.35);
  --vn-text-muted: rgba(233,236,224,0.20);

  --vn-success: #22C55E;
  --vn-warning: #F59E0B;
  --vn-danger: #EF4444;
  --vn-stopped: #6B7280;

  --vn-font-display: "Clash Display", ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  --vn-font-body: "Satoshi", ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  --vn-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --vn-radius-card: 20px;
  --vn-radius-btn: 12px;
  --vn-radius-pill: 9999px;

  --vn-ease-out: cubic-bezier(0.32, 0.72, 0, 1);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--vn-void);
  color: var(--vn-text-primary);
  font-family: var(--vn-font-body);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  min-height: 100dvh;
  overflow-x: hidden;
}
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: var(--vn-radius-pill); }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
/* The graph is the one place a hairline scrollbar actively hides content: a
   4px track on a 2500px-wide canvas reads as "this is the whole map". */
.viewport::-webkit-scrollbar { width: 11px; height: 11px; }
.viewport::-webkit-scrollbar-thumb {
  background: rgba(233,236,224,0.22); border-radius: var(--vn-radius-pill);
  border: 3px solid transparent; background-clip: content-box;
}
.viewport::-webkit-scrollbar-thumb:hover { background: rgba(233,236,224,0.38); background-clip: content-box; }
.viewport { scrollbar-width: auto; scrollbar-color: rgba(233,236,224,0.28) transparent; }

.noise-overlay {
  position: fixed; inset: 0; z-index: 1; pointer-events: none; opacity: 0.025;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat: repeat; background-size: 256px 256px;
}

/* Floating nav island — the signature element. */
header {
  position: sticky; top: 12px; z-index: 100;
  width: max-content; max-width: calc(100% - 32px); margin: 12px auto 0;
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px 8px 12px; border-radius: var(--vn-radius-pill);
  background: rgba(10,10,10,0.88);
  backdrop-filter: blur(32px) saturate(1.4);
  -webkit-backdrop-filter: blur(32px) saturate(1.4);
  box-shadow: 0 0 0 1px rgba(233,236,224,0.03), 0 8px 32px rgba(0,0,0,0.6);
  transition: box-shadow 300ms var(--vn-ease-out);
}
header:hover { box-shadow: 0 0 0 1px rgba(233,236,224,0.03), 0 12px 48px rgba(0,0,0,0.7); }
header h1 {
  margin: 0; font-family: var(--vn-font-display); font-size: 14px; font-weight: 600;
  letter-spacing: -0.01em; color: var(--vn-text-primary);
}
header .root {
  font-family: var(--vn-font-mono); font-size: 11px; color: var(--vn-text-tertiary);
  max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
header .divider { width: 1px; height: 20px; background: rgba(255,255,255,0.06); }
.totals { font-family: var(--vn-font-mono); font-size: 11px; color: var(--vn-text-tertiary); white-space: nowrap; }
.totals b { color: var(--vn-danger); font-weight: 700; }

/* Status indicator: dot + glow, alive pulses on the house 2s. */
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vn-text-tertiary); }
.live::before {
  content: ''; width: 8px; height: 8px; border-radius: var(--vn-radius-pill);
  background: var(--vn-accent); box-shadow: 0 0 6px currentColor; color: var(--vn-accent);
  animation: vn-pulse 2s ease-in-out infinite;
}
body[data-live="0"] .live::before { background: var(--vn-danger); color: var(--vn-danger); animation: vn-offline 1.5s infinite; }
body[data-live="0"] .live .label::after { content: ' — reconnecting'; }
@keyframes vn-pulse { 0%,100% { box-shadow: 0 0 8px currentColor } 50% { box-shadow: 0 0 16px currentColor } }
@keyframes vn-offline { 0%,100% { opacity: 1 } 50% { opacity: .45 } }

main {
  position: relative; z-index: 2;
  padding: 24px 32px 32px; display: grid; gap: 20px; max-width: 1440px; margin: 0 auto;
  /* A grid track sizes to auto by default, meaning "as wide as my widest
     child wants to be" — and one child here contains a 2,500px SVG. Without
     this the cards grew past the window, and body's overflow-x:hidden then
     made the overflowing part unreachable rather than merely off-screen.
     Every scrolling container below needs the same floor for the same reason. */
  grid-template-columns: minmax(0, 1fr);
}
main > *, .card > * { min-width: 0; }

/* Query bar. A whole-repo map is the wrong default on a real codebase — the
   useful question is always "around what?", so the controls come first. */
form.query {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;
  background: var(--vn-surface); border: 1px solid var(--vn-border);
  border-radius: var(--vn-radius-card); padding: 14px 16px;
}
form.query label {
  display: flex; flex-direction: column; gap: 5px;
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--vn-text-muted);
}
form.query input {
  background: rgba(233,236,224,0.04); border: 1px solid var(--vn-border-strong);
  border-radius: var(--vn-radius-btn); padding: 7px 11px;
  font-family: var(--vn-font-mono); font-size: 12px; color: var(--vn-text-primary);
  outline: none; transition: border-color 200ms var(--vn-ease-out);
}
form.query input:focus { border-color: rgba(157,213,34,0.45); }
form.query input.target { min-width: 260px; }
form.query input.task { min-width: 300px; flex: 1; }
form.query input.depth { width: 74px; }
form.query button {
  background: var(--vn-accent-muted); border: 1px solid rgba(157,213,34,0.30);
  color: var(--vn-accent-bright); border-radius: var(--vn-radius-btn);
  padding: 8px 18px; font-family: var(--vn-font-body); font-size: 12px; font-weight: 600;
  cursor: pointer; transition: background 200ms var(--vn-ease-out);
}
form.query button:hover { background: rgba(157,213,34,0.20); }
form.query a.clear { font-size: 11px; color: var(--vn-text-muted); text-decoration: none; padding-bottom: 9px; }
form.query a.clear:hover { color: var(--vn-text-secondary); }

.card {
  background: var(--vn-surface); border: 1px solid var(--vn-border);
  border-radius: var(--vn-radius-card); padding: 18px;
  transition: background 400ms var(--vn-ease-out), border-color 400ms var(--vn-ease-out);
}
.card:hover { background: var(--vn-surface-hover); border-color: var(--vn-border-hover); }
.card > h2 {
  margin: 0 0 4px; font-family: var(--vn-font-mono); font-size: 10px; font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.12em; color: var(--vn-text-muted);
}
.scope {
  margin: 0 0 6px; font-family: var(--vn-font-display); font-size: 26px; font-weight: 600;
  letter-spacing: -0.03em; line-height: 1.15; color: var(--vn-text-primary);
  overflow-wrap: anywhere;
}
.notes { margin: 0 0 14px; color: var(--vn-text-secondary); font-size: 12.5px; font-weight: 500; }

/* Status chips: colored text, same color at 10–15% fill, 20% border. Never solid. */
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.stat {
  display: inline-flex; align-items: baseline; gap: 6px;
  border-radius: var(--vn-radius-pill); padding: 3px 10px;
  font-size: 11px; font-weight: 500; letter-spacing: 0.02em;
  background: rgba(233,236,224,0.04); border: 1px solid transparent; color: var(--vn-text-tertiary);
}
.stat b { font-family: var(--vn-font-mono); font-weight: 700; color: var(--vn-text-secondary); }
.stat.on.focus { background: var(--vn-accent-muted); border-color: rgba(157,213,34,0.20); color: var(--vn-accent); }
.stat.on.focus b { color: var(--vn-accent); }
.stat.on.support { background: rgba(245,158,11,0.10); border-color: rgba(245,158,11,0.20); color: var(--vn-warning); }
.stat.on.support b { color: var(--vn-warning); }
.stat.on.cycle { background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.20); color: var(--vn-danger); }
.stat.on.cycle b { color: var(--vn-danger); }
.stat.on.isolated { background: rgba(107,114,128,0.12); border-color: rgba(107,114,128,0.22); color: var(--vn-stopped); }
.stat.on.isolated b { color: var(--vn-stopped); }

/* The only in-page glows: alive is lime, broken is red. Nothing else glows. */
.banner {
  background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.20);
  box-shadow: 0 0 0 1px rgba(239,68,68,0.15), 0 0 24px rgba(239,68,68,0.12);
  padding: 12px 16px; border-radius: var(--vn-radius-btn); margin-bottom: 16px;
  font-size: 12.5px; font-weight: 500; color: var(--vn-text-secondary);
}
.banner b { color: var(--vn-danger); font-weight: 600; }
.banner ul { margin: 8px 0 0; padding-left: 18px; }
.banner li { font-family: var(--vn-font-mono); font-size: 11px; color: var(--vn-text-tertiary); }
.notice {
  background: rgba(245,158,11,0.10); border: 1px solid rgba(245,158,11,0.20);
  padding: 12px 16px; border-radius: var(--vn-radius-btn); margin-bottom: 16px;
  font-size: 12.5px; font-weight: 500; color: var(--vn-text-secondary);
}
.notice b { color: var(--vn-warning); font-weight: 600; }
.capsule {
  background: var(--vn-accent-muted); border: 1px solid rgba(157,213,34,0.20);
  padding: 12px 16px; border-radius: var(--vn-radius-btn); margin-bottom: 16px;
  font-size: 12.5px; font-weight: 500; color: var(--vn-text-secondary);
}
.capsule b { color: var(--vn-accent); font-weight: 600; }
.capsule .files { font-family: var(--vn-font-mono); color: var(--vn-text-primary); font-weight: 500; }
code {
  font-family: var(--vn-font-mono); font-size: 11px;
  background: rgba(233,236,224,0.04); border: 1px solid var(--vn-border-strong);
  padding: 2px 7px; border-radius: 8px; color: var(--vn-text-secondary);
}

/* Graph toolbar. Zoom lives next to the thing it zooms — a control bar at the
   top of the page would scroll away from the canvas it acts on. */
.gtools {
  display: flex; align-items: center; gap: 6px; row-gap: 8px; flex-wrap: wrap; margin-bottom: 8px;
  /* Stays with the canvas while the page scrolls; the header island is ~40px
     tall and sticks at 12px, so this clears it. */
  position: sticky; top: 62px; z-index: 5;
  background: rgba(10,10,10,0.92); padding: 6px 0;
}
.gtools input.filter {
  background: rgba(233,236,224,0.04); border: 1px solid var(--vn-border-strong);
  border-radius: var(--vn-radius-btn); padding: 5px 11px; min-width: 150px;
  font-family: var(--vn-font-mono); font-size: 11px; color: var(--vn-text-primary); outline: none;
}
.gtools input.filter:focus { border-color: rgba(157,213,34,0.45); }
.gtools input.filter::placeholder { color: var(--vn-text-muted); }
.gtools button, .gtools a {
  background: rgba(233,236,224,0.04); border: 1px solid var(--vn-border-strong);
  color: var(--vn-text-secondary); border-radius: var(--vn-radius-btn);
  padding: 5px 11px; font-family: var(--vn-font-mono); font-size: 11px; font-weight: 500;
  cursor: pointer; text-decoration: none; line-height: 1.6;
  transition: color 200ms var(--vn-ease-out), border-color 200ms var(--vn-ease-out);
}
.gtools button:hover, .gtools a:hover { color: var(--vn-text-primary); border-color: var(--vn-border-hover); }
.gtools a.on { color: var(--vn-accent); border-color: rgba(157,213,34,0.35); }
.gtools .zoom-level {
  font-family: var(--vn-font-mono); font-size: 11px; color: var(--vn-text-muted);
  min-width: 4ch; text-align: center;
}
/* The key belongs beside the controls, above the canvas: below a 66vh
   viewport it was a scroll away from the colours it names. It takes the
   leftover width and wraps inside itself — as a rigid block it was pushed
   off the card edge and lost its last entry. */
/* An explicit flex-basis: sized automatically, the key kept its place and had
   its last entry sliced off by the card edge. Given a basis it drops to a row
   of its own as soon as there is less than that much space, which is the only
   behaviour that cannot clip. */
.gtools .legend {
  margin-top: 0; flex: 1 1 330px; min-width: 0; gap: 12px;
  justify-content: flex-end; flex-wrap: wrap; padding-right: 2px;
}
.ghint {
  margin: 8px 2px 0; font-size: 10px; letter-spacing: 0.04em;
  color: var(--vn-text-muted); overflow-wrap: anywhere;
}
/* Keyboard users get the same affordance as the mouse. */
.gtools button:focus-visible, .gtools a:focus-visible,
form.query input:focus-visible, form.query button:focus-visible,
aside#detail button:focus-visible, aside#detail a:focus-visible {
  outline: 2px solid var(--vn-accent); outline-offset: 2px;
}

/* The canvas is bounded on both axes. Unbounded, a 40-file graph makes a
   1,000px-tall card and the legend below it never comes into view. */
.viewport {
  overflow: auto; border: 1px solid var(--vn-border);
  border-radius: var(--vn-radius-btn); padding: 8px; background: rgba(233,236,224,0.015);
  /* Short enough that the legend and the hint below it are on screen with the
     graph, not a scroll away from the thing they explain. */
  max-height: min(66vh, 820px); min-width: 0; max-width: 100%;
  overscroll-behavior: contain; cursor: grab;
}
.viewport[data-panning="1"] { cursor: grabbing; }
.viewport svg { display: block; }
.node { cursor: pointer; }
.node rect { rx: 12; stroke-width: 1px; fill: var(--vn-surface); stroke: var(--vn-border-hover); }
.node:hover rect { stroke: var(--vn-border-strong); fill: var(--vn-surface-hover); }
.node text { font-family: var(--vn-font-body); font-size: 12px; font-weight: 500; fill: var(--vn-text-secondary); }
.node .label { fill: var(--vn-text-primary); font-weight: 600; font-size: 12.5px; }
.node .dir { font-family: var(--vn-font-mono); font-size: 11px; font-weight: 500; fill: var(--vn-text-tertiary); }
.node .meta {
  font-family: var(--vn-font-mono); font-size: 10px; font-weight: 500;
  /* Tertiary, not muted: this line carries the degree counts, which are the
     reason to read a box at all. At 20% they were decoration. */
  letter-spacing: 0.04em; fill: var(--vn-text-tertiary);
}
.node.isolated rect { stroke: rgba(107,114,128,0.35); stroke-dasharray: 3 4; fill: rgba(255,255,255,0.02); }
.node.isolated .dir, .node.isolated .label { opacity: .55; }
.node.support rect { stroke: rgba(245,158,11,0.45); fill: rgba(245,158,11,0.06); }
.node.support .meta { fill: var(--vn-warning); }
/* The lime signal: exactly one meaning — what this query is about. */
.node.focus rect { stroke: var(--vn-accent); fill: var(--vn-accent-muted); }
.node.focus .dir, .node.focus .label { fill: var(--vn-accent-bright); }
.node.cycle rect {
  stroke: var(--vn-danger); fill: rgba(239,68,68,0.10);
  filter: drop-shadow(0 0 12px rgba(239,68,68,0.25));
}
.node.cycle .dir, .node.cycle .label { fill: var(--vn-danger); }
.node.dimmed { opacity: .34; }
/* Emphasis: hovering or selecting a file pushes everything it does not touch
   into the background. On a graph this dense, "which lines are mine" is not
   answerable by following a curve with your eye. */
.viewport svg .node, .viewport svg .edge { transition: opacity 160ms var(--vn-ease-out); }
.viewport svg.emphasising .node.faded { opacity: .08; }
.viewport svg.emphasising .edge.faded { opacity: .05; }
.node.active rect { stroke: var(--vn-text-primary); stroke-width: 1.6px; }
.node:focus-visible { outline: none; }
.node:focus-visible rect { stroke: var(--vn-accent-bright); stroke-width: 2px; }
.edge.hot { stroke: var(--vn-accent); stroke-width: 2px; opacity: 1; }
.edge { fill: none; stroke: rgba(233,236,224,0.22); stroke-width: 1.4px; }
.edge.cross { stroke: var(--vn-success); opacity: .55; stroke-dasharray: 4 4; }
.edge.cycle { stroke: var(--vn-danger); stroke-width: 2px; }

.legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; }
.legend span {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--vn-text-muted);
}
.legend span::before {
  content: ''; width: 8px; height: 8px; border-radius: 3px;
  border: 1px solid currentColor; background: currentColor;
}
.legend .k-focus { color: var(--vn-accent); }
.legend .k-support { color: var(--vn-warning); }
.legend .k-cycle { color: var(--vn-danger); }
.legend .k-isolated { color: var(--vn-stopped); }
.legend .k-cross { color: var(--vn-success); }

/* Detail drawer. Read-only, like everything else here. */
aside#detail {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(430px, 92vw); z-index: 200;
  background: rgba(10,10,10,0.96); border-left: 1px solid var(--vn-border-hover);
  backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
  padding: 22px 22px 40px; overflow-y: auto;
  transform: translateX(100%); transition: transform 400ms var(--vn-ease-out);
}
aside#detail[data-open="1"] { transform: translateX(0); }
/* Wide screens make room for the drawer instead of letting it sit on top of
   the map — the usual reason to open a file's detail is to compare it with
   what is drawn behind it. */
@media (min-width: 1180px) {
  body[data-detail="1"] main, body[data-detail="1"] .readonly { padding-right: 470px; }
  main, .readonly { transition: padding-right 400ms var(--vn-ease-out); }
}
aside#detail h3 {
  margin: 0 0 2px; font-family: var(--vn-font-display); font-size: 17px; font-weight: 600;
  letter-spacing: -0.02em; overflow-wrap: anywhere;
}
aside#detail .path { font-family: var(--vn-font-mono); font-size: 11px; color: var(--vn-text-tertiary); overflow-wrap: anywhere; }
aside#detail h4 {
  margin: 20px 0 8px; font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--vn-text-muted);
}
aside#detail ul { margin: 0; padding-left: 16px; font-size: 12px; color: var(--vn-text-secondary); }
aside#detail li { margin-bottom: 4px; overflow-wrap: anywhere; }
aside#detail .sym { font-family: var(--vn-font-mono); font-size: 11px; }
aside#detail .sym .kind { color: var(--vn-text-muted); }
aside#detail .sym .ln { color: var(--vn-text-muted); }
aside#detail .empty { color: var(--vn-text-muted); font-size: 11px; margin: 0; }
aside#detail button.close {
  position: absolute; top: 16px; right: 18px; background: transparent; cursor: pointer;
  border: 1px solid var(--vn-border-strong); border-radius: var(--vn-radius-pill);
  width: 26px; height: 26px; color: var(--vn-text-tertiary); font-size: 13px; line-height: 1;
}
aside#detail button.close:hover { color: var(--vn-text-primary); border-color: var(--vn-border-hover); }
aside#detail a.pivot { color: var(--vn-accent); text-decoration: none; }
aside#detail a.pivot:hover { text-decoration: underline; }

.readonly {
  position: relative; z-index: 2; max-width: 1440px; margin: 0 auto;
  padding: 0 32px 32px; color: var(--vn-text-muted); font-size: 11px; font-weight: 500;
}
.empty-state {
  text-align: center; padding: 48px 32px;
  border: 1px dashed rgba(157,213,34,0.25); border-radius: var(--vn-radius-card);
}
.empty-state .glyph { font-size: 32px; opacity: .5; display: block; margin-bottom: 12px; }
.empty-state .title { font-family: var(--vn-font-display); font-size: 15px; font-weight: 600; color: rgba(233,236,224,0.30); margin: 0 0 8px; }
.empty-state .hint { font-size: 11px; color: var(--vn-text-muted); margin: 0; }

/* One entrance, one easing — on first paint only, or every live update would
   re-cascade the whole page.

   The animation is opt-in, gated on a flag only the client script sets. An
   entrance that starts at opacity 0 and relies on an animation to undo it
   is a page that renders blank wherever the animation does not run: script
   blocked, animation stripped, printed, or thumbnailed. Visible is the
   default and motion is the enhancement, never the other way round. */
@keyframes vn-fade-up { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
body[data-anim="1"] .vn-fade-up { animation: vn-fade-up 700ms var(--vn-ease-out) both; }
body[data-anim="1"] .vn-fade-up.d2 { animation-delay: .05s }
body[data-anim="1"] .vn-fade-up.d3 { animation-delay: .10s }
body[data-entered="1"] .vn-fade-up { animation: none; opacity: 1; transform: none; }

@media (max-width: 968px) {
  main, .readonly { padding-left: 16px; padding-right: 16px; }
  header .root { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .vn-fade-up { animation: none !important; opacity: 1 !important; transform: none !important; }
  .live::before { animation: none !important; }
  * { transition: none !important; }
}
`;

// The totals live in the sticky header, outside the main region, so an update
// has to carry them separately — otherwise the header keeps reporting a cycle
// that has since been broken.
//
// No template literals in here: this string is itself inside one.
const CLIENT = `
var app = document.getElementById('app');
var totals = document.getElementById('totals');
var detail = document.getElementById('detail');
var detailBody = document.getElementById('detail-body');

// Motion is opt-in and this is the opt-in: the stylesheet leaves the page
// visible, and only a running script turns the entrance on.
document.body.dataset.anim = '1';
requestAnimationFrame(function () {
  setTimeout(function () { document.body.dataset.entered = '1'; }, 1200);
});

/* ------------------------------------------------------------------ zoom */
// Scale, and whether the user has taken control of it. Before they do, every
// redraw re-fits — a graph that grew by three files should still arrive whole.
// After they zoom, it is theirs and no update may move it.
var scale = 1;
var userZoomed = false;
var MIN_SCALE = 0.2;
var MAX_SCALE = 2.5;

function svgEl() { return document.getElementById('graph-svg'); }
function viewportEl() { return document.getElementById('viewport'); }

function applyScale(next, anchor) {
  var svg = svgEl();
  var vp = viewportEl();
  if (!svg || !vp) return;
  var w = Number(svg.dataset.w);
  var h = Number(svg.dataset.h);
  var prev = scale;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));

  // Keep whatever the user pointed at under the pointer; without this, zooming
  // walks the canvas away from the node being looked at.
  var ax = anchor ? anchor.x : vp.clientWidth / 2;
  var ay = anchor ? anchor.y : vp.clientHeight / 2;
  var gx = (vp.scrollLeft + ax) / prev;
  var gy = (vp.scrollTop + ay) / prev;

  svg.style.width = Math.round(w * scale) + 'px';
  svg.style.height = Math.round(h * scale) + 'px';
  vp.scrollLeft = gx * scale - ax;
  vp.scrollTop = gy * scale - ay;

  var label = document.getElementById('zoom-level');
  if (label) label.textContent = Math.round(scale * 100) + '%';
}

// Below this the 10px meta line stops being text and becomes texture.
var READABLE_SCALE = 0.68;

function fitScale() {
  var svg = svgEl();
  var vp = viewportEl();
  if (!svg || !vp) return 1;
  var w = Number(svg.dataset.w);
  // Width only, and never magnified. Fitting height as well drove a tall graph
  // to 50%, where the labels are unreadable — a picture of everything that
  // tells you nothing is not the same as seeing everything. Past the readable
  // floor the map stops shrinking and you pan instead; the compact toggle is
  // the real answer to a graph that will not fit.
  return Math.max(READABLE_SCALE, Math.min(1, (vp.clientWidth - 18) / w));
}

function fit() {
  applyScale(fitScale());
  var vp = viewportEl();
  if (vp) { vp.scrollLeft = 0; vp.scrollTop = 0; }
}

function restoreZoom() {
  if (userZoomed) applyScale(scale);
  else fit();
}

document.addEventListener('click', function (event) {
  var btn = event.target.closest('.gtools button[data-zoom]');
  if (!btn) return;
  var mode = btn.dataset.zoom;
  if (mode === 'fit') { userZoomed = false; fit(); return; }
  userZoomed = true;
  if (mode === 'in') applyScale(scale * 1.25);
  else if (mode === 'out') applyScale(scale / 1.25);
  else applyScale(1);
});

document.addEventListener('wheel', function (event) {
  var vp = event.target.closest('#viewport');
  if (!vp || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  var box = vp.getBoundingClientRect();
  userZoomed = true;
  applyScale(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
    { x: event.clientX - box.left, y: event.clientY - box.top });
}, { passive: false });

/* ------------------------------------------------------------------- pan */
// Drag-to-pan, with a movement threshold: a click that moved four pixels is
// still a click on a node, not a pan, and swallowing it would make the detail
// drawer feel broken.
var panning = null;
document.addEventListener('pointerdown', function (event) {
  var vp = event.target.closest('#viewport');
  if (!vp || event.button !== 0) return;
  panning = { vp: vp, x: event.clientX, y: event.clientY,
    left: vp.scrollLeft, top: vp.scrollTop, moved: false };
});
document.addEventListener('pointermove', function (event) {
  if (!panning) return;
  var dx = event.clientX - panning.x;
  var dy = event.clientY - panning.y;
  if (!panning.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
  panning.moved = true;
  panning.vp.dataset.panning = '1';
  panning.vp.scrollLeft = panning.left - dx;
  panning.vp.scrollTop = panning.top - dy;
});
document.addEventListener('pointerup', function () {
  if (panning) panning.vp.removeAttribute('data-panning');
  setTimeout(function () { panning = null; }, 0);
});

/* -------------------------------------------------------------- emphasis */
// Two independent reasons a file recedes: it does not match the filter, or it
// is not connected to what the pointer is on. They compose in one pass —
// resolving them separately meant a hover could un-hide a filtered-out file.
var hoverId = null;
var selectedFile = null;
var filterText = '';

function emphasise() {
  var svg = svgEl();
  if (!svg) return;
  var nodes = svg.querySelectorAll('g.node');
  var edges = svg.querySelectorAll('path.edge');

  var anchor = hoverId;
  if (anchor === null && selectedFile) {
    var sel = svg.querySelector('g.node[data-file="' + (window.CSS && CSS.escape ? CSS.escape(selectedFile) : selectedFile) + '"]');
    if (sel) anchor = sel.dataset.id;
  }

  var connected = null;
  if (anchor !== null && anchor !== undefined) {
    connected = {};
    connected[anchor] = true;
    for (var i = 0; i < edges.length; i++) {
      var a = edges[i].dataset.a;
      var b = edges[i].dataset.b;
      if (a === anchor) connected[b] = true;
      else if (b === anchor) connected[a] = true;
    }
  }

  var active = !!filterText || connected !== null;
  svg.classList.toggle('emphasising', active);

  for (var n = 0; n < nodes.length; n++) {
    var node = nodes[n];
    var hit = !filterText || node.dataset.file.toLowerCase().indexOf(filterText) !== -1;
    var near = connected === null || connected[node.dataset.id];
    node.classList.toggle('faded', !(hit && near));
    node.classList.toggle('active', selectedFile === node.dataset.file);
  }
  for (var e = 0; e < edges.length; e++) {
    var edge = edges[e];
    var touches = connected !== null && (connected[edge.dataset.a] && connected[edge.dataset.b]);
    edge.classList.toggle('hot', !!touches);
    edge.classList.toggle('faded', connected !== null ? !touches : !!filterText);
  }
}

document.addEventListener('mouseover', function (event) {
  var node = event.target.closest('g.node[data-id]');
  var next = node ? node.dataset.id : null;
  if (next === hoverId) return;
  hoverId = next;
  emphasise();
});
document.addEventListener('focusin', function (event) {
  var node = event.target.closest ? event.target.closest('g.node[data-id]') : null;
  if (!node) return;
  hoverId = node.dataset.id;
  emphasise();
});
document.addEventListener('input', function (event) {
  if (event.target.id !== 'filter') return;
  filterText = event.target.value.trim().toLowerCase();
  emphasise();
});
document.addEventListener('keydown', function (event) {
  var node = event.target.closest ? event.target.closest('g.node[data-file]') : null;
  if (!node || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  openDetail(node.dataset.file);
});

/* ------------------------------------------------------------------ live */
var source = new EventSource('/ui/map/events' + window.location.search);
source.onmessage = function (event) {
  var next = JSON.parse(event.data);
  var vp = viewportEl();
  var keepLeft = vp ? vp.scrollLeft : 0;
  var keepTop = vp ? vp.scrollTop : 0;
  app.innerHTML = next.app;
  totals.innerHTML = next.totals;
  document.body.dataset.live = '1';
  restoreZoom();
  // The filter box lives inside the replaced region, so its value has to be
  // put back — a reindex must not silently widen what you are looking at.
  var box = document.getElementById('filter');
  if (box && filterText) box.value = filterText;
  hoverId = null;
  emphasise();
  // A live update must not scroll the map out from under whoever is reading
  // it; the position is restored unless the graph shrank past it.
  var after = viewportEl();
  if (after && userZoomed) { after.scrollLeft = keepLeft; after.scrollTop = keepTop; }
};
source.onerror = function () { document.body.dataset.live = '0'; };

// A capsule query runs the real context pipeline, which reads files off disk —
// slow enough that a button with no feedback reads as a dead button.
document.addEventListener('submit', function (event) {
  var button = event.target.querySelector('button[type="submit"]');
  if (!button) return;
  button.textContent = 'drawing…';
  button.style.opacity = '.6';
});

window.addEventListener('resize', function () { if (!userZoomed) fit(); });
requestAnimationFrame(fit);

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function linkList(rows, empty) {
  if (!rows || !rows.length) return '<p class="empty">' + esc(empty) + '</p>';
  return '<ul>' + rows.map(function (r) {
    return '<li><a class="pivot" href="#" data-file="' + esc(r.f) + '">' + esc(r.f) + '</a>'
      + (r.kind && r.kind !== 'import' ? ' <span class="kind">· ' + esc(r.kind) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

function closeDetail() {
  detail.dataset.open = '0';
  document.body.dataset.detail = '0';
  selectedFile = null;
  emphasise();
}

function openDetail(file) {
  detail.dataset.open = '1';
  document.body.dataset.detail = '1';
  selectedFile = file;
  emphasise();
  detailBody.innerHTML = '<p class="empty">loading…</p>';
  fetch('/ui/map/node?file=' + encodeURIComponent(file)).then(function (r) {
    if (!r.ok) throw new Error('not indexed');
    return r.json();
  }).then(function (d) {
    var syms = d.symbols.length
      ? '<ul>' + d.symbols.map(function (s) {
          return '<li class="sym"><span class="kind">' + esc(s.kind) + '</span> ' + esc(s.name)
            + ' <span class="ln">L' + s.line + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="empty">no symbols parsed</p>';
    detailBody.innerHTML =
      '<h3>' + esc(d.file.split('/').pop()) + '</h3>'
      + '<p class="path">' + esc(d.file) + '</p>'
      + '<h4>About</h4><ul><li>' + esc(d.lang || 'unknown') + ' · ' + d.symbols.length + ' symbols · '
      + Math.max(1, Math.round(d.size / 1024)) + ' KB'
      + (d.repo ? ' · repo ' + esc(d.repo) : '') + '</li></ul>'
      + '<h4>Imports (' + d.dependencies.length + ')</h4>' + linkList(d.dependencies, 'imports nothing local')
      + '<h4>Imported by (' + d.dependents.length + ')</h4>' + linkList(d.dependents, 'nothing imports this')
      + '<h4>Skeleton</h4>' + syms;
  }).catch(function () {
    detailBody.innerHTML = '<p class="empty">no indexed detail for this file.</p>';
  });
}

document.addEventListener('click', function (event) {
  // A drag that ended on a node is a pan, not a selection.
  if (panning && panning.moved) return;
  var link = event.target.closest('a.pivot[data-file]');
  if (link) { event.preventDefault(); openDetail(link.dataset.file); return; }
  var node = event.target.closest('g.node[data-file]');
  if (node) { openDetail(node.dataset.file); return; }
  if (event.target.closest('#detail') || event.target.closest('.gtools')) return;
  closeDetail();
});
document.addEventListener('keydown', function (event) {
  if (event.target.tagName === 'INPUT') return;
  if (event.key === 'Escape') { closeDetail(); return; }
  if (event.key === '+' || event.key === '=') { userZoomed = true; applyScale(scale * 1.25); }
  else if (event.key === '-') { userZoomed = true; applyScale(scale / 1.25); }
  else if (event.key === '0') { userZoomed = false; fit(); }
});
`;

/** Vertical room a back-edge needs below the deepest node it passes under. */
const BACKEDGE_DIP = 34;
/** How far a same-column edge bows out to the right to clear the nodes between. */
const SAME_COLUMN_BOW = 34;

/**
 * Dependency's right edge to the dependent's left edge.
 *
 * Two cases are not left-to-right, and both come from import cycles. Drawn as a
 * straight S-curve a back-edge would sweep far off-canvas in both directions,
 * so it routes under everything instead and reads as the loop it is.
 */
function edgePath(edge, byId, floor, nodeHeight, nodeWidth) {
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (!from || !to) return null;

  const x1 = from.x + nodeWidth;
  const y1 = from.y + nodeHeight / 2;
  const x2 = to.x;
  const y2 = to.y + nodeHeight / 2;

  // Same column — which happens inside a cycle, where neither file can be
  // deeper than the other. A direct line would run straight down through
  // whatever sits between them, so bow it out into the gap on the right.
  if (to.x === from.x) {
    const tx = to.x + nodeWidth;
    return `M ${x1} ${y1} C ${x1 + SAME_COLUMN_BOW} ${y1}, ${tx + SAME_COLUMN_BOW} ${y2}, ${tx} ${y2}`;
  }

  if (x2 <= from.x) {
    const sx = from.x + nodeWidth / 2;
    const sy = from.y + nodeHeight;
    const tx = to.x + nodeWidth / 2;
    const ty = to.y + nodeHeight;
    return `M ${sx} ${sy} C ${sx} ${floor}, ${tx} ${floor}, ${tx} ${ty}`;
  }

  const bend = Math.max(30, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function renderGraph(view, query = {}) {
  if (view.nodes.length === 0) return '';
  const byId = new Map(view.nodes.map(n => [n.id, n]));
  const h = view.nodeHeight;
  const geom = view.geom;
  const NW = geom.nodeWidth;

  const pairs = view.edges
    .map(e => ({ from: byId.get(e.from), to: byId.get(e.to) }))
    .filter(p => p.from && p.to);
  const hasBackEdge = pairs.some(p => p.to.x < p.from.x);
  const hasSameColumn = pairs.some(p => p.to.x === p.from.x);

  const floor = view.height + BACKEDGE_DIP;
  const bottom = hasBackEdge ? BACKEDGE_DIP + 12 : 0;
  const right = hasSameColumn ? SAME_COLUMN_BOW + 10 : 0;

  // A capsule overlay answers "what did the agent get handed?", so everything
  // outside it has to recede — at full strength the unselected files read as
  // part of the answer.
  const dimming = view.nodes.some(n => n.supporter);

  const edges = view.edges.map(edge => {
    const path = edgePath(edge, byId, floor, h, NW);
    if (path === null) return '';
    const kind = edge.inCycle ? 'cycle' : edge.kind !== 'import' ? 'cross' : '';
    const marker = edge.inCycle ? 'arrow-alarm' : 'arrow';
    return `<path class="edge ${kind}" data-a="${edge.from}" data-b="${edge.to}" d="${path}" marker-end="url(#${marker})" />`;
  }).join('');

  const nodes = view.nodes.map(node => {
    const classes = ['node'];
    if (node.focus) classes.push('focus');
    else if (node.supporter) classes.push('support');
    if (node.inCycle) classes.push('cycle');
    if (node.isolated && !node.focus) classes.push('isolated');
    if (dimming && !node.focus && !node.supporter) classes.push('dimmed');

    const label = node.lines
      .map((line, i) => `<tspan x="12" y="${geom.titleTop + i * geom.titleLeading}">${escapeHtml(line)}</tspan>`)
      .join('');
    const badge = node.focus ? (node.isRoot ? 'target' : 'pivot')
      : node.supporter ? 'skeleton'
      : node.inCycle ? 'cycle'
      : node.isolated ? 'isolated' : '';
    // The compact box has room for three facts, not four, so the language goes
    // — it is the one already implied by the file extension in the label. The
    // unit stays spelled out: "12s" on a box reads as twelve seconds.
    const meta = geom.compact
      ? `${node.symbols} sym · ↓${node.inDeg} ↑${node.outDeg}`
      : `${node.lang || '?'} · ${node.symbols} sym · ↓${node.inDeg} ↑${node.outDeg}`;

    // Focusable and labelled: a graph you can only reach with a mouse is a
    // graph half the people who need it cannot read.
    const aria = `${node.key}, ${node.symbols} symbols, imported by ${node.inDeg}, imports ${node.outDeg}`
      + (node.inCycle ? ', in an import cycle' : '');
    return `<g class="${classes.join(' ')}" data-file="${escapeHtml(node.key)}" data-id="${node.id}"
  tabindex="0" role="button" aria-label="${escapeHtml(aria)}" transform="translate(${node.x},${node.y})">
  <title>${escapeHtml(node.key)}</title>
  <rect width="${NW}" height="${h}" />
  <g clip-path="url(#node-clip)">
    <text x="12" y="21" class="dir">${escapeHtml(node.dir || '.')}</text>
    <text x="${NW - 12}" y="21" class="meta" text-anchor="end">${escapeHtml(badge)}</text>
    <text class="label">${label}</text>
    <text x="12" y="${h - geom.nodeBottom}" class="meta">${escapeHtml(meta)}</text>
  </g>
</g>`;
  }).join('');

  const height = view.height + bottom;
  const width = view.width + right;
  const density = queryString({ ...query, compact: geom.compact ? '0' : '1' });
  return `<div class="gtools">
  <button type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
  <span class="zoom-level" id="zoom-level" aria-live="polite">100%</span>
  <button type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
  <button type="button" data-zoom="fit" title="Fit the graph to the window">fit</button>
  <button type="button" data-zoom="1" title="Actual size">1:1</button>
  <input class="filter" id="filter" type="search" placeholder="filter by path…"
     aria-label="Filter the drawn files by path" autocomplete="off" />
  <a class="${geom.compact ? 'on' : ''}" href="/ui/map${escapeHtml(density)}"
     title="Smaller boxes fit more of the graph on screen">${geom.compact ? 'compact ✓' : 'compact'}</a>
  <div class="legend">
    <span class="k-focus">focus</span><span class="k-support">skeleton</span>
    <span class="k-cycle">cycle</span><span class="k-isolated">isolated</span>
    <span class="k-cross">cross-repo</span>
  </div>
</div>
<div class="viewport" id="viewport"><svg id="graph-svg" width="${width}" height="${height}"
  data-w="${width}" data-h="${height}"
  viewBox="0 0 ${width} ${height}" role="img" aria-label="dependency graph">
  <defs>
    <clipPath id="node-clip"><rect x="0" y="0" width="${NW}" height="${h}" rx="12" /></clipPath>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(233,236,224,0.35)" />
    </marker>
    <marker id="arrow-alarm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#EF4444" />
    </marker>
  </defs>
  ${edges}
  ${nodes}
</svg></div>
<p class="ghint">Drag to pan · ⌘/ctrl+wheel or <code>+</code> <code>-</code> <code>0</code> to zoom ·
click a node for its skeleton and both edge directions ·
arrows point from a dependency to the file that imports it.</p>`;
}

/** Rebuild the map's own query string, so a toggle keeps the current scope. */
function queryString(params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function scopeLine(view) {
  if (view.target) return `around ${view.target}`;
  if (view.task) return 'capsule for this task';
  return 'whole project';
}

/** The live region — everything an update replaces. */
function renderApp(view, query = {}) {
  if (view.unresolved) {
    return `<section class="card vn-fade-up d2">
  <h2>no match</h2>
  <p class="scope">${escapeHtml(view.target)}</p>
  <p class="notes">No file or symbol by that name is indexed. Try a path suffix
  (<code>src/parser.js</code>) or an exported symbol name.</p>
</section>`;
  }
  if (view.nodes.length === 0) {
    return `<div class="empty-state vn-fade-up d2">
  <span class="glyph">◈</span>
  <p class="title">Nothing indexed yet</p>
  <p class="hint">Run <code>vnodes index</code> — this page fills in by itself.</p>
</div>`;
  }

  const cycleBanner = view.cycles.length
    ? `<div class="banner"><b>${view.cycles.length} import cycle${view.cycles.length === 1 ? '' : 's'}.</b>
       Every file in one imports its way back to itself, so no dependency order exists among them.
       <ul>${view.cycles.slice(0, 5).map(c => `<li>${escapeHtml(c.join(' → '))} → ${escapeHtml(c[0])}</li>`).join('')}</ul>
       ${view.cycles.length > 5 ? `<p class="notes">…and ${view.cycles.length - 5} more.</p>` : ''}</div>`
    : '';

  const truncated = view.dropped > 0
    ? `<div class="notice"><b>Showing ${view.nodes.length} of ${view.nodes.length + view.dropped} files</b>
       in scope, most-connected first. The rest are not drawn — scope the map with a target
       above, or raise <code>ui.map_max_nodes</code>.</div>`
    : '';

  const pivots = view.nodes.filter(n => n.focus);
  const capsule = view.task
    ? `<div class="capsule"><b>Capsule for:</b> ${escapeHtml(view.task)} — intent
       <code>${escapeHtml(view.intent)}</code>. Pivots come through in full, amber files as skeletons,
       everything else was left out.
       <div style="margin-top:8px" class="files">${pivots.map(p => escapeHtml(p.key)).join(' · ') || 'no pivot matched'}</div>
       <div style="margin-top:10px"><code>vnodes pipeline "${escapeHtml(view.task)}"</code></div></div>`
    : '';

  const counts = [
    ['files', view.counts.files, ''],
    ['edges', view.counts.edges, ''],
    ['symbols', view.counts.symbols, ''],
    ['focus', view.counts.focus, 'focus'],
    ['cycles', view.counts.cycles, 'cycle'],
    ['isolated', view.counts.isolated, 'isolated'],
  ];

  return `<section class="card vn-fade-up d2">
  <h2>${escapeHtml(scopeLine(view))}</h2>
  <p class="scope">${escapeHtml(view.target || view.task || view.root)}</p>
  <div class="stats">${counts
    .map(([label, n, kind]) => `<span class="stat${kind && n > 0 ? ` on ${kind}` : ''}">${label} <b>${n}</b></span>`)
    .join('')}</div>
  ${truncated}${cycleBanner}${capsule}
  ${renderGraph(view, query)}
</section>`;
}

/** The header's counts — a live region of their own, in the sticky bar. */
function renderTotals(view) {
  const c = view.counts;
  return `${view.total_files} file(s) indexed · ${c.files} drawn · ${c.edges} edge(s)${
    c.cycles ? ` · <b>${c.cycles} cycle(s)</b>` : ''
  }`;
}

function renderPage(view, query = {}) {
  const target = escapeHtml(query.target || '');
  const task = escapeHtml(query.task || '');
  const depth = escapeHtml(query.depth || 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vnodes map — ${escapeHtml(view.root)}</title>
<style>${STYLE}</style>
<link rel="stylesheet" href="/ui/theme.css" />
</head>
<body data-live="1">
<div class="noise-overlay"></div>
<header>
  <h1>vnodes</h1>
  <span class="divider"></span>
  <span class="root" title="${escapeHtml(view.root)}">${escapeHtml(view.root)}</span>
  <span class="divider"></span>
  <span class="live"><span class="label">live</span></span>
  <span class="divider"></span>
  <span class="totals" id="totals">${renderTotals(view)}</span>
</header>
<main>
  <form class="query vn-fade-up" method="get" action="/ui/map">
    <label>Target file or symbol
      <input class="target" type="text" name="target" value="${target}" placeholder="src/parser.js or parseFile" />
    </label>
    <label>Depth
      <input class="depth" type="number" name="depth" min="1" max="6" value="${depth}" />
    </label>
    <label>Capsule task
      <input class="task" type="text" name="task" value="${task}" placeholder="add rate limiting to the API" />
    </label>
    <button type="submit">Draw</button>
    <a class="clear" href="/ui/map">reset</a>
    ${query.compact ? `<input type="hidden" name="compact" value="${escapeHtml(query.compact)}" />` : ''}
  </form>
  <div id="app">${renderApp(view, query)}</div>
</main>
<aside id="detail" data-open="0">
  <button class="close" type="button" onclick="closeDetail()">×</button>
  <div id="detail-body"></div>
</aside>
<p class="readonly">Read-only view of the local graph at <code>.vnodes/index.db</code>. Indexing and
capsules stay in the CLI and the MCP tools — a second writer over HTTP would race the indexer.</p>
<script>${CLIENT}</script>
</body>
</html>`;
}

/**
 * One SSE frame.
 *
 * Data must be a single line, so both live regions ride together as JSON — the
 * main area and the header totals, which would otherwise go stale.
 */
function sseFrame(view, query = {}) {
  return `data: ${JSON.stringify({ app: renderApp(view, query), totals: renderTotals(view) })}\n\n`;
}

module.exports = { renderPage, renderApp, renderTotals, sseFrame, escapeHtml, queryString };
