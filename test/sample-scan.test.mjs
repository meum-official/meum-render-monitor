import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('scan resumes the same public sample from a lightweight checkpoint without expanding clicked viewer IDs', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 60000 }, async () => {
  const room = id => ({ id, source_type: 'room', open_type: 'public', status_id: 3, is_expired: 0, start_at: '2020-01-01T00:00:00Z', end_at: '2099-01-01T00:00:00Z' });
  let rows = [room(10001), room(10002)];
  const html = '<!doctype html><html><body style="background:linear-gradient(60deg,#bde4ff,#d4ffdf)"><main style="padding:40px"><h1>Public sample fixture</h1><p>This synthetic local page supplies enough rendered content for a private browser test.</p><div class="preview2"><div class="hero__content"><h1>Sample exhibition</h1></div><div class="hero__actions"><button class="button--hero" onclick="window.open(\'/meum-lite-viewer?r=outside-sample\')">View synthetic exhibition</button></div></div></main></body></html>';
  const { encodePublicRoomId } = await import('../sampling.mjs');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body;
    if (url.pathname === '/room/list') body = { success: true, fullRoomCount: rows.length, result: rows };
    else if (/^\/api\/rooms\/\d+\/viewer-entry$/.test(url.pathname)) body = { success: true, result: { room_id: Number(url.pathname.split('/')[3]), state: 'OPEN' } };
    else if (/^\/exhibition\/invitation\/[^/]+\/introduction$/.test(url.pathname)) body = { success: true, result: rows.find(row => encodePublicRoomId(row.id) === url.pathname.split('/')[3]) };
    if (body) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-sample-scan-'));
  const priorLimit = process.env.SCAN_LIMIT;
  const priorData = process.env.DATA_DIR;
  process.env.SCAN_LIMIT = '1';
  process.env.DATA_DIR = directory;
  try {
    const { emptyState, runScan } = await import('../server.mjs');
    const config = { origins: [origin], sitemaps: [], extraPages: [{ url: origin + '/fixture', name: 'Synthetic static page' }], roomListUrl: origin + '/room/list', sampling: { enabled: true, previews: 1, invitations: 1, viewers: 1, publicOrigin: origin }, viewports: [{ name: 'desktop', width: 900, height: 600 }], navigationTimeoutMs: 3000, renderTimeoutMs: 1500, settleMs: 50, betweenPagesMs: 0, maxSitemaps: 2, maxRoomPages: 2, retainedRuns: 2, followViewerEntries: true, captureScreenshots: false };
    const first = await runScan(config, emptyState(), async () => {});
    assert.equal(first.continuation, true);
    assert.equal(first.results.length, 4);
    const selected = structuredClone(first.discovery.sampling);
    const checkpoint = { ...first, results: first.results.map(({ id, status, checkedAt, checks, issues }) => ({ id, status, checkedAt, checks, issues })) };
    rows = [room(10003), ...rows.reverse()];
    const second = await runScan(config, checkpoint, async () => {});
    assert.equal(second.discovery.sampling.selectionId, selected.selectionId);
    assert.equal(second.discovery.sampling.seed, selected.seed);
    assert.deepEqual(second.discovery.sampling.previews.map(row => row.roomId), selected.previews.map(row => row.roomId));
    assert.equal(second.runId, first.runId);
    assert.equal(second.results.length, 4);
    assert.ok(second.results.every(row => row.url && row.viewport?.name === 'desktop'));
    assert.ok(second.results.every(row => !row.url.includes('outside-sample')));
  } finally {
    if (priorLimit === undefined) delete process.env.SCAN_LIMIT; else process.env.SCAN_LIMIT = priorLimit;
    if (priorData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorData;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('meum-sample-scan-'));
    await rm(directory, { recursive: true, force: true });
  }
});
