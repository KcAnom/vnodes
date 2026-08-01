'use strict';
// M7 LLM layer + owner build directive 3: switchable dual agentic runtime.
// Runtime A (default): Claude Code CLI, model claude-opus-5.
// Runtime B: the owner's .pi CLI, model grok-4.5-latest | gpt-5.6-sol.
// The switch is config/env/flag — never a code edit.
//
// The "Local LLM" lifecycle (SM-6) is honored as an enable/disable state with
// the RAM-floor decline; the actual model brain is the configured runtime CLI.
// Baseline capsule assembly is rule-based and works with the LLM layer off
// (BR-022).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('./config');

function llmStatePath(projectRoot) { return path.join(projectRoot, '.vnodes', 'llm.json'); }

function llmState(projectRoot) {
  const p = llmStatePath(projectRoot);
  if (!fs.existsSync(p)) return { state: 'not-installed' };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { state: 'not-installed' }; }
}

function llmInstall(projectRoot) {
  const cfg = loadConfig(projectRoot);
  const ramGb = os.totalmem() / 1024 ** 3;
  if (ramGb < cfg.llm.min_ram_gb) {
    // Below the RAM floor the installer declines; rule-based compressor remains (BR-023).
    return { state: 'declined', reason: `machine has ${ramGb.toFixed(1)}GB RAM, floor is ${cfg.llm.min_ram_gb}GB — rule-based compressor remains active` };
  }
  const backend = process.platform === 'darwin' ? 'metal' : 'cpu';
  const st = { state: 'running', backend, provider: cfg.runtime.provider, installed_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(llmStatePath(projectRoot)), { recursive: true });
  fs.writeFileSync(llmStatePath(projectRoot), JSON.stringify(st, null, 2));
  return st;
}

function llmDisable(projectRoot) {
  const st = llmState(projectRoot);
  if (st.state !== 'running') return { state: st.state, note: 'not running' };
  // Disable keeps files on disk for instant re-enable (BR-023 / SM-6).
  const next = { ...st, state: 'installed-disabled' };
  fs.writeFileSync(llmStatePath(projectRoot), JSON.stringify(next, null, 2));
  return next;
}

function llmEnable(projectRoot) {
  const st = llmState(projectRoot);
  if (st.state === 'not-installed') return llmInstall(projectRoot);
  const next = { ...st, state: 'running' };
  fs.writeFileSync(llmStatePath(projectRoot), JSON.stringify(next, null, 2));
  return next; // instant, no re-download
}

function runtimeInfo(projectRoot, overrides = {}) {
  const cfg = loadConfig(projectRoot);
  const provider = overrides.runtime || cfg.runtime.provider;
  if (provider === 'pi') {
    const model = overrides.pi_model || cfg.runtime.pi_model;
    return { provider: 'pi', cli: 'pi', model, argv: ['--model', model, '-p'] };
  }
  return { provider: 'claude-code', cli: 'claude', model: cfg.runtime.claude_model, argv: ['--model', cfg.runtime.claude_model, '-p'] };
}

// Ask the configured runtime one question (used by `vnodes llm ask` and any
// future LLM-assisted intent refinement). Fails soft: engine never depends on it.
function runtimeAsk(projectRoot, prompt, overrides = {}) {
  const rt = runtimeInfo(projectRoot, overrides);
  try {
    const out = execFileSync(rt.cli, [...rt.argv, prompt], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ...rt, ok: true, answer: out.trim() };
  } catch (e) {
    return { ...rt, ok: false, error: `runtime '${rt.provider}' (${rt.cli}) failed: ${e.code === 'ENOENT' ? 'CLI not found on PATH' : e.message}` };
  }
}

module.exports = { llmState, llmInstall, llmDisable, llmEnable, runtimeInfo, runtimeAsk };
