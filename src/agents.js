'use strict';
// M5 Agent Setup. Detects installed agents, writes per-agent MCP registration
// and instruction blocks (BR-016). Generated content lives in marker-delimited
// blocks; hand-written content is never overwritten (BR-018). personalMode
// skips all shared-repo writes (BR-017). Opencode and Augment are
// instructions-only (no MCP config file).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MARK_BEGIN = '<!-- vnodes:begin (generated — do not edit inside this block) -->';
const MARK_END = '<!-- vnodes:end -->';

const BIN = path.join(__dirname, '..', 'bin', 'vnodes.js');

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', detect: ['~/.claude'], kind: 'mcp-json', file: '.mcp.json', instructions: 'CLAUDE.md' },
  { id: 'cursor', name: 'Cursor', detect: ['~/.cursor', '/Applications/Cursor.app'], kind: 'mcp-json', file: '.cursor/mcp.json', instructions: '.cursor/rules/vnodes.mdc' },
  { id: 'codex', name: 'Codex CLI', detect: ['~/.codex'], kind: 'codex-toml', file: '~/.codex/config.toml', instructions: 'AGENTS.md' },
  { id: 'windsurf', name: 'Windsurf', detect: ['~/.codeium/windsurf', '/Applications/Windsurf.app'], kind: 'mcp-json', file: '~/.codeium/windsurf/mcp_config.json', instructions: '.windsurfrules' },
  { id: 'opencode', name: 'Opencode', detect: ['~/.config/opencode'], kind: 'instructions-only', instructions: 'AGENTS.md' },
  { id: 'augment', name: 'Augment', detect: ['~/.augment'], kind: 'instructions-only', instructions: '.augment-guidelines' },
  { id: 'gemini-cli', name: 'Gemini CLI', detect: ['~/.gemini'], kind: 'mcp-json', file: '.gemini/settings.json', instructions: 'GEMINI.md' },
  { id: 'cline', name: 'Cline', detect: ['~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev'], kind: 'mcp-json', file: '.cline/mcp.json', instructions: '.clinerules' },
];

function expand(p) { return p.replace(/^~/, os.homedir()); }

function detectAgents() {
  return AGENTS.map(a => ({ ...a, installed: a.detect.some(d => fs.existsSync(expand(d))) }));
}

// Usage hints carry the judgment a tool's own description can't: when to reach
// for it, and how often. Tools with no hint fall back to the first sentence of
// their MCP description, so a tool added to TOOL_DEFS documents itself here
// without a second edit — the instruction block can no longer drift behind the
// catalog it describes.
const TOOL_HINTS = {
  run_pipeline: 'ONE call per task for orientation: pivot files in full, supporting skeletons, and prior-session memories with rationale, inside a token budget. Call it first, once, per task.',
  get_impact_graph: 'who depends on a file/symbol before you change it.',
  get_skeleton: 'signatures-only view instead of reading a whole file.',
  save_observation: 'record a durable insight (link a file for staleness tracking).',
  search_memory: 'recall findings from previous sessions.',
  index_status: 'index health when a result looks stale or wrong.',
};

// First sentence only. Split on '. ' rather than any '.' or ':' so descriptions
// that lead with a colon ("Index health: state, ...") survive intact.
function firstSentence(text) {
  const i = text.search(/\.(\s|$)/);
  return (i === -1 ? text : text.slice(0, i + 1)).trim();
}

function toolCatalogLines() {
  const { TOOL_DEFS } = require('./tools');
  return TOOL_DEFS
    .map(t => `- \`${t.name}\` — ${TOOL_HINTS[t.name] || firstSentence(t.description)}`)
    .join('\n');
}

function instructionText(projectRoot) {
  return `${MARK_BEGIN}
## vnodes context engine

This project is indexed by vnodes (local code-graph context engine). Prefer its
MCP tools over raw file exploration:

${toolCatalogLines()}

Avoid re-sending full context every turn; one pipeline orientation call per
task keeps session cost bounded.
${MARK_END}
`;
}

// Write/replace only our marker block; everything outside stays byte-identical.
function upsertMarkerBlock(filePath, block) {
  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  const start = existing.indexOf(MARK_BEGIN);
  const end = existing.indexOf(MARK_END);
  let next;
  if (start >= 0 && end > start) {
    next = existing.slice(0, start) + block.trimEnd() + '\n' + existing.slice(end + MARK_END.length).replace(/^\n/, '');
  } else {
    next = existing ? existing.replace(/\n?$/, '\n\n') + block : block;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
}

// JSON MCP config: merge only the "vnodes" server key; other keys untouched.
function upsertMcpJson(filePath, projectRoot) {
  let obj = {};
  if (fs.existsSync(filePath)) {
    try { obj = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return { file: filePath, ok: false, error: 'existing file is not valid JSON — left untouched' }; }
  }
  obj.mcpServers = obj.mcpServers || {};
  obj.mcpServers.vnodes = { command: 'node', args: [BIN, 'mcp', projectRoot] };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
  return { file: filePath, ok: true };
}

function upsertCodexToml(filePath, projectRoot) {
  // Hand-written Codex MCP entries are never overwritten (BR-018): only the
  // vnodes-marked block is managed.
  const B = '# vnodes:begin (generated)', E = '# vnodes:end';
  let existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const block = `${B}
[mcp_servers.vnodes]
command = "node"
args = ["${BIN}", "mcp", "${projectRoot}"]
${E}
`;
  const s = existing.indexOf(B), e = existing.indexOf(E);
  const next = s >= 0 && e > s
    ? existing.slice(0, s) + block.trimEnd() + existing.slice(e + E.length)
    : (existing ? existing.replace(/\n?$/, '\n\n') : '') + block;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
  return { file: filePath, ok: true };
}

function setupAgents(projectRoot, { only = null, personalMode = false } = {}) {
  const detected = detectAgents();
  const chosen = detected.filter(a => a.installed && (!only || only.includes(a.id)));
  const results = [];
  for (const a of chosen) {
    const r = { agent: a.name, id: a.id, wrote: [] };
    const inRepo = p => !path.isAbsolute(expand(p)) || expand(p).startsWith(projectRoot);
    // MCP registration
    if (a.kind === 'mcp-json') {
      const target = expand(a.file);
      const abs = path.isAbsolute(target) ? target : path.join(projectRoot, target);
      if (personalMode && inRepo(a.file)) {
        r.skipped = 'personalMode: shared-repo write skipped';
      } else {
        const w = upsertMcpJson(abs, projectRoot);
        r.wrote.push(w.ok ? w.file : `SKIPPED ${w.file}: ${w.error}`);
      }
    } else if (a.kind === 'codex-toml') {
      const w = upsertCodexToml(expand(a.file), projectRoot);
      r.wrote.push(w.file);
    }
    // Instructions (instructions-only agents get only this)
    if (a.instructions) {
      const target = expand(a.instructions);
      const abs = path.isAbsolute(target) ? target : path.join(projectRoot, target);
      if (personalMode && inRepo(a.instructions)) {
        r.skipped = 'personalMode: shared-repo write skipped';
      } else {
        upsertMarkerBlock(abs, instructionText(projectRoot));
        r.wrote.push(abs);
      }
    }
    results.push(r);
  }
  return { detected: detected.map(a => ({ id: a.id, name: a.name, installed: a.installed })), configured: results, personalMode };
}

module.exports = { detectAgents, setupAgents, instructionText, AGENTS };
