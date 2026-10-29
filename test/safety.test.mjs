import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installReadOnlyGuard } from '../safety.mjs';
import { launchBrowser, probe, safeMessage } from '../probe.mjs';

test('public policy denies writes and outside navigation before any network operation', async () => {
  let handler, socketHandler;
  const blocked = await installReadOnlyGuard({ route: async (_pattern, value) => { handler = value; }, routeWebSocket: async (_pattern, value) => { socketHandler = value; } }, ['https://meum.me']);
  const call = async (method, url, navigation = false) => {
    let decision;
    await handler({ request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => navigation }), abort: async () => { decision = 'abort'; }, fallback: async () => { decision = 'allow'; } });
    return decision;
  };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(await call(method, 'https://meum.me/api/change?token=must-not-copy'), 'abort');
  assert.equal(await call('GET', 'https://meum.me/home', true), 'allow');
  assert.equal(await call('GET', 'https://outside.example/', true), 'abort');
  assert.equal(await call('GET', 'https://assets.example/a.css'), 'allow');
  for (const path of ['/api/rooms/123/roses', '/api/rooms/comment-settings/123', '/api/rooms/123/password/status']) {
    assert.equal(await call('GET', `https://backend.meum.me${path}`), 'abort');
    assert.equal(await call('HEAD', `https://backend.meum.me${path}`), 'abort');
  }
  let closed = false; socketHandler({ close: () => { closed = true; } }); assert.equal(closed, true);
  assert.ok(!JSON.stringify(blocked).includes('must-not-copy'));
});

test('common secret forms and query values are not retained in error messages', () => {
  const message = safeMessage('https://host.example/read?access_token=hidden Authorization: Bearer very-secret password="hidden value" api_key=private');
  for (const secret of ['very-secret', 'hidden value', 'private', 'access_token=hidden']) assert.ok(!message.includes(secret));
});

test('real render guard blocks implicit page writes and does not save captures by default', { skip: process.env.RUN_BROWSER_TESTS !== '1' }, async () => {
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') writes++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><main style="padding:40px;background:#ddeeff"><h1>Synthetic readonly page</h1><p>This is enough local content for a rendered browser fixture.</p></main><script>fetch("/write",{method:"POST",body:"synthetic-only"}).catch(()=>{});</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-render-policy-'));
  const browser = await launchBrowser();
  try {
    const result = await probe(browser, { id: 'd'.repeat(20), name: 'Synthetic', url: origin, viewport: { name: 'desktop', width: 900, height: 600 }, rule: { selectors: ['main h1'], loading: [], errors: [] } }, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 1000, settleMs: 100 }, directory);
    assert.equal(writes, 0);
    assert.equal(result.status, 'unknown');
    assert.ok(result.issues.some(item => item.kind === 'read-only-block'));
    assert.equal(result.screenshot, null);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('meum-render-policy-'));
    await rm(directory, { recursive: true, force: true });
  }
});
