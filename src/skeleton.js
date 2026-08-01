'use strict';
// Skeleton: signatures-only view of a file at minimal / standard / detailed.
// (industry-diff: structural signatures, not a UI skeleton screen)
const fs = require('node:fs');
const path = require('node:path');

const LEVEL_KINDS = {
  minimal: new Set(['class', 'interface', 'struct', 'enum', 'trait', 'module', 'component', 'document', 'table', 'view', 'type']),
  standard: null, // all kinds except methods
  detailed: null, // all kinds
};

function buildSkeleton(db, fileKey, detail = 'standard') {
  const rows = db.prepare('SELECT name, kind, line, signature FROM nodes WHERE file = ? ORDER BY line').all(fileKey);
  if (rows.length === 0) return null;
  const pick = rows.filter(r => {
    if (detail === 'minimal') return LEVEL_KINDS.minimal.has(r.kind) || r.kind === 'function';
    if (detail === 'standard') return r.kind !== 'method' && r.kind !== 'link';
    return true;
  });
  const lines = [`// skeleton: ${fileKey} (${detail}) — ${pick.length} symbols`];
  for (const r of pick) {
    lines.push(detail === 'minimal'
      ? `${r.kind} ${r.name}  [L${r.line}]`
      : `L${r.line}  ${r.signature || `${r.kind} ${r.name}`}`);
  }
  return lines.join('\n');
}

module.exports = { buildSkeleton };
