'use strict';
// M2 Context Pipeline. Request → intent preset → traversal/ranking → capsule:
// pivot files in full, supporters as skeletons, fitted to the token budget
// (BR-008). Five presets, auto default, debug auto-includes tests (BR-009).
// Relevant memories attach with rationale (BR-014).
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store');
const { buildSkeleton } = require('./skeleton');
const { searchMemory } = require('./memory');
const { loadWorkspace } = require('./workspace');

const PRESETS = ['auto', 'explore', 'debug', 'modify', 'refactor'];

function estimateTokens(text) { return Math.ceil(text.length / 4); }

function resolveIntent(task, preset, projectRoot = null) {
  if (preset && preset !== 'auto' && PRESETS.includes(preset)) return preset;
  const t = (task || '').toLowerCase();
  if (/\b(bug|fix|error|fail|crash|broken|why|regress|exception|stack ?trace)\b/.test(t)) return 'debug';
  if (/\b(refactor|clean ?up|restructure|rename|extract|simplify)\b/.test(t)) return 'refactor';
  if (/\b(add|implement|create|build|new|change|update|modify|support)\b/.test(t)) return 'modify';
  if (/\b(how|what|where|understand|explain|explore|overview|architecture)\b/.test(t)) return 'explore';
  return llmIntent(task, projectRoot) || 'auto';
}

// LLM-assisted intent refinement (BR-022: rule-based must work with this off).
// Only consulted when the regexes can't classify AND the LLM layer is enabled;
// fails soft to 'auto' on any error, timeout, or off-preset answer.
function llmIntent(task, projectRoot) {
  if (!projectRoot || !task) return null;
  const { llmState, runtimeAsk } = require('./runtime');
  if (llmState(projectRoot).state !== 'running') return null;
  const r = runtimeAsk(projectRoot,
    `Classify this coding task into exactly one word from: explore, debug, modify, refactor. Task: ${task}\nAnswer with the single word only.`,
    { timeout_ms: 10000 });
  if (!r.ok) return null;
  const word = r.answer.toLowerCase().trim().split(/\s+/).pop();
  return PRESETS.includes(word) && word !== 'auto' ? word : null;
}

function isTestFile(p) { return /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/.test(p); }

function terms(text) {
  return [...new Set((text || '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])]
    .filter(t => !['the', 'and', 'for', 'with', 'that', 'this', 'file', 'code'].includes(t));
}

function rankFiles(db, task, intent, repos) {
  const qTerms = terms(task);
  const repoFilter = repos && repos.length
    ? ` WHERE repo IN (${repos.map(() => '?').join(',')})` : '';
  const files = db.prepare(`SELECT path, repo, lang FROM files${repoFilter}`).all(...(repos || []));
  const inDeg = new Map(db.prepare('SELECT dst_file d, COUNT(*) c FROM edges GROUP BY dst_file').all().map(r => [r.d, r.c]));
  const symbolHit = db.prepare('SELECT COUNT(*) c FROM nodes WHERE file = ? AND lower(name) LIKE ?');
  return files.map(f => {
    let score = 0;
    const lp = f.path.toLowerCase();
    for (const t of qTerms) {
      if (lp.includes(t)) score += 3;
      score += Math.min(symbolHit.get(f.path, `%${t}%`).c, 5);
    }
    score += Math.min(inDeg.get(f.path) || 0, 10) * 0.3; // central files matter
    const test = isTestFile(f.path);
    if (test) score *= intent === 'debug' ? 1.2 : 0.3; // debug preset pulls tests in
    return { ...f, score, test };
  }).sort((a, b) => b.score - a.score);
}

// Expand pivots one hop along the graph so direct deps become supporters.
function neighbors(db, fileKeys) {
  const out = new Set();
  const q = db.prepare('SELECT dst_file d FROM edges WHERE src_file = ? UNION SELECT src_file d FROM edges WHERE dst_file = ?');
  for (const f of fileKeys) for (const r of q.all(f, f)) out.add(r.d);
  return out;
}

function readProjectFile(projectRoot, fileKey) {
  const ws = loadWorkspace(projectRoot);
  if (ws) {
    for (const r of ws.repos) {
      const prefix = `${r.alias}/`;
      if (fileKey.startsWith(prefix))
        return tryRead(path.resolve(ws.baseDir, r.path, fileKey.slice(prefix.length)));
    }
  }
  return tryRead(path.join(projectRoot, fileKey));
}
function tryRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function buildCapsule(projectRoot, engDir, cfg, { task, preset, max_tokens, repos, pivots: pivotCount = 2, session } = {}) {
  const db = openStore(engDir);
  const budget = max_tokens || cfg.capsule.max_tokens;
  const intent = resolveIntent(task, preset, projectRoot);
  const ranked = rankFiles(db, task, intent, repos);
  const pivotFiles = ranked.filter(r => r.score > 0).slice(0, pivotCount);
  const pivotKeys = pivotFiles.map(p => p.path);
  const hood = neighbors(db, pivotKeys);
  const supporters = ranked
    .filter(r => !pivotKeys.includes(r.path) && (r.score > 0 || hood.has(r.path)))
    .slice(0, 30);

  let used = 0;
  const capsule = { intent, budget_tokens: budget, pivots: [], skeletons: [], memories: [], truncated: false };

  const pivotBudget = Math.floor(budget * 0.7);
  for (const p of pivotFiles) {
    const content = readProjectFile(projectRoot, p.path);
    if (content == null) continue;
    const tok = estimateTokens(content);
    if (used + tok > pivotBudget) {
      if (capsule.pivots.length > 0) {
        // Pivot doesn't fit: degrade to skeleton rather than blow the budget.
        supporters.unshift(p);
        continue;
      }
      // First pivot alone exceeds the budget: clip it to fit. A capsule with no
      // pivot is useless, but an unbounded one breaks the budget contract
      // (BR-008) — the head of the file plus its skeleton beats either extreme.
      const clipped = content.slice(0, Math.max(0, pivotBudget - used) * 4);
      capsule.pivots.push({
        file: p.path, tokens: estimateTokens(clipped), content: clipped,
        clipped: true, full_tokens: tok,
      });
      used += estimateTokens(clipped);
      capsule.truncated = true;
      supporters.unshift(p); // its skeleton still shows the symbols the clip cut off
      continue;
    }
    capsule.pivots.push({ file: p.path, tokens: tok, content });
    used += tok;
  }
  const detail = cfg.capsule.skeleton_detail || 'standard';
  for (const s of supporters) {
    const sk = buildSkeleton(db, s.path, detail);
    if (!sk) continue;
    const tok = estimateTokens(sk);
    if (used + tok > budget) { capsule.truncated = true; break; }
    capsule.skeletons.push({ file: s.path, tokens: tok, detail, content: sk });
    used += tok;
  }
  db.close();

  // Auto-surface relevant memories with rationale (BR-014) — budget-counted.
  for (const m of searchMemory(engDir, task, { session, limit: 5 })) {
    const tok = estimateTokens(JSON.stringify(m));
    if (used + tok > budget) break;
    capsule.memories.push(m);
    used += tok;
  }

  capsule.used_tokens = used;
  // Safety net: with pivot clipping above, the budget should never overflow;
  // if it somehow does, report it rather than hide it.
  if (used > budget) {
    capsule.truncated = true;
    capsule.over_budget_tokens = used - budget;
  }
  // Savings vs naive full-content of every considered file (savings envelope BR-010).
  const naive = [...pivotFiles, ...supporters].reduce((a, f) => {
    const c = readProjectFile(projectRoot, f.path);
    return a + (c ? estimateTokens(c) : 0);
  }, 0);
  capsule.savings_pct = naive > 0 ? Math.round((1 - used / naive) * 100) : 0;
  return capsule;
}

module.exports = { buildCapsule, resolveIntent, estimateTokens, PRESETS };
