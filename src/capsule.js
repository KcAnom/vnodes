'use strict';
// M2 Context Pipeline. Request → intent preset → traversal/ranking → capsule:
// pivot files in full, supporters as skeletons, fitted to the token budget
// (BR-008). Five presets, auto default, debug auto-includes tests (BR-009).
// Relevant memories attach with rationale (BR-014).
const fs = require('node:fs');
const path = require('node:path');
const { openStore, openStoreReadOnly } = require('./store');
const { buildSkeleton } = require('./skeleton');
const { searchMemory } = require('./memory');
const { loadWorkspace } = require('./workspace');

const PRESETS = ['auto', 'explore', 'debug', 'modify', 'refactor'];

function estimateTokens(text) { return Math.ceil(text.length / 4); }

const INTENT_RULES = [
  ['debug', /\b(bug|fix|error|fail|crash|broken|why|regress|exception|stack ?trace)\b/],
  ['refactor', /\b(refactor|clean ?up|restructure|rename|extract|simplify)\b/],
  ['modify', /\b(add|implement|create|build|new|change|update|modify|support)\b/],
  ['explore', /\b(how|what|where|understand|explain|explore|overview|architecture)\b/],
];

/**
 * Intent and where it came from, decided together.
 *
 * "Why did it pick debug" was unanswerable from outside the function: the
 * caller got a word with no provenance, so a preset the user chose, a regex
 * that fired on the word "why", an LLM guess and the do-nothing fallback all
 * looked identical. They are not equally trustworthy and the UI has to say
 * which one it was. Classification stays in one place so the LLM is consulted
 * at most once per capsule.
 */
function classifyIntent(task, preset, projectRoot = null) {
  if (preset && preset !== 'auto' && PRESETS.includes(preset)) return { intent: preset, source: 'preset' };
  const t = (task || '').toLowerCase();
  for (const [intent, re] of INTENT_RULES) if (re.test(t)) return { intent, source: 'regex' };
  const guess = llmIntent(task, projectRoot);
  return guess ? { intent: guess, source: 'llm' } : { intent: 'auto', source: 'default' };
}

function resolveIntent(task, preset, projectRoot = null) {
  return classifyIntent(task, preset, projectRoot).intent;
}

/** 'preset' | 'regex' | 'llm' | 'default' — the provenance of resolveIntent's answer. */
function intentSource(task, preset, projectRoot = null) {
  return classifyIntent(task, preset, projectRoot).source;
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

function isTestFile(p) { return /(^|\/)(tests?|__tests__|spec)\/|(^|\/)tests?\.[a-z]+$|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/.test(p); }

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

function openCapsuleStore(engDir, readOnly) {
  // Prefer a read-only handle whenever index.db already exists so a GET cannot
  // run WAL/DDL against a store it only meant to look at. readOnly additionally
  // forbids creating the file: missing db is empty, never a new index.db.
  if (readOnly || fs.existsSync(path.join(engDir, 'index.db'))) {
    const db = openStoreReadOnly(engDir);
    if (db) return db;
    if (readOnly) return null;
  }
  return openStore(engDir);
}

function buildCapsule(projectRoot, engDir, cfg, { task, preset, max_tokens, repos, pivots: pivotCount = 2, session, readOnly = false } = {}) {
  const db = openCapsuleStore(engDir, readOnly);
  const budget = max_tokens || cfg.capsule.max_tokens;
  const { intent, source: intentReason } = classifyIntent(task, preset, projectRoot);
  if (!db) {
    return {
      intent, intent_reason: intentReason, budget_tokens: budget,
      pivots: [], skeletons: [], memories: [], truncated: false, omitted: [],
      memory_reserve_tokens: 0, used_tokens: 0, savings_pct: 0,
    };
  }
  const ranked = rankFiles(db, task, intent, repos);
  // Pivots carry full file content, so a giant test file with thousands of
  // symbol hits can out-score the real implementation on raw term volume.
  // Outside debug intent, tests only pivot when nothing else scores — they
  // remain eligible as skeleton supporters either way.
  let candidates = ranked.filter(r => r.score > 0);
  if (intent !== 'debug') {
    const nonTest = candidates.filter(r => !r.test);
    if (nonTest.length) candidates = nonTest;
  }
  const pivotFiles = candidates.slice(0, pivotCount);
  const pivotKeys = pivotFiles.map(p => p.path);
  const hood = neighbors(db, pivotKeys);
  const supporters = ranked
    .filter(r => !pivotKeys.includes(r.path) && (r.score > 0 || hood.has(r.path)))
    .slice(0, 30);

  let used = 0;
  // `omitted` is the receipt for BR-008's budget cut. The loops below used to
  // just `break`, which meant the capsule was silently smaller than the ranking
  // said it should be and no reader could tell a file that scored zero from one
  // that scored well and lost to the last 200 tokens.
  const capsule = { intent, intent_reason: intentReason, budget_tokens: budget, pivots: [], skeletons: [], memories: [], truncated: false, omitted: [] };

  /**
   * Memories are chosen before the content spends, and their cost is held back.
   *
   * The capsule is assembled for a headless agent, whose one scarcity is
   * context — the UI is a separate surface and never touches this budget. Spent
   * in ranking order, that budget goes to the most reproducible thing in the
   * payload first: source, which the agent can open itself, for free, whenever
   * it likes. Memories went last and got the remainder. Measured on this repo
   * at the 8000 default: the pivot took 7381 tokens, one pivot cost 43x one
   * memory, and all three stored findings were dropped — silently, because the
   * loop below only broke where the loops above kept a receipt.
   *
   * The graph rebuilds from code in 0.05s. Observations do not rebuild at all.
   * So the unrecoverable half is funded first, and cheaply: the reserve is
   * never more than the memories actually found, so a task with nothing stored
   * costs the content nothing at all.
   */
  let found = [];
  try {
    found = searchMemory(engDir, task, { session, limit: 5, readOnly });
  } catch (e) {
    if (!readOnly || e.code !== 'ENOMEMORYDB') throw e;
  }
  const memoryCost = found.map(m => estimateTokens(JSON.stringify(m)));
  const wanted = memoryCost.reduce((a, b) => a + b, 0);
  const reserve = Math.min(
    wanted,
    cfg.capsule.memory_reserve_tokens ?? 1000,
    Math.floor(budget * ((cfg.capsule.memory_reserve_max_pct ?? 25) / 100)),
  );
  const contentBudget = budget - reserve;

  const pivotBudget = Math.floor(contentBudget * 0.7);
  for (const p of pivotFiles) {
    const content = readProjectFile(projectRoot, p.path);
    if (content == null) continue;
    const tok = estimateTokens(content);
    if (used + tok > pivotBudget) {
      /**
       * A pivot that does not fit is clipped, wherever it ranked.
       *
       * It used to depend on position: the first pivot was clipped to fit, and
       * every one after it was replaced by its signatures. So the same file got
       * the head of its real source or none of it at all depending on whether
       * something else happened to rank above it — and a pivot is by definition
       * a file the graph says the task is about. Measured on this repo:
       * src/daemon.js ranked second, did not fit, and came back as a list of 35
       * function names while 12,676 tokens of the code the question was about
       * were dropped.
       *
       * Clipping is what the budget contract (BR-008) asks for and what the
       * first pivot already did. The floor is the one real limit: below
       * min_clip_tokens a clip is a scrap of a file, and signatures across the
       * whole of it say more than the first few lines of it. The first pivot
       * clips regardless of the floor, because a capsule with no pivot at all
       * answers nothing.
       */
      const room = Math.max(0, pivotBudget - used);
      const worthClipping = room >= (cfg.capsule.min_clip_tokens ?? 400);
      if (!worthClipping && capsule.pivots.length > 0) {
        supporters.unshift(p);
        capsule.omitted.push({ file: p.path, est_tokens: tok, reason: 'pivot-degraded-to-skeleton' });
        continue;
      }
      const clipped = content.slice(0, room * 4);
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
  for (let i = 0; i < supporters.length; i++) {
    const s = supporters[i];
    const sk = buildSkeleton(db, s.path, detail);
    if (!sk) continue;
    const tok = estimateTokens(sk);
    if (used + tok > contentBudget) {
      capsule.truncated = true;
      // Everything from here down ranked in and lost to the budget. Name all of
      // it, not just the file that happened to be at the head of the queue when
      // the budget ran out.
      for (let j = i; j < supporters.length; j++) {
        const rest = j === i ? sk : buildSkeleton(db, supporters[j].path, detail);
        if (!rest) continue;
        capsule.omitted.push({ file: supporters[j].path, est_tokens: estimateTokens(rest), reason: 'budget' });
      }
      break;
    }
    capsule.skeletons.push({ file: s.path, tokens: tok, detail, content: sk });
    used += tok;
  }
  db.close();

  // Auto-surface relevant memories with rationale (BR-014) — budget-counted.
  // Against the full budget, not contentBudget: the reserve above is the floor
  // these are guaranteed, and anything the content left unspent is theirs too.
  for (let i = 0; i < found.length; i++) {
    const tok = memoryCost[i];
    if (used + tok > budget) {
      capsule.truncated = true;
      // The receipt the loops above already keep. Without it a reader cannot
      // tell "nothing relevant was stored" from "it did not fit", and those are
      // opposite facts: one means there is nothing to know, the other means
      // there is something known that this capsule did not carry.
      for (let j = i; j < found.length; j++) {
        capsule.omitted.push({
          file: found[j].file || `observation #${found[j].id}`,
          est_tokens: memoryCost[j],
          reason: 'budget-memory',
        });
      }
      break;
    }
    capsule.memories.push(found[i]);
    used += tok;
  }
  capsule.memory_reserve_tokens = reserve;

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

module.exports = { buildCapsule, resolveIntent, intentSource, estimateTokens, PRESETS };
