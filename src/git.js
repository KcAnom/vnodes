'use strict';
// Git facts without depending on a child process on the hot path.
// headSha is a plain read of .git/HEAD (and packed-refs). Spawn is reserved
// for hook install / git add, where a hook is already a git invocation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function gitDir(root) {
  const p = path.join(root, '.git');
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return p;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(p, 'utf8'));
      if (m) return path.resolve(root, m[1].trim());
    }
  } catch {}
  return null;
}

function headSha(root) {
  const dir = gitDir(root);
  if (!dir) return null;
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (m) {
      try { return fs.readFileSync(path.join(dir, m[1]), 'utf8').trim(); } catch {}
      try {
        const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
        const ref = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = new RegExp(`^([0-9a-f]{40})\\s+${ref}$`, 'm').exec(packed);
        if (hit) return hit[1];
      } catch {}
      return null;
    }
    if (/^[0-9a-f]{7,40}$/.test(head)) return head;
  } catch {}
  return null;
}

function gitRun(root, args, timeout = 10000) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

module.exports = { gitDir, headSha, gitRun };
