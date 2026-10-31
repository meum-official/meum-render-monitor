import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser, probe } from '../probe.mjs';
import { renderRuleFor, contractDigest } from '../render-mode.mjs';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { publicSummary } from '../export-report.mjs';
import { fileURLToPath } from 'node:url';

test('local render-only browser: no actions; responsive empty state, policy blocks and actual failures differ', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 90000 }, async () => {
  let writeRequests = 0, blockedReads = 0, callbacks = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') { writeRequests++; res.end('unexpected'); return; }
    if (url.pathname === '/api/rooms/getDataJson') { blockedReads++; res.end('unexpected'); return; }
    if (url.pathname === '/missing.png') { res.writeHead(404); res.end(); return; }
    const variant = url.searchParams.get('variant');
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head>${variant === 'no-viewport' ? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">'}<style>body{margin:0;background:linear-gradient(40deg,#a9d6ff,#e1e8ff);font:18px Arial}main{padding:30px;min-height:900px}.column{display:block}@media(max-width:600px){.column{display:none}}${variant === 'overflow' ? 'main{width:120vw}' : ''}</style></head><body><main class="customer-center"><h1 class="hero__title">Synthetic page</h1><div class="customer-center__view"><div class="column">Number and date</div><section data-render-state="empty" role="status">No entries in this successful synthetic result.</section><p>Required meaningful page content independent of the shared site header.</p><form onsubmit="fetch('/write',{method:'POST'});return false"><input name="name"><button>Save</button></form></div>${variant === 'broken' ? '<img src="/missing.png">' : ''}${['policy', 'policy-fetch', 'policy-independent'].includes(variant) ? '<img src="/api/rooms/getDataJson?room_id=1">' : ''}<script>${variant === 'policy-fetch' ? "fetch('/api/rooms/getDataJson?room_id=1').catch(()=>{throw Error('Failed to fetch')})" : ['javascript', 'policy-independent'].includes(variant) ? 'setTimeout(()=>{throw Error("synthetic app failure")},30)' : 'console.error("private-console-sentinel")'}</script></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    for (const viewport of [{ name: 'desktop', width: 1200, height: 800 }, { name: 'mobile', width: 390, height: 844, isMobile: true }]) {
      for (const [variant, expected] of [['healthy', 'pass'], ['broken', 'fail'], ['policy', 'unknown'], ['policy-fetch', 'unknown'], ['policy-independent', 'fail'], ['overflow', 'fail'], ['javascript', 'fail'], ['no-viewport', viewport.isMobile ? 'fail' : 'pass']]) {
        const result = await probe(browser, { id: '1'.repeat(20), url: origin + '/fixture?variant=' + variant, viewport, rule: renderRuleFor('https://meum.me/customer-center/notice') }, {
          renderOnly: true, origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 1000, settleMs: 80,
          captureScreenshots: false, followViewerEntries: true, functionalNavigation: true, observePage() { callbacks++; },
        }, 'unused');
        assert.equal(result.status, expected, `${viewport.name}/${variant}: ${JSON.stringify(result.issues)}`);
        assert.equal(result.screenshot, null);
        assert.ok(result.renderDiagnostics.lazyViewports === 3);
        if (variant === 'healthy') assert.equal(result.renderDiagnostics.consoleErrors, 1);
      }
    }
    assert.equal(callbacks, 0);
    assert.equal(writeRequests, 0);
    assert.equal(blockedReads, 0);
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('actual runScan excludes business and navigation even when action settings are supplied', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 30000 }, async () => {
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><meta name="viewport" content="width=device-width"><body style="background:linear-gradient(45deg,#abcdef,#fedcba)"><main><h1>Synthetic integration</h1><p>This private local page verifies the actual render scan pipeline.</p><button onclick="fetch(\'/write\',{method:\'POST\'})">Save</button></main></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-render-only-integration-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    const { emptyState, runScan } = await import('../server.mjs');
    const state = await runScan({ renderOnly: true, origins: [origin], sitemaps: [], extraPages: [{ url: origin + '/fixture', name: 'Synthetic' }], viewports: [{ name: 'desktop', width: 900, height: 600 }], navigationTimeoutMs: 3000, renderTimeoutMs: 300, settleMs: 30, betweenPagesMs: 0, maxSitemaps: 2, maxRoomPages: 2, retainedRuns: 1, business: { scenarioIds: ['invalid-sentinel'] }, functionalNavigation: true, followViewerEntries: true }, emptyState(), async () => {});
    assert.equal(state.status, 'completed');
    assert.equal(state.renderOnly, true);
    assert.equal(state.results.length, 1);
    assert.equal(state.businessVerification.required, false);
    assert.deepEqual(state.businessVerification.cases, []);
    assert.equal(state.results[0].layers.navigation.required, false);
    assert.equal(state.verification.business.total, 0);
    assert.match(state.versions.contractHash, /^[a-f0-9]{64}$/);
    assert.equal(state.versions.sourceRevision, 'unknown');
    assert.equal(writes, 0);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('meum-render-only-integration-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('local dashboard displays excluded scopes and unknown revision evidence without publishing captures', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 30000 }, async () => {
  const hash = contractDigest((await Promise.all(['contracts.mjs', 'render-mode.mjs'].map(name => readFile(new URL('../' + name, import.meta.url), 'utf8')))).join('\n'));
  const report = publicSummary({ renderOnly: true, versions: { contractHash: hash }, status: 'completed', completedAt: new Date().toISOString(), results: [{ id: 'a'.repeat(20), url: 'https://meum.me/home', checkedAt: new Date().toISOString(), status: 'pass', checks: [], issues: [], renderDiagnostics: { consoleErrors: 1, lazyViewports: 3 } }], discovery: {} });
  const server = createServer(async (req, res) => {
    if (req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(report)); return; }
    const name = ({ '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' })[req.url];
    if (!name) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL('../public/' + name, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let external = 0;
    await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external++; return route.abort(); } return route.continue(); });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => document.getElementById('version-meta').textContent.includes('unknown'));
    assert.match(await page.locator('#layer-summaries').innerText(), /대상 아님/);
    assert.doesNotMatch(await page.locator('#overview-title').innerText(), /기존 보고서/);
    assert.equal(await page.locator('#results .legacy-label').count(), 0);
    assert.match(await page.locator('#version-meta').innerText(), /제품 소스 unknown.*운영 배포 unknown/);
    assert.equal(report.evidence?.screenshotsPublic, undefined);
    assert.equal(report.results[0].screenshot, null);
    assert.equal(external, 0);
    await mkdir(new URL('../data/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('../data/local-render-dashboard.png', import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 392), 'mobile dashboard must wrap the long contract hash');
    await page.screenshot({ path: fileURLToPath(new URL('../data/local-render-dashboard-mobile.png', import.meta.url)), fullPage: true });
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
