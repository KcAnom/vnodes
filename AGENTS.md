<!-- vnodes:begin (generated — do not edit inside this block) -->
## vnodes context engine

This project is indexed by vnodes (local code-graph context engine). Prefer its
MCP tools over raw file exploration:

- `run_pipeline` — ONE call per task for orientation: pivot files in full, supporting skeletons, and prior-session memories with rationale, inside a token budget. Call it first, once, per task.
- `get_context_capsule` — Assemble a context capsule for a task without intent narration — same engine as run_pipeline.
- `get_impact_graph` — who depends on a file/symbol before you change it.
- `search_logic_flow` — Shortest dependency path between two files or symbols.
- `get_skeleton` — signatures-only view instead of reading a whole file.
- `get_session_context` — Recent observations from this and previous sessions (stale ones flagged, never dropped).
- `search_memory` — recall findings from previous sessions.
- `save_observation` — record a durable insight (link a file for staleness tracking).
- `index_status` — index health when a result looks stale or wrong.
- `create_knowledge_base` — Make this directory (or `path`) a vnodes knowledge base and index it.
- `workspace_setup` — Define a multi-repo workspace ({name|workspace_id, repos:[{alias,path}]}) and write parent pointers into secondary repos.

Avoid re-sending full context every turn; one pipeline orientation call per
task keeps session cost bounded.
<!-- vnodes:end -->
