'use strict';
/**
 * Everything behind `/ui/api/*` — the data the browser reads, and nothing else.
 *
 * Split out of daemon.js, which had grown to 1,023 lines and could no longer be
 * handed to an agent as anything but a list of signatures: at 12,676 tokens it
 * exceeded any sane capsule budget, so the one file that answers "what does
 * this daemon actually serve" was the one file nobody could read in context.
 *
 * The router stayed behind. It is thirteen branches doing one job, and reading
 * it in one piece is the point of it. What left is what the branches CALL:
 * these handlers take explicit parameters, close over nothing in `serve`, and
 * own their only piece of module state.
 *
 * TWO RULES THIS MODULE CARRIES, both older than the split:
 *
 * Every route here is read-only and computed WITHOUT a tool call, so a browser
 * panel polling on a timer can never insert an observation into the feed agents
 * read, and never re-indexes anything.
 *
 * A knowledge base named in a query parameter reaches these functions only
 * through `resolveKb`, which looks its argument up as a key and never joins it
 * into a path.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, engineDirPath } = require('../config');
const { resolveKb, registryCfg } = require('../registry');
const { callTool } = require('../tools');
const { buildCapsule } = require('../capsule');
const { openStore } = require('../store');
const { log, logPath } = require('../logs');

const UI_API_ROUTES = ['/ui/api/kbs', '/ui/api/health', '/ui/api/capsule', '/ui/api/notes', '/ui/api/composition'];

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
}

/** Last N lines of a log channel, as lines. Fixed length so the response is bounded. */
function tailLog(projectRoot, channel, lines = 50) {
  try {
    return fs.readFileSync(logPath(projectRoot, channel), 'utf8')
      .split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * How many observations there are, and of what kind. Lets the notes page say
 * what it is looking at.
 *
 * Read-only: this ran openMemory, which CREATES memory.db, on a GET. For the
 * daemon's own project that was invisible; for a knowledge base named in a
 * query parameter it would be the daemon writing a database into a project the
 * reader merely clicked on.
 */
function observationCounts(engDir) {
  const { openMemoryReadOnly } = require('../store');
  try {
    const db = openMemoryReadOnly(engDir);
    if (!db) return null;
    const r = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN kind = 'manual' THEN 1 ELSE 0 END) manual,
      SUM(CASE WHEN kind <> 'manual' THEN 1 ELSE 0 END) auto,
      SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END) stale FROM observations`).get();
    db.close();
    return { total: Number(r.total || 0), manual: Number(r.manual || 0), auto: Number(r.auto || 0), stale: Number(r.stale || 0) };
  } catch {
    return null;
  }
}

/**
 * The capsule as the UI is allowed to see it.
 *
 * File bodies come out. The operator already has every one of these files open
 * in an editor two inches away, and shipping them would make this a 35 KB
 * response that says nothing the editor does not. The single exception is the
 * head of a clipped pivot: that is the one thing the editor cannot show,
 * because the clip is a decision the capsule made and not a fact about the file.
 */
/**
 * `projectFlag` is the project root to name in the reproduction line, or null
 * for the daemon's own. bin/vnodes.js resolves the project upward from cwd, so
 * once this page can preview a capsule for a knowledge base that is not the
 * daemon's launch project, the bare `vnodes pipeline "<task>"` printed here
 * reproduces a DIFFERENT project's capsule for whoever pastes it.
 */
function capsuleForUi(capsule, task, cfg, projectFlag = null) {
  const CLIP_HEAD_CHARS = 2000;
  return {
    ...capsule,
    pivots: capsule.pivots.map(p => {
      const out = { file: p.file, tokens: p.tokens };
      if (p.clipped) {
        out.clipped = true;
        out.full_tokens = p.full_tokens;
        out.content = String(p.content || '').slice(0, CLIP_HEAD_CHARS);
        out.content_is_head_of_clip = true;
      }
      return out;
    }),
    skeletons: capsule.skeletons.map(s => ({ file: s.file, tokens: s.tokens, detail: s.detail })),
    stripped: 'file bodies are not sent to the UI; only the head of a clipped pivot is',
    baseline: cfg.capsule.savings_baseline,
    command: `vnodes pipeline ${JSON.stringify(task)}${projectFlag ? ` --project ${projectFlag}` : ''}`,
  };
}

/**
 * What the index is actually made of.
 *
 * /status and doctor both reported healthy while 78% of this index was a
 * headless-Chrome profile, because neither of them looks at where the files
 * are or how big they are — index_status counts languages, and "173 json" is a
 * true sentence about a browser cache. Grouping on the first two path segments
 * is what makes `ui/.shots` its own row instead of a number hiding inside `ui`.
 */
/**
 * `projectRoot` is optional so the store-only callers (and their tests) keep
 * working; without it the page simply has no exclusions section rather than
 * inventing an empty one, which would read as "nothing was excluded".
 */
function composition(engDir, projectRoot) {
  const { openStoreReadOnly } = require('../store');
  // Read-only, and null rather than an empty page when there is no store: this
  // is reached by a GET that may name any registered knowledge base, and
  // openStore would have created an index.db inside it to answer.
  const db = openStoreReadOnly(engDir);
  if (!db) return null;
  const files = db.prepare('SELECT path, repo, lang, size FROM files').all();
  const symbols = new Map(db.prepare('SELECT file, COUNT(*) c FROM nodes GROUP BY file').all().map(r => [r.file, Number(r.c)]));
  const connected = new Set();
  for (const e of db.prepare('SELECT src_file, dst_file FROM edges').all()) {
    connected.add(e.src_file); connected.add(e.dst_file);
  }
  db.close();

  const dirs = new Map();
  for (const f of files) {
    const parts = String(f.path).split('/');
    parts.pop(); // the filename is not a directory
    const dir = parts.slice(0, 2).join('/') || '(root)';
    let row = dirs.get(dir);
    if (!row) dirs.set(dir, row = { dir, files: 0, bytes: 0, langs: {}, inert: 0 });
    row.files++;
    row.bytes += Number(f.size || 0);
    row.langs[f.lang || 'unknown'] = (row.langs[f.lang || 'unknown'] || 0) + 1;
    if (!symbols.get(f.path) && !connected.has(f.path)) row.inert++;
  }
  const byDir = [...dirs.values()].sort((a, b) => b.files - a.files);

  // A remedy is a line to copy, never a write: the daemon diagnosing its own
  // index is useful, the daemon editing .vnodesignore behind the operator's
  // back is the same class of surprise as a UI that saves observations.
  const ignoreSuggestion = byDir
    .filter(d => d.dir !== '(root)' && d.files >= 5 && d.inert / d.files >= 0.9)
    .slice(0, 5)
    .map(d => `${d.dir}/`);

  const LIST_CAP = 50;
  const noSymbols = files.filter(f => !symbols.get(f.path)).map(f => f.path);
  const noEdges = files.filter(f => !connected.has(f.path)).map(f => f.path);

  // What is on disk and deliberately absent. The page that answers "what is in
  // here" is not finished until it also answers "and what is not, and why".
  let excluded = null;
  if (projectRoot) {
    try {
      const { excludedSummary } = require('../exclusions');
      const report = excludedSummary(projectRoot);
      excluded = {
        subtrees: report.subtrees,
        files: report.files,
        by_source: report.by_source,
        truncated: report.truncated,
      };
    } catch (e) {
      excluded = { error: e.message };
    }
  }

  return {
    total_files: files.length,
    total_bytes: files.reduce((a, f) => a + Number(f.size || 0), 0),
    excluded,
    by_dir: byDir.slice(0, 12).map(({ inert, ...row }) => ({ ...row, inert_files: inert })),
    by_dir_shown: Math.min(12, byDir.length),
    by_dir_total: byDir.length,
    largest: [...files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0)).slice(0, 10)
      .map(f => ({ path: f.path, size: Number(f.size || 0), lang: f.lang, symbols: symbols.get(f.path) || 0 })),
    // Capped, and the count says how far past the cap it goes: a repo where
    // four thousand files parsed to nothing is exactly the repo where this
    // response must not be four thousand strings long.
    no_symbols: noSymbols.slice(0, LIST_CAP),
    no_symbols_total: noSymbols.length,
    no_edges: noEdges.slice(0, LIST_CAP),
    no_edges_total: noEdges.length,
    list_cap: LIST_CAP,
    ignore_suggestion: ignoreSuggestion,
  };
}

/**
 * The read-only data family behind the operator pages.
 *
 * None of these go through callTool. Every callTool invocation inserts an
 * observation (BR-013), so a panel that polls would fill the memory feed agents
 * read with rows summarising its own polling — which is both noise and a lie
 * about what happened in the session. Calling buildCapsule / sessionContext /
 * searchMemory / doctor directly is the pattern src/view/index.js already uses
 * for the map, and it writes nothing.
 */
/**
 * Whole-index work this knowledge base is too big for, or null.
 *
 * Not a taste judgement. composition() reads every row of `files` plus a full
 * edge scan into JS Maps; buildCapsule was measured at 18,648 ms and subgraph
 * at 7,850 ms against the home knowledge base — all of it synchronous, on the
 * daemon's single event loop, which means every other page in every other tab
 * stops for the duration. A 413 that names the file count and the size is a
 * better answer than a daemon that appears to have hung.
 */
function oversizeRefusal(root, entry, cfg, what) {
  const rcfg = registryCfg(cfg);
  const { engineDbBytes } = require('../registry');
  const dbBytes = engineDbBytes(engineDirPath(root));
  const files = entry && Number.isFinite(entry.files) ? entry.files : null;
  const limitBytes = rcfg.oversize_db_mb * 1024 * 1024;
  const over = (files !== null && files > rcfg.oversize_files) || (dbBytes !== null && dbBytes > limitBytes);
  if (!over) return null;
  return {
    error: `${what} is refused for this knowledge base: it is too large to compute in one synchronous pass`,
    files, db_bytes: dbBytes,
    limits: { oversize_files: rcfg.oversize_files, oversize_db_mb: rcfg.oversize_db_mb },
    hint: 'ask a narrower question — the map accepts ?target= or ?path= to scope a slice — or disown this index if it was indexed by accident (vnodes kb list shows why)',
  };
}

/**
 * composition(), remembered per index generation.
 *
 * It is the most expensive read on the /ui surface — every file row plus a full
 * edge scan — and the answer cannot change while the index has not been
 * rewritten. Keyed on the engine directory and the index database's mtime, so a
 * re-index invalidates it without anyone having to remember to. Eight entries:
 * enough for a reader flipping between knowledge bases, small enough that the
 * cache is never the thing holding a hundred megabytes of row objects alive.
 */
const COMPOSITION_CACHE_MAX = 8;
const compositionCache = new Map();
function cachedComposition(engDir, root) {
  let stamp = 0;
  try { stamp = fs.statSync(path.join(engDir, 'index.db')).mtimeMs; } catch {}
  const key = `${engDir}@${stamp}`;
  if (compositionCache.has(key)) return compositionCache.get(key);
  const value = composition(engDir, root);
  compositionCache.set(key, value);
  while (compositionCache.size > COMPOSITION_CACHE_MAX) {
    compositionCache.delete(compositionCache.keys().next().value);
  }
  return value;
}

/**
 * The read-only data family behind the operator pages, for ONE knowledge base.
 *
 * `ctx.root` came out of resolveKb, which means it is either the daemon's own
 * launch project or the `path` field of a registry record vnodes wrote. It is
 * never a string a caller supplied. `ctx.engDir` is engineDirPath, not
 * engineDir: this runs on every request, and the creating version would mkdir
 * `.vnodes/logs` and write a `.gitignore` inside whatever project the URL named.
 */
function uiApi(pathname, q, ctx, send) {
  // `doctor` arrives through ctx rather than an import. It lives with the
  // process lifecycle in daemon.js, which requires this module — importing it
  // back would be a cycle, and a lazy require inside the handler would only
  // hide one. The router already passes everything else this function needs
  // through ctx, so the probe travels the same way.
  const { root, engDir, cfg, kb, kbSource, entry, launchRoot, doctor } = ctx;
  const projectFlag = root === launchRoot ? null : root;
  if (pathname === '/ui/api/health') {
    const { llmState, runtimeInfo, runtimeCliFound } = require('../runtime');
    // doctor() is async (it probes the port) and createServer's callback is not,
    // so the response is written from the promise rather than returned.
    doctor(root).then(d => send(200, {
      // Which project these numbers are about, and whether the URL said so or
      // the daemon fell back to its own. A page that cannot tell the difference
      // is a page that will eventually show one project's health under
      // another's name.
      kb, kb_source: kbSource, project: root,
      doctor: d,
      llm: { ...llmState(root), mode: 'runtime-cli', runtime: runtimeInfo(root), runtime_cli_found: runtimeCliFound(root) },
      config: loadConfig(root),
      logs: { daemon: tailLog(root, 'daemon'), index: tailLog(root, 'index'), tail_lines: 50 },
    })).catch(e => send(500, { error: e.message }));
    return;
  }
  if (pathname === '/ui/api/capsule') {
    const task = String(q.task || '').trim();
    if (!task) return send(400, { error: 'no task' });
    const refusal = oversizeRefusal(root, entry, cfg, 'building a capsule');
    if (refusal) return send(413, { kb, ...refusal });
    const { buildCapsule } = require('../capsule');
    const capsule = buildCapsule(root, engDir, cfg, {
      task,
      preset: q.preset || undefined,
      max_tokens: clamp(q.max_tokens, 500, 200000, undefined),
      session: 'ui',
    });
    return send(200, { kb, ...capsuleForUi(capsule, task, cfg, projectFlag) });
  }
  if (pathname === '/ui/api/notes') {
    const { searchMemory, sessionContext } = require('../memory');
    const limit = clamp(q.limit, 1, 100, 20);
    // Never created to answer a GET. A knowledge base with no memory store is a
    // real, sayable state — "no agent has recorded anything here yet" — and
    // saying it is better than the daemon writing a memory.db into a project
    // from a surface documented as read-only.
    const memDb = path.join(engDir, 'memory.db');
    if (!fs.existsSync(memDb)) {
      return send(404, {
        kb, error: 'this knowledge base has no memory store yet', expected: memDb,
        detail: 'observations are written by agents through the MCP tools; nothing has written one for this project',
      });
    }
    const counts = observationCounts(engDir);
    // No `session` on either call: this daemon is not an agent session, and
    // passing one would sort the browser's own reads to the top of a feed whose
    // whole point is what the agents did.
    const query = String(q.q || '').trim();
    // Stated rather than assumed: staleness flags are as of the last write by
    // an indexer or an agent. Refreshing them is an UPDATE, and this surface
    // does not write.
    const staleness = {
      staleness_refreshed: false,
      staleness_note: 'stale flags are as of the last index run or agent call; the read-only UI does not re-check them',
    };
    return query
      ? send(200, { kb, query, results: searchMemory(engDir, query, { limit, readOnly: true }), counts, ...staleness })
      : send(200, { kb, observations: sessionContext(engDir, { limit, readOnly: true }), counts, ...staleness });
  }
  if (pathname === '/ui/api/composition') {
    const refusal = oversizeRefusal(root, entry, cfg, 'index composition');
    if (refusal) return send(413, { kb, ...refusal });
    const c = cachedComposition(engDir, root);
    return c
      ? send(200, { kb, ...c })
      : send(404, { kb, error: 'this knowledge base has no index database', expected: path.join(engDir, 'index.db') });
  }
  return send(404, { error: 'no such api route', api: UI_API_ROUTES });
}

module.exports = {
  UI_API_ROUTES, uiApi, composition, cachedComposition, capsuleForUi,
  observationCounts, oversizeRefusal, tailLog, clamp,
};
