'use strict';
// Local graph store: SQLite at .vnodes/index.db — gitignored, never leaves the
// machine (BR-001). Uses node:sqlite (built into Node 22+): zero native deps.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

function openStore(engDir) {
  const db = new DatabaseSync(path.join(engDir, 'index.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, repo TEXT DEFAULT '', hash TEXT, size INTEGER,
      lang TEXT, indexed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT, repo TEXT DEFAULT '',
      name TEXT, kind TEXT, line INTEGER, signature TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE TABLE IF NOT EXISTS edges (
      src_file TEXT, dst_file TEXT, kind TEXT DEFAULT 'import',
      PRIMARY KEY (src_file, dst_file, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_file);
    -- Raw, unresolved import specifiers as written in the source. Edges are
    -- derived from these every run: whether a spec resolves depends on the
    -- whole file set, so it cannot be cached per file the way parse output can.
    CREATE TABLE IF NOT EXISTS imports (
      file TEXT, repo TEXT DEFAULT '', spec TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

function openMemory(engDir) {
  const db = new DatabaseSync(path.join(engDir, 'memory.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER, session TEXT, tool TEXT, kind TEXT DEFAULT 'auto',
      summary TEXT, symbol TEXT, file TEXT, hash_at_save TEXT,
      stale INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts);
  `);
  return db;
}

module.exports = { openStore, openMemory };
