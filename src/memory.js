'use strict';
// M4 Session Memory. Every tool invocation auto-captured (BR-013); memories
// auto-surface with a rationale inside pipeline/capsule responses (BR-014);
// staleness: linked code changed → flagged + demoted, never deleted (BR-015).
const { openMemory, openStore, openMemoryReadOnly } = require('./store');

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

function captureObservation(engDir, { session, tool, summary, symbol = null, file = null, kind = 'auto' }) {
  const db = openMemory(engDir);
  let hash = null;
  if (file) {
    try {
      const idx = openStore(engDir);
      hash = idx.prepare('SELECT hash FROM files WHERE path = ?').get(file)?.hash || null;
      idx.close();
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
  try { idx = openStore(engDir); } catch { db.close(); return; }
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

function terms(text) {
  return [...new Set((text || '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])];
}

// Relevance surface: term overlap between the task and stored observations.
// Stale observations are demoted (score halved) but still returned with a
// warning — never silently dropped (BR-015).
function searchMemory(engDir, query, { session = null, limit = 8, readOnly = false } = {}) {
  if (!readOnly) refreshStaleness(engDir);
  const db = readerDb(engDir, readOnly);
  const qTerms = terms(query);
  const rows = db.prepare('SELECT * FROM observations ORDER BY ts DESC LIMIT 500').all();
  db.close();
  const scored = rows.map(o => {
    const hay = `${o.summary} ${o.symbol || ''} ${o.file || ''} ${o.tool}`.toLowerCase();
    const matched = qTerms.filter(t => hay.includes(t));
    let score = matched.length + (o.kind === 'manual' ? 0.5 : 0);
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
  // Cross-session recall: current and previous sessions both returned (SM-4),
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

module.exports = { captureObservation, searchMemory, sessionContext, refreshStaleness };
