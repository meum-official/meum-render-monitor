import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('full scan separates render, navigation and unavailable business evidence', { skip: process.env.RUN_BROWSER_TESTS !== '1' }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html lang="ko"><body><main style="padding:40px;background:#e7eef8"><h1>Local synthetic page</h1><p>Only synthetic fixture content is served by this private test.</p></main></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-scan-integration-'));
  const originalData = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    const { emptyState, runScan, DATA } = await import('../server.mjs');
    assert.equal(DATA, directory);
    const config = { origins: [origin], sitemaps: [], extraPages: [{ url: origin + '/fixture', name: 'Synthetic' }], viewports: [{ name: 'desktop', width: 900, height: 600 }], navigationTimeoutMs: 3000, renderTimeoutMs: 1000, settleMs: 50, betweenPagesMs: 0, maxSitemaps: 3, maxRoomPages: 3, retainedRuns: 2, journeyTimeoutMs: 1000, journeyContracts: { '/fixture': { id: 'synthetic-direct', modes: ['direct'], language: 'ko', expected: { path: '/fixture', language: 'ko' }, ready: { selectors: ['main h1'] }, actions: [] } } };
    // Render contracts are intentionally unregistered for arbitrary fixture hosts.
    const state = emptyState();
    await runScan(config, state, async () => {});
    assert.equal(state.status, 'completed');
    assert.equal(state.results.length, 1);
    assert.equal(state.results[0].layers.render.status, 'unregistered');
    assert.equal(state.results[0].layers.navigation.status, 'pass');
    assert.equal(state.results[0].status, 'unknown');
    assert.equal(state.businessVerification.cases.length, 11);
    assert.ok(state.businessVerification.cases.every(item => item.status === 'blocked'));
    assert.equal(state.verification.business.pass, 0);
    assert.notEqual(state.verification.status, 'pass');
  } finally {
    if (originalData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalData;
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('meum-scan-integration-'));
    await rm(directory, { recursive: true, force: true });
  }
});
