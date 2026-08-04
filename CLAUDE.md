<!-- vnodes:begin (generated — do not edit inside this block) -->
## vnodes context engine

This project is indexed by vnodes (local code-graph context engine). Prefer its
MCP tools over raw file exploration:

- `run_pipeline` — ONE call per task for orientation: pivot files in full,
  supporting skeletons, and prior-session memories with rationale, inside a
  token budget. Call it first, once, per task.
- `get_impact_graph` — who depends on a file/symbol before you change it.
- `get_skeleton` — signatures-only view instead of reading a whole file.
- `save_observation` — record a durable insight (link a file for staleness tracking).
- `index_status` — index health; `search_memory` — recall past findings.

Avoid re-sending full context every turn; one pipeline orientation call per
task keeps session cost bounded.
<!-- vnodes:end -->
