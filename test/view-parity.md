# Map surface — rendering parity checklist

The other half of `view.test.js`. That file pins what can be asserted: the
slice, the overlay, the graph claims. This file lists what only an eye can
judge — everything `src/view/page.js` and the geometry half of `model.js`
render — because those ~1,500 lines are the ones a replacement visualizer
deletes, and tests written against them would be deleted with them.

Verified against `3a1134b`. Check each row against the new renderer before the
swap is called done.

## Page structure

- [ ] Sticky header with live totals: `N file(s) indexed · N drawn · N edge(s)`,
      cycles appended in bold when non-zero.
- [ ] Scope heading reads `around <target>` / `capsule for this task` /
      `whole project`, matching what was actually queried.
- [ ] Stat row: files, edges, symbols, focus, cycles, isolated — each lit only
      when its count is above zero.
- [ ] Query form: target, task, depth, repo. Submit button shows `drawing…`
      while a capsule query runs (it reads files off disk; silent is dead).

## The four states

- [ ] **Normal** — graph drawn.
- [ ] **Unresolved target** — `no match` card naming the target, with the hint
      to try a path suffix or an exported symbol. Never falls back to drawing
      the whole project.
- [ ] **Empty index** — `Nothing indexed yet` with the `vnodes index` hint.
- [ ] **Trimmed** — notice stating `Showing N of M files`, most-connected
      first, pointing at `ui.map_max_nodes`. **This one is an invariant, not a
      preference.** A map that quietly omits files reads as a complete map of a
      small project.

## Node rendering

- [ ] Directory line above, elided from the left when long.
- [ ] Basename wrapped to at most 3 lines, ellipsis past that.
- [ ] Meta line: language, symbol count, in/out degree.
- [ ] Uniform box height across the slice — differing heights in a row read as
      a hierarchy that is not there.
- [ ] One box size, chosen automatically by node count, overridable by the
      density toggle in either direction.

## The five marks

Scarcity is the point; a second meaning on one colour costs the first its force.

- [ ] `focus` — capsule pivots and the resolved target, lit.
- [ ] `supporter` — capsule skeletons, amber.
- [ ] `inCycle` — files inside an import cycle.
- [ ] `isolated` — no local edge either way.
- [ ] cross-repo — edges leaving the repo.
- [ ] Legend naming all five.

## Layout and edges

- [ ] Left-to-right dependency order: a file sits right of its deepest
      dependency.
- [ ] Columns spill to a second column past the row cap, and a level always
      starts right of every shallower one.
- [ ] Within a column: connected before isolated, then by degree.
- [ ] Arrows run dependency-first — imported file on the left, importer on the
      right, arrowhead pointing the way the dependency runs.
- [ ] Cycle edges drawn distinctly (own marker).
- [ ] Node ids follow path order, so a file keeps its id across renders.

## Interaction

- [ ] Drag to pan.
- [ ] Zoom: ⌘/ctrl+wheel, `+`, `-`, `0` to reset; level shown in an
      `aria-live` region.
- [ ] Fit-to-viewport on load and on resize — unless the user has zoomed, which
      wins.
- [ ] Hover or keyboard focus emphasises a node and its edges.
- [ ] Filter box dims non-matching paths.
- [ ] Click or Enter/Space on a node opens the detail panel:
      `GET /ui/map/node?file=` → path, language, size, symbols with kind and
      line, dependencies and dependents as clickable lists.
- [ ] Escape closes the panel.
- [ ] Every node reachable by keyboard, not mouse-only.

## Live updates

- [ ] `EventSource('/ui/map/events' + location.search)` — the frame carries the
      app and totals regions.
- [ ] Frames push on **index generation change**, not on a timer.
- [ ] `body[data-live]` reflects connection state; `onerror` sets it to `0`.
- [ ] Across an update: zoom restored, scroll position kept (unless the graph
      shrank past it), filter text put back — a reindex must not silently widen
      what you are looking at.

## The banners

- [ ] Cycle banner: count, the first five cycles as `a → b → c → a`, and
      `…and N more` past that.
- [ ] Capsule banner: the task, the resolved intent, the pivot list, and the
      `vnodes pipeline "<task>"` command that reproduces it.
      `no pivot matched` when the capsule came back empty.

## Constraints the page itself carries

- [ ] Self-contained: no CDN, no web font, no outbound request of any kind.
- [ ] `/ui/theme.css` stays the styling insertion point.
- [ ] `escapeHtml` on every interpolated value — paths and symbol names are
      file contents, not trusted strings.
- [ ] No build step: served as-is from source.
