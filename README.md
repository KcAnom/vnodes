# vnodes

Local-first code-graph context engine for AI coding agents. Built as a
black-box behavioral reimplementation of a private blueprint contract,
local-only scope: no licensing, no telemetry, zero outbound network calls,
every feature unconditional. That contract is where the `BR-###` / `ERR-###`
codes in the source point, and where `config/defaults.json` was snapshotted
from; it is not distributed with this repo.

Zero runtime dependencies — Node 22+ only (`node:sqlite` for the graph store).
Nothing to install and nothing to build to use it. The one exception is the
dependency map's browser bundle, which is built from `ui/` and **committed** to
`src/view/static/`; only a contributor changing the map ever runs that
toolchain. It still reaches no network — the daemon serves it off disk.

## What it does

- **Indexing (M1)** — parses a project into a dependency graph at
  `.vnodes/index.db` (gitignored). `manifest.json` (committed) holds per-file
  hashes so clones rebuild incrementally. Secret-named files filtered by
  filename boundary (`.env.example` allowlisted); `.gitignore` +
  `.vnodesignore` + `.vnodes_ignore` + default excludes honored; parse-only,
  files > 512KB skipped. All limits configurable.
- **Context capsules (M2)** — `vnodes pipeline "<task>"`: intent preset
  (auto/explore/debug/modify/refactor; debug pulls tests), graph-ranked pivot
  files in full + supporter skeletons, fitted to a token budget (default 8000),
  with relevant memories attached with rationale.
- **MCP server (M3)** — `vnodes mcp`, MCP over stdio. Ten tools: run_pipeline,
  get_context_capsule, get_impact_graph, search_logic_flow, get_skeleton,
  get_session_context, search_memory, save_observation, index_status,
  workspace_setup. The daemon's HTTP transport (port 7821) shares the same tool
  dispatch but is **not** MCP: `POST /rpc` takes `{tool, arguments, session}`
  and returns a plain JSON result — no JSON-RPC envelope, no `initialize`, no
  `tools/list`. An MCP client that speaks HTTP cannot talk to it; give those
  agents the stdio command.
- **Session memory (M4)** — every tool call auto-captured; observations
  auto-surface with rationale; linked-code changes flag them stale (demoted,
  warned, never deleted).
- **Agent setup (M5)** — `vnodes setup` detects installed agents and writes an
  MCP registration plus an instruction block inside markers; hand-written
  content is never touched, and the instruction block is generated from the
  live tool catalog so it cannot fall behind. `--personal` skips all
  shared-repo writes; `vnodes setup --detect` lists the known agents and which
  of them are installed. Two rules decide the shape of a registration:
  - **Where the config lives decides whether a project root is pinned.** A
    config inside the repo names an absolute root. A config in the home
    directory is shared by every project the agent opens, so it is written
    without one and the server resolves the project upward from its working
    directory — otherwise the last `vnodes setup` to run anywhere would point
    that agent at one repo everywhere.
  - **Agents with no MCP client get instructions only** and reach vnodes
    through the CLI or their own bridge. `src/agents.js` is the source of
    truth for which agents are which, and why.
- **Multi-repo workspaces (M6)** — `.vnodes/workspace.json` (+ auto parent
  pointers in secondary repos); cross-repo shared-type edges; query scoping via
  `repos`, `cross_repo`, `repo`.
- **LLM layer + dual runtime (M7)** — optional; RAM floor honored; the brain is
  the switchable runtime: Claude Code CLI/`claude-opus-5` (default) or the
  `.pi` CLI with `grok-4.5-latest`/`gpt-5.6-sol` — flip via config, env, or flag.
- **Daemon & diagnostics (M8)** — auto-restart on tool call, self-truncating
  daemon/index logs, read-only `vnodes doctor` that works with the daemon down.
- **Status UI (M9)** — `vnodes ui` on the daemon port; `/ui/theme.css` is the
  design-system insertion seam (deliberately unstyled).
- **Dependency map (M9)** — `vnodes map [target]` at `/ui/map`: a React Flow
  canvas over the indexed files, laid out left-to-right in dependency order.
  Import cycles render red, isolated files dashed, click a node for its
  skeleton and both edge directions. A `--task` scopes it to a real context
  capsule — pivots lit, skeletons amber, everything else dimmed, so you see
  what an agent would actually be handed. Frames push over SSE when the index
  changes. Trimming to `ui.map_max_nodes` is always stated on the page, never
  silent, and the capsule's own files are the last to be trimmed. Pan, zoom,
  minimap, and a path filter that dims rather than hides — a file you filtered
  out is still where it was.

  Layout is computed server-side by the same code the CLI uses, so the picture
  and `vnodes impact` cannot disagree; the page draws what it is handed and
  writes nothing. `/ui/map/data` returns that payload as JSON for anything that
  is not a browser.

  The UI has two checks of its own: `npm --prefix ui run shots` renders the
  pages in headless Chrome and reports the console beside each image, and
  `npm --prefix ui run check` asserts the promises the pages make — no card
  clips its own content, nothing sits under the chrome, edges carry direction,
  omission is stated, the filter dims rather than hides, and no page reaches a
  host but this one.

## Verifying a change

```bash
npm test        # unit tests — no toolchain, no browser, no daemon
npm run verify  # the above, plus the UI build and the render checks
```

`npm test` is the floor and stays dependency-free. `npm run verify` adds the
stages that need a built bundle, a daemon and a browser; it starts what is
missing and stops whatever it started.

A stage that cannot run fails the run rather than being skipped quietly — a
verify that reports a pass while silently omitting its browser stage is the
same defect this project keeps finding in itself. `npm run verify -- --allow-skip`
accepts the gap on a machine without Chrome, and still prints what was missed.

## Quick start

```bash
cd your-project
vnodes index          # or just call any tool — indexing is automatic
vnodes pipeline "add rate limiting to the API"
vnodes setup          # wire your installed agents to the MCP server
vnodes doctor
```

`vnodes setup` is not optional on a fresh clone: every in-repo config it writes
(`.mcp.json`, `.cursor/`, `.cline/`) names an absolute project root, so all of
them are gitignored and no clone carries them. The home-directory registrations
it writes for Codex, Gemini and Windsurf are per machine for the same reason.

Claude Code users may prefer driving all of this through a `/vnodes` operator
skill. One is not shipped here — it would have to hardcode this machine's
install path — so keep it at user scope in `~/.claude/skills/vnodes/`.

## Config

`config/defaults.json` (blueprint snapshot values) < `.vnodes/config.json`
(per-project) < `VNODES_PORT` / `VNODES_RUNTIME` / `VNODES_PI_MODEL` /
`VNODES_MAX_TOKENS` / `VNODES_LOG_LEVEL` / `VNODES_PERSONAL_MODE` env vars.

## Deviations from the blueprint

- Parsing is heuristic line/regex-based per language family, not tree-sitter —
  same observable node/edge contract, lighter fidelity on exotic syntax.
- The Local LLM layer does not download an on-device model; its lifecycle
  states (install/decline/disable/enable) are honored and the model brain is
  the configured runtime CLI (see directive 3), keeping BR-022's guarantee that
  everything works with the layer off.
- macOS binary signing (ERR-004) and marketplace platform packaging (ERR-012)
  don't apply — this is plain Node source, no binaries.
- BR-002's "no explicit init step" is now qualified: a project indexes on first
  use once it has a `.vnodes/`, and a directory without one is refused with the
  command that would create it. BR-002 assumed the project was the one the
  owner chose, but a registration written outside a repo carries no project
  root by design, so it resolves upward from the agent's working directory —
  and one tool call was enough to build a knowledge base in a repo nobody
  nominated. `vnodes index` is the opt-in; nothing that runs unasked creates
  one.
