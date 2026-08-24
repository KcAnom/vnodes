'use strict';
// M6 Multi-Repo Workspaces. Definition at .vnodes/workspace.json in the primary
// repo; paths resolve relative to the folder containing .vnodes (BR-020);
// secondary repos get an auto-written parent_workspace.json pointer (BR-019).
const fs = require('node:fs');
const path = require('node:path');

function loadWorkspace(projectRoot) {
  const wsPath = path.join(projectRoot, '.vnodes', 'workspace.json');
  const parentPtr = path.join(projectRoot, '.vnodes', 'parent_workspace.json');
  let defPath = null, baseDir = null;
  if (fs.existsSync(wsPath)) { defPath = wsPath; baseDir = projectRoot; }
  else if (fs.existsSync(parentPtr)) {
    // Opening a secondary repo still loads the full workspace (BR-019).
    try {
      const ptr = JSON.parse(fs.readFileSync(parentPtr, 'utf8'));
      const primary = path.resolve(projectRoot, ptr.primary);
      const p = path.join(primary, '.vnodes', 'workspace.json');
      if (fs.existsSync(p)) { defPath = p; baseDir = primary; }
    } catch {}
  }
  if (!defPath) return null;
  let def;
  try { def = JSON.parse(fs.readFileSync(defPath, 'utf8')); } catch { return null; }
  const name = def.name || def.workspace_id; // workspace_id accepted in place of name (BR-020)
  const repos = (def.repos || []).map(r => ({ alias: r.alias, path: r.path }));
  // Root repo is always primary (BR-020).
  if (!repos.some(r => path.resolve(baseDir, r.path) === baseDir))
    repos.unshift({ alias: def.primary_alias || 'root', path: '.' });
  return { name, repos, baseDir, primaryRoot: baseDir };
}

function setupWorkspace(projectRoot, def) {
  const engDir = path.join(projectRoot, '.vnodes');
  fs.mkdirSync(engDir, { recursive: true });
  const wsPath = path.join(engDir, 'workspace.json');
  fs.writeFileSync(wsPath, JSON.stringify(def, null, 2));
  // Auto-write parent pointers into secondary repos.
  const written = [];
  for (const r of def.repos || []) {
    const abs = path.resolve(projectRoot, r.path);
    if (abs === projectRoot || !fs.existsSync(abs)) continue;
    const sub = path.join(abs, '.vnodes');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'parent_workspace.json'),
      JSON.stringify({ primary: path.relative(abs, projectRoot) || '.' }, null, 2));
    written.push(r.alias);
  }
  return { workspace: wsPath, parent_pointers: written };
}

function forgetWorkspace(projectRoot) {
  const ws = loadWorkspace(projectRoot);
  if (!ws) return { ok: false, error: 'no workspace defined' };
  const removed = [];
  for (const r of ws.repos) {
    const abs = path.resolve(ws.baseDir, r.path);
    if (abs === ws.primaryRoot) continue;
    const ptr = path.join(abs, '.vnodes', 'parent_workspace.json');
    if (fs.existsSync(ptr)) { fs.unlinkSync(ptr); removed.push(ptr); }
  }
  const primary = path.join(ws.primaryRoot, '.vnodes', 'workspace.json');
  if (fs.existsSync(primary)) { fs.unlinkSync(primary); removed.push(primary); }
  return { ok: true, name: ws.name, removed, note: 'indexes were not touched' };
}

module.exports = { loadWorkspace, setupWorkspace, forgetWorkspace };
