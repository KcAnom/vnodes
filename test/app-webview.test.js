'use strict';
require('./_registry_home');
/**
 * The operator UI is /Applications/vnodes.app: mkmacapp WKWebView on
 * http://127.0.0.1:{boundPort}/ui/bases (hub, preferred_port auto).
 *
 * That is a web browser. Same origin, same fetches (`/status`, `/tools`,
 * `/ui/api/*`, `/ui/map/*`, EventSource), same HTML+committed bundle. Tests
 * that only talk to renderShell() would miss Host/Origin/exact-URL traps the
 * WebView actually hits.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { registryDir, kbId, recordIndex } = require('../src/registry');

function tmpdir(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), `vnodes-${tag}-`)));
}

function fixtureProject(tag) {
  const root = tmpdir(tag);
  const eng = path.join(root, '.vnodes');
  fs.mkdirSync(eng, { recursive: true });
  const { openStore } = require('../src/store');
  const db = openStore(eng);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_index', ?)").run(String(Date.now()));
  db.close();
  fs.writeFileSync(path.join(eng, 'config.json'), JSON.stringify({ index: { watch: false } }));
  recordIndex(root, { files: 2, nodes: 4, edges: 1, langs: ['js'], repos: ['(root)'], ms: 1, engDir: eng });
  return { root, id: kbId(root), eng };
}

async function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function waitUp(base) {
  let last;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/status');
      if (r.ok) return await r.json();
      last = r.status;
    } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`daemon did not answer /status (${last})`);
}

/** Headers a same-origin WKWebView (or Safari/Chrome) sends on fetch(). */
function webview(port, extra = {}) {
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    accept: extra.accept || 'application/json',
    ...extra,
  };
}

test('the mac app WebView can load the hub picker and its same-origin APIs', async () => {
  const proj = fixtureProject('app-wv');
  const port = await freePort();
  process.env.VNODES_PORT = String(port);
  const { serve } = require('../src/daemon');
  const handle = serve(null); // hub — what macapp.json runs
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await waitUp(base);
    assert.strictEqual(status.project, null);
    assert.deepStrictEqual(status.index, { state: 'hub' });
    assert.strictEqual(status.port, port, 'WebView addr is the bound port (preferred_port auto)');
    assert.strictEqual(status.port, handle.port());

    // start_path
    const picker = await fetch(`${base}/ui/bases`, {
      headers: { ...webview(port), accept: 'text/html' },
    });
    assert.strictEqual(picker.status, 200);
    assert.match(picker.headers.get('content-type'), /text\/html/);
    const html = await picker.text();
    assert.match(html, /\/ui\/static\/map\.js/, 'shell must load the committed bundle');
    assert.match(html, /id="root"/);

    const js = await fetch(`${base}/ui/static/map.js`, { headers: webview(port) });
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    // Shell polls these with no query string. A helper that appends ?kb= 404s.
    const st = await fetch(`${base}/status`, { headers: webview(port) });
    assert.strictEqual(st.status, 200);
    const tools = await fetch(`${base}/tools`, { headers: webview(port) });
    assert.strictEqual(tools.status, 200);
    const catalog = await tools.json();
    assert.ok(catalog.tools.some(t => t.name === 'create_knowledge_base'));
    assert.strictEqual((await fetch(`${base}/status?kb=${proj.id}`)).status, 404);
    assert.strictEqual((await fetch(`${base}/tools?kb=${proj.id}`)).status, 404);

    const kbs = await fetch(`${base}/ui/api/kbs`, { headers: webview(port) });
    assert.strictEqual(kbs.status, 200, 'same-origin Origin+Host from the WebView must pass uiDenial');
    const list = await kbs.json();
    assert.strictEqual(list.hub, true);
    assert.ok(list.kbs.some(k => k.id === proj.id));

    // Missing Origin is also a WebView/curl shape.
    const kbsNoOrigin = await fetch(`${base}/ui/api/kbs`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.strictEqual(kbsNoOrigin.status, 200);

    // Scoped page with ?kb= — what a picker row opens.
    const health = await fetch(`${base}/ui/api/health?kb=${proj.id}`, { headers: webview(port) });
    assert.strictEqual(health.status, 200);
    const h = await health.json();
    assert.strictEqual(h.kb, proj.id);
    assert.strictEqual(h.kb_source, 'query');

    const overview = await fetch(`${base}/ui?kb=${proj.id}`, {
      headers: { ...webview(port), accept: 'text/html' },
    });
    assert.strictEqual(overview.status, 200);

    const map = await fetch(`${base}/ui/map/data?kb=${proj.id}&path=src`, { headers: webview(port) });
    assert.strictEqual(map.status, 200);

    // Hub has no launch project: the WebView must not POST /rpc (and the
    // daemon would 400 anyway). Origin matching the page still does not
    // invent a project.
    const rpc = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { ...webview(port), 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'index_status', arguments: {} }),
    });
    assert.strictEqual(rpc.status, 400);
    assert.match((await rpc.json()).error, /hub/i);

    // Foreign browser tab still cannot read UI data.
    const evil = await fetch(`${base}/ui/api/kbs`, {
      headers: { origin: 'https://evil.example', host: `127.0.0.1:${port}` },
    });
    assert.strictEqual(evil.status, 403);
  } finally {
    handle.close();
    delete process.env.VNODES_PORT;
  }
});

test('the WebView EventSource hello distinguishes watched vs static', async () => {
  const proj = fixtureProject('app-sse');
  const port = await freePort();
  process.env.VNODES_PORT = String(port);
  const { serve } = require('../src/daemon');
  const handle = serve(null);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitUp(base);
    const res = await fetch(`${base}/ui/map/events?kb=${proj.id}&path=src`, {
      headers: { ...webview(port), accept: 'text/event-stream' },
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const acc = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise(r => setTimeout(() => r({ value: null, done: false }), 300)),
      ]);
      if (value) acc.push(Buffer.from(value).toString('utf8'));
      const text = acc.join('');
      if (text.includes('event: hello')) {
        const line = text.split('\n').find(l => l.startsWith('data: '));
        assert.ok(line, 'hello frame carries data');
        const hello = JSON.parse(line.slice(6));
        assert.strictEqual(hello.kb, proj.id);
        assert.strictEqual(hello.watched_by_this_daemon, false,
          'a hub does not watch a foreign KB; the page must not say live');
        await reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
    }
    await reader.cancel().catch(() => {});
    assert.fail(`no hello frame in: ${acc.join('')}`);
  } finally {
    handle.close();
    delete process.env.VNODES_PORT;
  }
});
