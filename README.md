# vnodes

Local-first code-graph context engine for AI coding agents. Built as a
black-box behavioral reimplementation of a private blueprint contract,
local-only scope: no licensing, no telemetry, zero outbound network calls,
every feature unconditional. That contract is where the `BR-###` / `ERR-###`
codes in the source point, and where `config/defaults.json` was snapshotted
from; it is not distributed with this repo.

Zero dependencies — Node 22+ only (`node:sqlite` for the graph store).

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
- **Dependency map (M9)** — `vnodes map [target]` at `/ui/map`: live SVG graph
  of the indexed files, laid out left-to-right in dependency order. Import
  cycles render red, isolated files dashed, click a node for its skeleton and
  both edge directions. A `--task` scopes it to a real context capsule — pivots
  lit, skeletons amber, everything else dimmed, so you see what an agent would
  actually be handed. Frames push over SSE when the index changes. Trimming to
  `ui.map_max_nodes` is always stated on the page, never silent. The canvas
  fits itself to the viewport on load and after that it is yours — drag to pan,
  ⌘/ctrl+wheel or `+`/`-`/`0` to zoom, `compact` for smaller boxes on dense
  graphs — and a live update never moves what you are looking at.

## Quick start

```bash
cd your-project
vnodes index          # or just call any tool — indexing is automatic
vnodes pipeline "add rate limiting to the API"
vnodes setup          # wire your installed agents to the MCP server
vnodes doctor
```

`vnodes setup` is not optional on a fresh clone: the per-agent configs it
writes (`.mcp.json`, `.cursor/`, `.gemini/`) bake in an absolute path, so they
are gitignored and no clone carries them.

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
