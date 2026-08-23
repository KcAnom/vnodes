'use strict';
// Map surface assembly: query → graph slice (+ optional capsule overlay) →
// laid-out view. The only place data.js, capsule.js and model.js meet, so the
// daemon route stays a route.
const { subgraph } = require('./data');
const { buildMapView } = require('./model');

function clampDepth(value, fallback = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(6, Math.max(1, Math.trunc(n))) : fallback;
}

/**
 * Build the view for one map query.
 *
 * `task` runs the real context pipeline rather than a lookalike: the overlay is
 * only worth drawing if it shows what an agent would actually be handed, which
 * means the same buildCapsule the MCP tool calls. Pivots become the focus,
 * skeleton files the supporters.
 */
function mapView(projectRoot, engDir, cfg, query = {}) {
  const target = String(query.target || '').trim();
  const task = String(query.task || '').trim();
  const repo = String(query.repo || '').trim();
  const depth = clampDepth(query.depth);
  // Both live in the URL rather than in client state, because an SSE reconnect
  // replays this same query object and a map linked into a review has to
  // reproduce the picture its author was looking at.
  const path = String(query.path || '').trim();
  const show = query.show === 'all' ? 'all' : 'code';
  const maxNodes = (cfg.ui && cfg.ui.map_max_nodes) || 150;

  let focus = new Set();
  let supporters = new Set();
  let intent = '';
  if (task) {
    const { buildCapsule } = require('../capsule');
    const capsule = buildCapsule(projectRoot, engDir, cfg, { task, session: 'ui-map' });
    intent = capsule.intent;
    focus = new Set(capsule.pivots.map(p => p.file));
    supporters = new Set(capsule.skeletons.map(s => s.file));
  }

  const slice = subgraph(engDir, {
    target,
    depth,
    repo,
    maxNodes,
    path,
    show,
    // Split, not merged: if the capsule outgrows the map's node budget the
    // pivots are the last thing to go, and the skeletons go before them.
    pin: [...focus],
    prefer: [...supporters],
  });

  // Absent from the query, box size is the model's call (it scales with node
  // count); present, the page's toggle decides.
  const compact = query.compact === undefined || query.compact === ''
    ? undefined
    : query.compact === '1' || query.compact === 'true';

  return buildMapView(slice, { root: projectRoot, task, intent, focus, supporters, compact });
}

module.exports = { mapView, clampDepth };
