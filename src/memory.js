'use strict';
// Session Memory. Findings are kind=manual — narrowed because auto-capture
// of every tool call filled the diary with argument JSON. Capsules attach
// findings with a rationale. Staleness: linked code changed → flagged
// + demoted, never deleted.
const { openMemory, openStoreReadOnly, openMemoryReadOnly } = require('./store');

/**
 * The connection a reader gets.
 *
 * `readOnly` is not a hint. openMemory creates memory.db if it is absent and
 * runs DDL on it, which is correct for an agent recording what it did and wrong
 * for the /ui surface — a GET may not bring a database into existence inside a
 * project the reader merely looked at. A read-only caller also skips
 * refreshStaleness, because that is an UPDATE: the flags it would set are real,
 * but writing them is the indexer's and the agents' job, not the browser's.
 */
function readerDb(engDir, readOnly) {
  if (!readOnly) return openMemory(engDir);
  const db = openMemoryReadOnly(engDir);
  if (!db) throw Object.assign(new Error('no memory store'), { code: 'ENOMEMORYDB' });
  return db;
}

function updateObservation(engDir, { id, summary, file, symbol }) {
  const db = openMemory(engDir);
  const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(Number(id));
  if (!row) { db.close(); return { ok: false, error: 'no such note', id }; }
  if (row.kind !== 'manual') {
    db.close();
    return { ok: false, error: 'only findings can be updated', id: row.id, kind: row.kind };
  }
  const nextSummary = summary != null ? String(summary).slice(0, 800) : row.summary;
  const nextFile = file !== undefined ? (file || null) : row.file;
  const nextSymbol = symbol !== undefined ? (symbol || null) : row.symbol;
  let hash = row.hash_at_save;
  let stale = row.stale;
  if (file !== undefined) {
    hash = null;
    stale = 0;
    if (nextFile) {
      try {
        const idx = openStoreReadOnly(engDir);
        if (idx) {
          hash = idx.prepare('SELECT hash FROM files WHERE path = ?').get(nextFile)?.hash || null;
          idx.close();
        }
      } catch {}
    }
  }
  db.prepare('UPDATE observations SET summary = ?, file = ?, symbol = ?, hash_at_save = ?, stale = ? WHERE id = ?')
    .run(nextSummary, nextFile, nextSymbol, hash, stale, row.id);
  db.close();
  return { ok: true, id: row.id, summary: nextSummary, file: nextFile, symbol: nextSymbol };
}

function deleteObservation(engDir, id) {
  const db = openMemory(engDir);
  const row = db.prepare('SELECT id, kind FROM observations WHERE id = ?').get(Number(id));
  if (!row) { db.close(); return { ok: false, error: 'no such note', id }; }
  if (row.kind !== 'manual') {
    db.close();
    return { ok: false, error: 'only findings (manual notes) can be deleted', id: row.id, kind: row.kind };
  }
  db.prepare('DELETE FROM observations WHERE id = ?').run(row.id);
  db.close();
  return { ok: true, id: row.id };
}

function captureObservation(engDir, { session, tool, summary, symbol = null, file = null, kind = 'auto' }) {
  const db = openMemory(engDir);
  let hash = null;
  if (file) {
    try {
      const idx = openStoreReadOnly(engDir);
      if (idx) {
        hash = idx.prepare('SELECT hash FROM files WHERE path = ?').get(file)?.hash || null;
        idx.close();
      }
    } catch {}
  }
  db.prepare('INSERT INTO observations (ts, session, tool, kind, summary, symbol, file, hash_at_save) VALUES (?,?,?,?,?,?,?,?)')
    .run(Date.now(), session || 'default', tool || '', kind, (summary || '').slice(0, 800), symbol, file, hash);
  db.close();
}

// Re-check staleness of file-linked observations against current index hashes.
function refreshStaleness(engDir) {
  const db = openMemory(engDir);
  let idx;
  try { idx = openStoreReadOnly(engDir); } catch { db.close(); return; }
  if (!idx) { db.close(); return; }
  const linked = db.prepare('SELECT id, file, hash_at_save FROM observations WHERE file IS NOT NULL AND stale = 0').all();
  const upd = db.prepare('UPDATE observations SET stale = 1 WHERE id = ?');
  for (const o of linked) {
    const cur = idx.prepare('SELECT hash FROM files WHERE path = ?').get(o.file)?.hash;
    if (o.hash_at_save && cur && cur !== o.hash_at_save) upd.run(o.id);
    if (o.hash_at_save && !cur) upd.run(o.id); // linked file gone
  }
  idx.close();
  db.close();
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'but', 'not', 'you', 'your', 'into', 'than', 'then',
  'them', 'they', 'what', 'when', 'where', 'which', 'while', 'about', 'after',
  'before', 'would', 'could', 'should', 'does', 'did', 'just', 'also', 'more',
  'most', 'some', 'any', 'all', 'each', 'every', 'only', 'same', 'other',
  'very', 'can', 'will', 'how', 'why', 'who', 'its', 'task',
]);

function terms(text) {
  return [...new Set((text || '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])]
    .filter(t => !STOPWORDS.has(t));
}

/**
 * A row whose summary is a record of a task, written by the capsule itself.
 *
 * `run_pipeline` stores the task text verbatim — "task: <what you asked> →
 * intent=…, 3 pivots" — and this function then scores by term overlap against
 * that same text. Ask the same question twice and its own history matches
 * perfectly: measured on this repo 2026-08-23, two of these scored 16.00 while
 * the three real findings scored 5.50, 4.50 and 3.25, and after the memory
 * reserve landed they were consuming about 40% of it.
 *
 * No weight fixes that, because the number is not wrong — the row really does
 * contain every word of the query. What is wrong is the question being asked:
 * against a task record, term overlap measures "is this the same question",
 * and this function exists to answer "does this knowledge bear on it".
 */
const TASK_TOOLS = new Set(['run_pipeline', 'get_context_capsule']);
const isTaskRecord = o => o.kind !== 'manual' && TASK_TOOLS.has(o.tool);

// Relevance surface: term overlap between the task and stored observations.
// Stale observations are demoted (score halved) but still returned with a
// warning — never silently dropped.
function searchMemory(engDir, query, { session = null, limit = 8, readOnly = false, findingsOnly = false } = {}) {
  if (!readOnly) refreshStaleness(engDir);
  const db = readerDb(engDir, readOnly);
  const qTerms = terms(query);
  let rows = db.prepare('SELECT * FROM observations ORDER BY ts DESC LIMIT 500').all();
  db.close();
  // The diary is kind=manual. Task echoes and leftover auto rows are activity.
  // Capsules attach the diary; sessionContext still returns the log.
  if (findingsOnly) rows = rows.filter(o => o.kind === 'manual' && !isTaskRecord(o));
  const scored = rows.map(o => {
    // A task record is matched on what it produced, never on the task it
    // echoes. It stays eligible — a prior run linked to the same file is a
    // real, if weak, signal — it simply cannot win by quoting the question
    // back. get_session_context still returns these in full: they are a record
    // of activity, which is that surface's job and not this one's.
    const hay = (isTaskRecord(o)
      ? `${o.symbol || ''} ${o.file || ''} ${o.tool}`
      : `${o.summary} ${o.symbol || ''} ${o.file || ''} ${o.tool}`).toLowerCase();
    const matched = qTerms.filter(t => hay.includes(t));
    // Kind multiplies rather than adds. The old +0.5 was set against match
    // counts that reach double figures, where it is not a preference, it is a
    // rounding error — a finding someone chose to write down should outrank a
    // byproduct in proportion, not by a constant.
    let score = matched.length * (o.kind === 'manual' ? 1.5 : 1);
    if (session && o.session === session) score += 0.25;
    if (o.stale) score *= 0.5;
    return { o, score, matched };
  }).filter(s => s.score > 0.5 || !query)
    .sort((a, b) => b.score - a.score || b.o.ts - a.o.ts)
    .slice(0, limit);
  return scored.map(({ o, matched }) => ({
    id: o.id, ts: o.ts, session: o.session, tool: o.tool, kind: o.kind,
    summary: o.summary, symbol: o.symbol, file: o.file,
    stale: !!o.stale,
    ...(o.stale ? { warning: 'stale: linked code changed since this was saved' } : {}),
    rationale: matched.length ? `matched terms: ${matched.slice(0, 6).join(', ')}` : 'recent observation',
  }));
}

function sessionContext(engDir, { session = null, limit = 20, readOnly = false } = {}) {
  if (!readOnly) refreshStaleness(engDir);
  const db = readerDb(engDir, readOnly);
  // Cross-session recall: current and previous sessions both returned,
  // but the caller's own session sorts first and each row says whose it is.
  const rows = session
    ? db.prepare('SELECT * FROM observations ORDER BY (session = ?) DESC, ts DESC LIMIT ?').all(session, limit)
    : db.prepare('SELECT * FROM observations ORDER BY ts DESC LIMIT ?').all(limit);
  db.close();
  return rows.map(o => ({
    id: o.id, ts: o.ts, session: o.session, tool: o.tool, kind: o.kind,
    ...(session ? { current_session: o.session === session } : {}),
    summary: o.summary, symbol: o.symbol, file: o.file, stale: !!o.stale,
    ...(o.stale ? { warning: 'stale: linked code changed since this was saved' } : {}),
  }));
}

function clearActivity(engDir) {
  const db = openMemory(engDir);
  const info = db.prepare("DELETE FROM observations WHERE kind != 'manual'").run();
  db.close();
  return { ok: true, deleted: Number(info.changes || 0) };
}

const FOUNDATION_PREFIX = '[vnodes:foundation]';

function hasFoundationSeed(engDir) {
  try {
    const db = openMemoryReadOnly(engDir);
    if (!db) return false;
    try {
      const row = db.prepare('SELECT id FROM observations WHERE kind = ? AND summary LIKE ? LIMIT 1')
        .get('manual', `${FOUNDATION_PREFIX}%`);
      return !!row;
    } finally { db.close(); }
  } catch { return false; }
}

function foundationSummary({ name, files, nodes, edges, langs = [], hubs = [] }) {
  const langBit = langs.length
    ? ` Languages: ${langs.map(l => l).join(', ')}.`
    : '';
  const hubBit = hubs.length ? ` Hubs: ${hubs.join(', ')}.` : '';
  const body = `${FOUNDATION_PREFIX} Established vnodes on ${name}: ${files} files, ${nodes} symbols, ${edges} edges.${langBit}${hubBit} First durable finding from the index — later sessions should add findings, not replace this one. Call run_pipeline at the start of each task; get_impact_graph before changing a file.`;
  return body.slice(0, 800);
}

function seedFoundation(engDir, snapshot) {
  if (hasFoundationSeed(engDir)) return { seeded: false, reason: 'already seeded' };
  const summary = foundationSummary(snapshot);
  captureObservation(engDir, {
    session: 'seed',
    tool: 'save_observation',
    kind: 'manual',
    summary,
    file: snapshot.pivot || null,
  });
  return { seeded: true, summary };
}

module.exports = { captureObservation, deleteObservation, updateObservation, clearActivity, searchMemory, sessionContext, refreshStaleness, seedFoundation, hasFoundationSeed, FOUNDATION_PREFIX };
