import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../src/router.js';
import { serveStatic } from '../src/static.js';

const logged: string[] = [];
const router = new Router({ log: (m) => logged.push(m) });
router.get('/api/ping', () => ({ pong: true }));
router.get('/api/runs/:id', (ctx) => ({ id: ctx.params.id, q: Object.fromEntries(ctx.query) }));
router.post('/api/echo', (ctx) => ({ body: ctx.body }));
router.get('/api/boom', () => { throw new Error('kaboom'); });
router.get('/api/void', () => undefined);
router.get('/api/stream', (ctx) => {
  const s = ctx.sse();
  s.send('tick', { n: 1 });
  s.send('note', 'two\nlines');
  s.close();
});

const webui = mkdtempSync(join(tmpdir(), 'sh-webui-'));
writeFileSync(join(webui, 'index.html'), '<h1>hi</h1>');
mkdirSync(join(webui, 'js'));
writeFileSync(join(webui, 'js', 'app.js'), 'export const x = 1;');

const server: Server = createServer(async (req, res) => {
  if (await router.handle(req, res)) return;
  if (serveStatic(webui, req, res)) return;
  res.writeHead(404); res.end('nope');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

test('a plain route returns JSON with no-store on GET', async () => {
  const r = await fetch(`${base}/api/ping`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { pong: true });
});

test('path params and the query string are parsed', async () => {
  const r = await fetch(`${base}/api/runs/abc%2F1?repo=x&limit=5`);
  assert.deepEqual(await r.json(), { id: 'abc/1', q: { repo: 'x', limit: '5' } });
});

test('a JSON body is parsed for POST', async () => {
  const r = await fetch(`${base}/api/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await r.json(), { body: { a: 1 } });
});

test('an unknown /api path is an explicit 404 naming the stale-process cause', async () => {
  const r = await fetch(`${base}/api/nothing?x=1`);
  assert.equal(r.status, 404);
  const j = await r.json() as { ok: boolean; unknownRoute: string; msg: string };
  assert.equal(j.ok, false);
  assert.equal(j.unknownRoute, 'GET /api/nothing');
  assert.match(j.msg, /stale/);
});

test('a throwing handler answers 500 and the server stays up', async () => {
  const r = await fetch(`${base}/api/boom`);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, msg: 'kaboom' });
  assert.ok(logged.some((l) => l.includes('kaboom')));
  assert.equal((await fetch(`${base}/api/ping`)).status, 200);
});

test('a handler returning nothing answers {ok:true}', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/void`)).json(), { ok: true });
});

test('a handler may own the response as an SSE stream', async () => {
  const r = await fetch(`${base}/api/stream`);
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const text = await r.text();
  assert.ok(text.includes('event: tick\ndata: {"n":1}\n\n'));
  assert.ok(text.includes('event: note\ndata: two\ndata: lines\n\n'));
});

test('static files are served with containment, and unknown pages fall back to index.html', async () => {
  assert.equal(await (await fetch(`${base}/js/app.js`)).text(), 'export const x = 1;');
  assert.equal((await fetch(`${base}/js/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await (await fetch(`${base}/some/spa/route`)).text(), '<h1>hi</h1>');
  assert.equal((await fetch(`${base}/missing.css`)).status, 404);
  // fetch() resolves dot segments client-side, so only an ENCODED traversal reaches the server.
  assert.equal((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 403);
});
