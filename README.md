# vnodes

Local-first code-graph context engine for AI coding agents: local-only
scope, no licensing, no telemetry, zero outbound network calls, every
feature unconditional.

Zero runtime dependencies — Node 22+ only (`node:sqlite` for the graph store).
Nothing to install and nothing to build to use it. The one exception is the
dependency map's browser bundle, which is built from `ui/` and **committed** to
`src/view/static/`; only a contributor changing the map ever runs that
toolchain. It still reaches no network — the daemon serves it off disk.

## What it does

- **Indexing** — parses a project into a dependency graph at
  `.vnodes/index.db` (gitignored). `manifest.json` (committed) holds per-file
  hashes so clones rebuild incrementally. Secret-named files filtered by
  filename boundary (`.env.example` allowlisted); `.gitignore` +
  `.vnodesignore` + `.vnodes_ignore` + default excludes honored; parse-only,
  files > 512KB skipped. A root-level `build/`, `dist/`, or `target/` is excluded
  by default, while the same name below a source tree remains eligible so a
  package such as `internal/build/` is not mistaken for generated output;
  explicit ignore files still exclude nested outputs. All limits configurable.
- **Context capsules** — `vnodes pipeline "<task>"`: intent preset
  (auto/explore/debug/modify/refactor; debug pulls tests), graph-ranked pivot
  files in full + supporter skeletons, fitted to a token budget (default 8000),
  with relevant memories attached with rationale. Concurrent capsule
  completions use bounded SQLite waits and read-only index lookups, so their
  observation writes serialize instead of failing immediately with `SQLITE_BUSY`.
- **MCP server** — `vnodes mcp`, MCP over stdio. 19 tools: run_pipeline,
  get_context_capsule, get_impact_graph, search_logic_flow, get_skeleton,
  get_session_context, search_memory, save_observation, forget_observation, update_observation, index_status,
  create_knowledge_base, list_knowledge_bases, forget_knowledge_base, hide_knowledge_base, show_knowledge_base,
  workspace_setup, forget_workspace, forget_activity. search_memory accepts findings_only.
  The daemon's HTTP transport (port 7821) shares the same tool
  dispatch but is **not** MCP: `POST /rpc` takes `{tool, arguments, session}`
  and returns a plain JSON result — no JSON-RPC envelope, no `initialize`, no
  `tools/list`. An MCP client that speaks HTTP cannot talk to it; give those
  agents the stdio command.
- **Session memory** — every tool call auto-captured; observations
  auto-surface with rationale; linked-code changes flag them stale (demoted,
  warned, never deleted). The first index of a tree writes one durable
  foundation finding from the graph (languages, hubs, counts) so a later
  session has something to attach before anyone has worked here.
- **Kept-change freshness** — `vnodes check` fails when `.vnodes/manifest.json`
  does not match the current tree (the CI-safe stand-in for "index older than
  HEAD", since `index.db` is gitignored). `vnodes hook install` writes a
  pre-commit hook that reindexes and stages the manifest so a kept change
  cannot land stale.
- **Agent setup** — `vnodes setup` detects installed agents and writes an
  MCP registration plus an instruction block inside markers; hand-written
  content is never touched, and the instruction block is generated from the
  live tool catalog so it cannot fall behind. The block also tells every
  agent to orient, take impact before edits, save findings, and keep the
  index current. `--personal` skips all
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
- **Multi-repo workspaces** — `.vnodes/workspace.json` (+ auto parent
  pointers in secondary repos); cross-repo shared-type edges; query scoping via
  `repos`, `cross_repo`, `repo`.
- **LLM layer + dual runtime** — optional; RAM floor honored; the brain is
  the switchable runtime: Claude Code CLI/`claude-opus-5` (default) or the
  `.pi` CLI with `grok-4.5-latest`/`gpt-5.6-sol` — flip via config, env, or flag.
- **Daemon & diagnostics** — auto-restart on tool call, self-truncating
  daemon/index logs, read-only `vnodes doctor` that works with the daemon down.
- **Status UI** — `vnodes ui` on the daemon port; `/ui/theme.css` is the
  design-system insertion seam (deliberately unstyled).
- **Dependency map** — `vnodes map [target]` at `/ui/map`: a React Flow
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
missing and stops whatever it started. CI runs the same gate on every push
and pull request (`.github/workflows/verify.yml`), so a red verify cannot
merge unnoticed.

A fresh clone needs three one-time steps before it is fully wired: the UI
toolchain (`npm --prefix ui ci`, verify tells you), an index (`vnodes index`,
the render stage tells you), and the pre-commit hook (`vnodes hook install`) —
hooks live in your local `.git/`, so CI cannot carry them to a clone for you.

A stage that cannot run fails the run rather than being skipped quietly — a
verify that reports a pass while silently omitting its browser stage is the
same defect this project keeps finding in itself. `npm run verify -- --allow-skip`
accepts the gap on a machine without Chrome, and still prints what was missed.

## Quick start

```bash
cd your-project
vnodes index          # or create_knowledge_base from an agent — seeds a foundation finding
vnodes pipeline "add rate limiting to the API"
vnodes setup          # wire your installed agents to the MCP server
vnodes hook install   # pre-commit reindexes and stages .vnodes/manifest.json
vnodes check          # CI: fail if the index does not match the tree
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

`config/defaults.json` (built-in defaults) < `.vnodes/config.json`
(per-project) < `VNODES_PORT` / `VNODES_RUNTIME` / `VNODES_PI_MODEL` /
`VNODES_MAX_TOKENS` / `VNODES_LOG_LEVEL` / `VNODES_PERSONAL_MODE` env vars.

## Implementation notes

- Parsing is heuristic line/regex-based per language family, not tree-sitter —
  lighter fidelity on exotic syntax, but a much smaller surface to reason
  about.
- The Local LLM layer does not download an on-device model; its lifecycle
  states (install/decline/disable/enable) are honored, and the model brain is
  the configured runtime CLI — everything still works with the layer off.
- macOS binary signing and marketplace platform packaging don't apply — this
  is plain Node source, no binaries.
- Auto-capture is narrowed to invocations that carry a finding: `run_pipeline`,
  the capsule, and `workspace_setup`. Capturing every invocation instead filled
  the feed with rows reading `{}` and `{"target":"x"}` — 25 of them in one
  working session — competing with real findings for the same relevance
  window. `run_pipeline` keeps its capture because "task X → 3 pivots, 4000
  tokens" is a record of what was worked on, which is what a later session
  wants.
- Tool results may carry a `vnodes_notice` field. The instruction block has
  always said to orient with `run_pipeline` first; that is advisory, and
  advisory lost — a session that shipped two features here made zero code
  queries and saved zero findings, and nothing said so at the time. The notice
  states what it knows (how many calls, what has not happened), rides on the
  tools a non-orienting caller still uses, never blocks, and stops once the
  thing it asks for has happened.
- The "no explicit init step" design is qualified: a project indexes on first
  use once it has a `.vnodes/`, and a directory without one is refused with the
  command that would create it. The original assumption was that the project
  was always the one you chose, but a registration written outside a
  repo carries no project root by design, so it resolves upward from the
  agent's working directory — and one tool call was enough to build a
  knowledge base in a repo nobody nominated. `vnodes index` is the opt-in;
  nothing that runs unasked creates one.
