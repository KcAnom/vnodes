---
name: vnodes
description: Operate the vnodes local code-graph context engine (~/vnodes) on the current project — index it, get a context capsule for a task, check impact of a change, query memory, run the daemon/doctor, or wire agents. Trigger on "/vnodes", "index this project with vnodes", "get me a context capsule", "who depends on <file>", "vnodes status/doctor", or "set up vnodes for this repo".
---

# vnodes operator

vnodes is the owner's local-first code-graph context engine at `/Users/kc/vnodes`
(CLI on PATH as `vnodes`, symlinked in `~/bin`). It indexes a project into
`.vnodes/index.db` (gitignored; `manifest.json` is committed for incremental
clone rebuilds), serves 10 MCP tools over stdio, assembles token-budgeted
context capsules, and keeps cross-session memory with staleness tracking.
Everything is local — zero outbound network calls.

## Argument handling

`/vnodes` with no args → run `vnodes status` and `vnodes doctor` in the current
project and summarize. Otherwise map the ask onto the commands below. Always run
commands from the target project directory (or pass `--project <path>`).

## Commands

| Ask | Command |
|---|---|
| index / reindex | `vnodes index` · force rebuild: `vnodes reindex` |
| status | `vnodes status` |
| context for a task | `vnodes pipeline "<task>" [--preset debug] [--json]` |
| file outline | `vnodes skeleton <file> [--detail minimal\|standard\|detailed]` |
| who depends on X | `vnodes impact <file-or-symbol>` |
| path between A and B | `vnodes flow <from> <to>` |
| remember / recall | `vnodes memory save "<note>" [--file f]` · `vnodes memory search "<q>"` |
| multi-repo workspace | `vnodes workspace setup --name <n> --repos alias=path,...` |
| wire agents (MCP + instructions) | `vnodes setup` (add `--personal` on shared repos) |
| daemon / HTTP transport | `vnodes daemon start|stop|status` (port 7821, `VNODES_PORT` to change) |
| diagnostics | `vnodes doctor` · `vnodes logs [daemon|index] [--follow]` |
| status page | `vnodes ui` |
| LLM layer / runtime switch | `vnodes llm status|enable|disable` · `vnodes llm runtime --runtime claude-code\|pi --pi-model grok-4.5-latest\|gpt-5.6-sol` |

## Notes

- Indexing is automatic on first tool use — no init step. The daemon
  auto-restarts on any tool call; never treat "daemon stopped" as an error.
- vnodes is registered as an MCP server at user scope, so its tools
  (`run_pipeline`, `get_impact_graph`, …) may already be directly callable in
  this session — prefer the MCP tools over shelling out when present.
- Config precedence: `~/vnodes/config/defaults.json` < `.vnodes/config.json` <
  `VNODES_*` env vars. Never edit defaults to change one project.
- Stale memory results carry a warning and are demoted, never deleted.
