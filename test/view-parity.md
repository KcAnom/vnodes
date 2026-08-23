# Map surface — rendering parity

The other half of `view.test.js`. That file pins what can be asserted — the
slice, the capsule overlay, the graph claims. This is what only an eye can
judge: the rendering.

It was written against the server-rendered `src/view/page.js` before that file
was replaced by the React Flow canvas in `ui/`. It now records what carried
over, what changed on purpose, and what is still unverified.

**Verified so far:** the payload (`/ui/map/data`), the routes, the asset
serving, the TypeScript build. **Not yet verified:** anything below marked ☐ —
they need the page open in a browser.

---

## Carried over

The behaviour the old renderer had and the new one must keep.

- ☐ Scope heading reads `around <target>` / `capsule for this task` /
      `whole project`, matching what was queried.
- ☐ Counts: indexed, drawn, edges, symbols, focus, cycles, isolated — each lit
      only when its count is above zero.
- ☐ Query form for target, task, depth. Submits as a GET so the result is a URL
      that can be pasted into a review comment.
- ☐ **Trimmed** — a notice stating `Showing N of M files`. This one is an
      invariant, not a preference: a map that quietly omits files reads as a
      complete map of a small project.
- ☐ **Unresolved target** — a `no match` card naming the target, with the hint
      to try a path suffix or an exported symbol. Never falls back to drawing
      the whole project.
- ☐ **Empty index** — `nothing indexed yet` with the `vnodes index` hint.
- ☐ Cycle banner: the count, the first five as `a → b → c → a`, `…and N more`.
- ☐ Capsule banner: the task, the resolved intent, and the
      `vnodes pipeline "<task>"` that reproduces it.
- ☐ Node body: directory, basename, language, symbol count, in/out degree.
- ☐ The five marks — pivot, skeleton, cycle, isolated, and a legend naming
      them. At most one per node.
- ☐ Left-to-right dependency order, arrows dependency-first: imported file on
      the left, importer on the right.
- ☐ Click a node for the detail panel — symbols with kind and line,
      dependencies and dependents as clickable lists. Escape closes it.
- ☐ Filter by path.
- ☐ Live: frames arrive on an index generation change, not on a timer.
- ☐ Self-contained — no CDN, no web font, no outbound request of any kind.
- ☐ Keyboard-reachable nodes.

## Changed on purpose

Where the new renderer does something different, and why.

| was | is | why |
|---|---|---|
| Node ids stable across renders so a file kept its id | unchanged — ids still come from the server in path order | React Flow keys nodes by id; a shifting id would remount every node on each frame |
| Filter dimmed non-matching nodes | filter dims nodes **and** their edges | an edge between two filtered-out files was still drawn at full strength, which read as a connection to something no longer there |
| Hover emphasised a node and its edges | selection does, hover does not | with a real canvas, hover-emphasis fights the pan gesture |
| Fit on load, and on resize unless the user had zoomed | fit on load and when the drawn node count changes | a reindex that adds files should not leave them off-screen with no hint they exist; one that changes nothing should not move the view |
| Zoom via ⌘/ctrl+wheel and `+`/`-`/`0` | React Flow's own controls, plus a minimap | the minimap is new: it is what makes a 150-node graph navigable |
| `compact` query param for smaller boxes | still server-side, still honoured | unchanged |
| Scroll position restored across a live frame | React Flow holds the viewport across a data change | the old restore existed because innerHTML replacement destroyed it; there is no innerHTML replacement now |
| A theme toggle resolved in JS | `prefers-color-scheme`, overridable by `data-theme` on the root | the map is read beside an editor, so it should follow the system the editor follows |

## Dropped

- The density toggle button. `compact` still works as a query param; the button
  was chrome for a control the layout already makes on its own.
- Hover popovers on node headers. There was nothing to put in them that the
  detail panel does not show better.

## Constraints that still hold

- `/ui/theme.css` remains the styling seam for the rest of the UI surface. The
  map's own tokens live in `ui/src/theme.css` and ship inside the bundle.
- The bundle is committed. Using vnodes still installs nothing and builds
  nothing.
- No outbound network at runtime: the daemon serves the assets off disk.
- Path traversal on `/ui/static/` is refused — asserted in `view.test.js`.
