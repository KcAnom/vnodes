# vnodes

Local-first code-graph context engine for AI coding agents. Built from the
`vexp-operator` blueprint contract (`~/Documents/blueprints/vexp-operator`) —
a black-box behavioral reimplementation, local-only scope: no licensing, no
telemetry, zero outbound network calls, every feature unconditional.

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
- **MCP server (M3)** — stdio by default (`vnodes mcp`), HTTP opt-in on port
  7821. Ten tools: run_pipeline, get_context_capsule, get_impact_graph,
  search_logic_flow, get_skeleton, get_session_context, search_memory,
  save_observation, index_status, workspace_setup.
- **Session memory (M4)** — every tool call auto-captured; observations
  auto-surface with rationale; linked-code changes flag them stale (demoted,
  warned, never deleted).
- **Agent setup (M5)** — `vnodes setup` detects installed agents (Claude Code,
  Cursor, Codex, Windsurf, Gemini CLI, Cline; Opencode/Augment
  instructions-only) and writes MCP registration + instruction blocks inside
  markers — hand-written content untouched. `--personal` skips all shared-repo
  writes.
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

Claude Code: the `/vnodes` skill drives all of this; the MCP server is also
registered at user scope as `vnodes`.

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
