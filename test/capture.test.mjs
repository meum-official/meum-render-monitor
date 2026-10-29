import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportReport, publicCiState, publicSummary } from '../export-report.mjs';
import { launchBrowser, probe } from '../probe.mjs';

const rowId = 'a'.repeat(20);
const now = () => new Date().toISOString();
const selection = () => ({ schemaVersion: 1, mode: 'representative-sample', selectedAt: now(), selectionId: 'b'.repeat(20), seed: '12345678-1234-1234-1234-123456789abc', limits: { previews: 3, invitations: 3, viewers: 3 }, pool: { listed: 100, declared: 1000, pagesRead: 2, complete: false, bounded: true, eligible: 3, private: 'SECRET_POOL' }, previews: [{ roomId: 4348, hash: 'SyntheticPublicHash', url: 'https://meum.me/exhibition/preview/4348', reason: 'public-active-guest-open', eligible: true }], invitations: [], viewers: [], unavailable: [], scope: 'SECRET_SCOPE', reason: 'SECRET_REASON' });
const sourceReport = () => ({ schemaVersion: 1, status: 'completed', runId: 'run-1-abcdef', startedAt: now(), attemptStartedAt: now(), completedAt: now(), intervalMinutes: 60, inventorySignature: 'c'.repeat(64), continuation: true, discovery: { complete: true, totalExhibitions: 1, totalTargets: 1, sampling: selection(), errors: [] }, results: [{ id: rowId, name: 'SECRET_CUSTOMER_TITLE', title: 'SECRET_CAPTURE_TITLE', url: 'https://meum.me/exhibition/preview/4348', group: '전시 프리뷰', status: 'pass', checkedAt: now(), screenshot: `/screenshots/run-1-abcdef/${rowId}.png`, checks: [{ name: 'HTTP 응답', passed: true, detail: 'SECRET_CHECK_DETAIL' }], issues: [], observed: { payload: 'SECRET_PAYLOAD' } }], businessVerification: { status: 'pass', cases: [{ status: 'pass', token: 'SECRET_AUTH' }] } });

async function fixtureFiles(source, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-safe-report-'));
  const dataDir = path.join(directory, 'data');
  const siteDir = path.join(directory, 'site');
  await mkdir(path.join(dataDir, 'screenshots/run-1-abcdef'), { recursive: true });
  await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(source));
  await writeFile(path.join(dataDir, `screenshots/run-1-abcdef/${rowId}.png`), 'synthetic capture bytes');
  await writeFile(path.join(dataDir, 'ci-state.json'), JSON.stringify({ schemaVersion: 1, mode: 'after-deploy', fingerprints: { 'https://meum.me/home': 'd'.repeat(64), 'https://private.invalid/?token=SECRET': 'e'.repeat(64) }, errors: ['SECRET_CI_ERROR'], errorFingerprint: 'f'.repeat(64), shouldRun: true, resetCycle: false }));
  try { return await callback({ directory, dataDir, siteDir }); }
  finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
}

test('public allowlist keeps only registered public selection, safe IDs and fixed 11 blocked business contracts', () => {
  const source = sourceReport();
  source.discovery.sampling.unavailable = [{ type: 'viewer', family: 'archive-viewer', reason: 'route-family-not-verified' }, { type: 'selection', reason: 'SECRET_REASON' }, { type: 'preview', family: 'oneday-preview', reason: 'no-published-public-id-and-readonly-proof' }];
  source.results.push({ ...source.results[0], id: 'e'.repeat(20), url: 'https://meum.me/exhibition/preview/9999?token=SECRET_QUERY', issues: [{ kind: 'javascript', message: 'SECRET_ERROR_TEXT' }] });
  source.results[0].issues = [{ kind: 'javascript', message: 'SECRET_ERROR_TEXT' }];
  source.results[0].policy = { readOnly: true, blockedMutatingReads: 2, private: 'SECRET_POLICY' };
  const report = publicSummary(source);
  const text = JSON.stringify(report);
  assert.equal(report.results.length, 1); assert.equal(report.withheldResults, 1);
  assert.equal(report.results[0].status, 'pass'); assert.equal(report.results[0].screenshot, null);
  assert.equal(report.results[0].policy.blockedMutatingReads, 2);
  assert.equal(report.sampling.previews[0].roomId, 4348); assert.equal(report.sampling.previews[0].hash, 'SyntheticPublicHash');
  assert.deepEqual(report.sampling.pool, { listed: 100, declared: 1000, pagesRead: 2, complete: false, bounded: true, eligible: 3 });
  assert.equal(report.sampling.unavailable[0].family, 'archive-viewer');
  assert.equal(report.sampling.unavailable[0].reason, 'route-family-not-verified');
  assert.equal(report.sampling.unavailable.find(row => row.family === 'oneday-preview').reason, 'no-published-public-id-and-readonly-proof');
  assert.equal(report.discovery.complete, false);
  assert.equal(report.inventorySignature, source.inventorySignature); assert.equal(report.continuation, true);
  assert.equal(report.businessVerification.status, 'blocked'); assert.equal(report.businessVerification.cases.length, 11);
  assert.ok(report.businessVerification.cases.every(row => row.status === 'blocked'));
  assert.doesNotMatch(text, /SECRET_|observed|payload|token|question|\.png/);
});

test('known public creator/archive/webtoon rows keep anonymous evidence without a coverage gap; unsafe identities stay omitted', () => {
  const source = sourceReport();
  const routes = ['https://meum.me/creator/ws_SECRET_CREATOR', 'https://archive.meum.me/archive/SECRET_ARCHIVE', 'https://meum.me/webtoon/SECRET_EPISODE'];
  source.results = routes.map((url, index) => ({ ...source.results[0], id: String(index + 1).repeat(20), url, status: index === 2 ? 'fail' : 'pass' }));
  source.discovery.totalTargets = 3;
  const report = publicSummary(source);
  assert.equal(report.results.length, 3); assert.equal(report.identityWithheldResults, 3); assert.equal(report.coverageOmittedResults, 0);
  assert.equal(report.discovery.complete, true); assert.equal(report.discovery.totalTargets, 3);
  assert.deepEqual(report.results.map(row => row.status), ['pass', 'pass', 'fail']);
  assert.ok(report.results.every(row => row.url === null && row.identityWithheld && row.checks.length === 1));
  assert.deepEqual(publicSummary(report).results.map(row => row.status), ['pass', 'pass', 'fail']);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_|ws_SECRET|\.png/);
  for (const url of ['https://meum.me/admin/SECRET_PRIVATE', 'https://meum.me/creator/ws_SECRET?token=SECRET_QUERY', 'https://secret:password@meum.me/webtoon/SECRET_ID']) {
    const unsafe = publicSummary({ ...source, results: [...source.results, { ...source.results[0], id: 'f'.repeat(20), url }] });
    assert.equal(unsafe.results.length, 3); assert.equal(unsafe.coverageOmittedResults, 1);
    assert.equal(unsafe.discovery.complete, false); assert.equal(unsafe.discovery.totalTargets, 4);
  }
});

test('registered archive viewer keeps its numeric public URL/null hash within the shared three-viewer limit', () => {
  const source = sourceReport();
  const archive = { roomId: 35, hash: null, family: 'archive-viewer', url: 'https://archive.meum.me/archive/viewer/35', reason: 'active-public-archive', eligible: true, observed: 'SECRET_ARCHIVE_OBSERVER' };
  const normal = roomId => ({ roomId, hash: `Synthetic${roomId}`, url: `https://meum.me/meum-lite-viewer?r=Synthetic${roomId}`, reason: 'public-active-guest-open', eligible: true });
  source.discovery.sampling.viewers = [normal(1), normal(2), archive, normal(4)];
  source.results.push({ ...source.results[0], id: '9'.repeat(20), url: archive.url, group: '3D 관람' });
  const report = publicSummary(source);
  assert.equal(report.sampling.viewers.length, 3);
  assert.deepEqual(report.sampling.viewers[2], { roomId: 35, hash: null, family: 'archive-viewer', url: archive.url, reason: 'active-public-archive', eligible: true });
  assert.equal(report.results.find(row => row.id === '9'.repeat(20)).url, archive.url);
  assert.equal(report.results.find(row => row.id === '9'.repeat(20)).status, 'pass');
  assert.deepEqual(publicSummary(report).sampling.viewers[2], report.sampling.viewers[2]);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_|Synthetic4/);
  for (const invalid of [{ ...archive, hash: 'InventedHash' }, { ...archive, url: archive.url + '?token=SECRET_QUERY' }, { ...archive, url: 'https://archive.meum.me/archive/viewer/36' }, { ...archive, reason: 'unverified' }]) {
    const changed = structuredClone(source); changed.discovery.sampling.viewers = [invalid];
    assert.equal(publicSummary(changed).sampling.viewers.length, 0);
  }
});

test('default export omits captures and old files, preserves safe continuation metadata and excludes raw CI errors', async () => {
  await fixtureFiles(sourceReport(), async ({ dataDir, siteDir }) => {
    await mkdir(siteDir); await writeFile(path.join(siteDir, 'old-private.json'), 'SECRET_OLD');
    const report = await exportReport({ dataDir, siteDir });
    assert.equal(report.results[0].status, 'pass'); assert.equal(report.results[0].screenshot, null);
    assert.deepEqual((await readdir(siteDir)).sort(), ['.monitor-ci.json', '.nojekyll', 'app.js', 'index.html', 'status.json', 'style.css'].sort());
    const bytes = await readFile(path.join(siteDir, 'status.json'), 'utf8');
    assert.doesNotMatch(bytes, /SECRET_|\.png/);
    const ci = JSON.parse(await readFile(path.join(siteDir, '.monitor-ci.json'), 'utf8'));
    assert.deepEqual(Object.keys(ci.fingerprints), ['https://meum.me/home']);
    assert.equal(ci.errorFingerprint, 'f'.repeat(64)); assert.equal(ci.shouldRun, true);
    assert.doesNotMatch(JSON.stringify(ci), /SECRET|private|errors/);
  });
  const anonymous = sourceReport(); anonymous.results[0].url = 'https://meum.me/creator/ws_SECRET_CREATOR';
  await fixtureFiles(anonymous, async ({ dataDir, siteDir }) => {
    const report = await exportReport({ dataDir, siteDir, includeScreenshots: true, copyScreenshot: async () => assert.fail('anonymous identity must never be exposed through a capture') });
    assert.equal(report.results[0].url, null); assert.equal(report.results[0].status, 'pass');
    assert.equal(report.results[0].screenshot, null); assert.equal(report.evidence.copiedScreenshots, 0);
  });
});

test('optional capture copy EACCES/ENOSPC failure never prevents current JSON and HTML export', async () => {
  for (const code of ['EACCES', 'ENOSPC']) await fixtureFiles(sourceReport(), async ({ dataDir, siteDir }) => {
    const report = await exportReport({ dataDir, siteDir, includeScreenshots: true, copyScreenshot: async (_source, destination) => { await writeFile(destination, 'partial synthetic bytes'); throw Object.assign(new Error(code), { code }); } });
    assert.equal(report.results[0].status, 'pass'); assert.equal(report.results[0].screenshot, null);
    assert.match(report.results[0].screenshotOmittedReason, /失敗|실패/);
    assert.equal(report.evidence.copiedScreenshots, 0); assert.equal(report.evidence.omittedScreenshots, 1);
    assert.ok((await stat(path.join(siteDir, 'status.json'))).size > 0);
    await assert.rejects(stat(path.join(siteDir, `screenshots/run-1-abcdef/${rowId}.png`)), { code: 'ENOENT' });
  });
});

test('missing attempt is unknown while resumed fresh attempt and partial checked rows retain their actual evidence', async () => {
  const missing = sourceReport(); missing.attemptStartedAt = '2020-01-01T00:00:00Z'; missing.startedAt = missing.attemptStartedAt;
  await fixtureFiles(missing, async ({ dataDir, siteDir }) => {
    const report = await exportReport({ dataDir, siteDir, scanStartedAt: now() });
    assert.equal(report.status, 'failed'); assert.equal(report.results[0].status, 'unknown'); assert.equal(report.discovery.complete, false);
  });
  const resumed = sourceReport(); resumed.startedAt = '2020-01-01T00:00:00Z'; resumed.status = 'running';
  await fixtureFiles(resumed, async ({ dataDir, siteDir }) => {
    const report = await exportReport({ dataDir, siteDir, scanStartedAt: resumed.attemptStartedAt });
    assert.equal(report.status, 'failed'); assert.equal(report.results[0].status, 'pass'); assert.equal(report.discovery.complete, false);
  });
  assert.equal(publicSummary({ ...sourceReport(), results: [{ ...sourceReport().results[0], checkedAt: null }] }).results[0].status, 'unknown');
  assert.throws(() => publicCiState({ schemaVersion: 2 }), /CI/);
});

describe('synthetic browser capture/privacy/read-only regressions', { skip: process.env.RUN_BROWSER_TESTS !== '1', concurrency: false }, () => {
  let browser, server, origin, directory, writes = 0;
  const rule = { selectors: ['main h1'], loading: [], errors: [] };
  const healthy = '<main><h1>Synthetic public fixture</h1><p>This synthetic page has enough visible content to prove the screen is ready for its screenshot check.</p></main>';
  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'meum-capture-browser-'));
    server = createServer((request, response) => {
      if (!['GET', 'HEAD'].includes(request.method)) writes++;
      const body = request.url === '/crash' ? healthy + '<script>setTimeout(()=>{throw Error("synthetic failure")},0)</script>' : request.url === '/canvas' ? healthy + '<canvas id="unity-canvas" width="320" height="200"></canvas><script>window.unityInstance={};let c=document.querySelector("canvas").getContext("2d");let g=c.createLinearGradient(0,0,320,200);g.addColorStop(0,"red");g.addColorStop(1,"blue");c.fillStyle=g;c.fillRect(0,0,320,200)</script>' : request.url === '/writes' ? healthy + '<script>fetch("/mutation",{method:"POST",body:"synthetic"}).catch(()=>{});new WebSocket(location.origin.replace("http","ws")+"/socket")</script>' : request.url === '/analytics' ? healthy + '<script>fetch("https://www.google-analytics.com/g/collect",{method:"POST",mode:"no-cors",body:"synthetic"}).catch(()=>{})</script>' : healthy;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><style>body{font:20px system-ui;background:linear-gradient(135deg,#abc,#def);margin:30px}main{padding:30px;background:white;border:4px solid #678;min-height:200px}</style></head><body>${body}</body></html>`);
    });
    server.on('upgrade', (_request, socket) => socket.end());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    browser = await launchBrowser();
  });
  after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const check = async (pathname, { captureFailure = false, canvasFailure = false, config = {}, targetRule = rule, destination = path.join(directory, 'captures') } = {}) => {
    const wrapped = { async newContext(options) {
      const context = await browser.newContext(options); const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        if (captureFailure) page.screenshot = async () => { throw Error('synthetic capture unavailable'); };
        if (canvasFailure) { const locator = page.locator.bind(page); page.locator = selector => selector === 'canvas#unity-canvas' ? { first() { const value = locator(selector).first(); return { isVisible: () => value.isVisible(), screenshot: async () => { throw Error('synthetic canvas unavailable'); } }; } } : locator(selector); }
        return page;
      };
      return context;
    } };
    return probe(wrapped, { id: rowId, url: origin + pathname, name: 'Synthetic fixture', rule: targetRule, viewport: { name: 'desktop', width: 900, height: 700 } }, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 500, settleMs: 100, ...config }, destination);
  };
  it('checks pixels in memory by default and keeps a successful pixel check when optional file saving fails', async () => {
    const result = await check('/healthy'); assert.equal(result.status, 'pass'); assert.equal(result.screenshot, null);
    await assert.rejects(stat(path.join(directory, 'captures')), { code: 'ENOENT' });
    const file = path.join(directory, 'not-a-directory'); await writeFile(file, 'synthetic');
    const saveFailed = await check('/healthy', { config: { captureScreenshots: true }, destination: file });
    assert.equal(saveFailed.status, 'pass'); assert.equal(saveFailed.screenshot, null); assert.match(saveFailed.screenshotOmittedReason, /저장하지 못/);
  });
  it('capture throw marks pixels unknown without inventing a navigation failure; actual JavaScript failure remains failed', async () => {
    const result = await check('/healthy', { captureFailure: true });
    assert.equal(result.status, 'unknown'); assert.equal(result.checks.find(row => row.name === '실제 화면 픽셀').passed, null);
    assert.ok(result.issues.some(row => row.kind === 'capture-unavailable')); assert.ok(!result.issues.some(row => row.kind === 'navigation'));
    const failed = await check('/crash', { captureFailure: true }); assert.equal(failed.status, 'fail'); assert.ok(failed.issues.some(row => row.kind === 'javascript'));
  });
  it('missing canvas pixels remain unknown instead of a false green', async () => {
    const result = await check('/canvas', { canvasFailure: true, targetRule: { ...rule, canvas: true, requiredGlobal: 'unityInstance' } });
    assert.equal(result.status, 'unknown'); assert.equal(result.checks.find(row => row.name === '실제 화면 픽셀').passed, null);
  });
  it('blocks public-page POST and WebSocket before the synthetic server receives a write', async () => {
    const before = writes; const result = await check('/writes');
    assert.equal(writes, before); assert.equal(result.status, 'unknown'); assert.ok(result.issues.some(row => row.kind === 'read-only-block'));
  });
  it('still blocks external analytics POST but records it without downgrading rendered service availability', async () => {
    const result = await check('/analytics');
    assert.equal(result.status, 'pass', JSON.stringify(result.issues));
    assert.equal(result.policy.blockedExternalWrites, 1); assert.equal(result.policy.blockedServiceWrites, 0);
    assert.ok(!result.issues.some(row => row.kind === 'read-only-block'));
  });
  it('boots the exported sample UI with IDs/hash/reason and 11 blocked actual-business cases, including a GitHub project subpath', async () => {
    const source = sourceReport(); source.results.push({ ...source.results[0], id: 'd'.repeat(20), url: 'https://meum.me/creator/ws_SECRET_CREATOR' });
    source.discovery.sampling.viewers.push({ roomId: 35, hash: null, family: 'archive-viewer', url: 'https://archive.meum.me/archive/viewer/35', reason: 'active-public-archive', eligible: true });
    source.results.push({ ...source.results[0], id: '9'.repeat(20), url: 'https://archive.meum.me/archive/viewer/35', group: '3D 관람' });
    await fixtureFiles(source, async ({ dataDir, siteDir }) => {
      await exportReport({ dataDir, siteDir });
      const reportServer = createServer(async (request, response) => {
        try { const filename = new URL(request.url, 'http://localhost').pathname.replace(/^\/project\//, '') || 'index.html'; response.setHeader('Content-Type', filename.endsWith('.json') ? 'application/json' : filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(path.join(siteDir, filename))); }
        catch { response.statusCode = 404; response.end(); }
      });
      await new Promise(resolve => reportServer.listen(0, '127.0.0.1', resolve));
      const context = await browser.newContext();
      try {
        const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${reportServer.address().port}/project/`);
        await page.waitForFunction(() => document.querySelector('#pass-count').textContent === '3');
        assert.match(await page.locator('.sample-scope').innerText(), /대표 표본.*전체 서비스 검증 아님/);
        assert.match(await page.locator('.business-scope').innerText(), /11개.*모두 차단/);
        assert.match(await page.locator('#sampling-pool').innerText(), /100 \/ 1000.*균등한 표본이 아닙니다/);
        await page.locator('#sampling-details summary').click();
        assert.match(await page.locator('#sampling-list').innerText(), /4348.*SyntheticPublicHash.*비인증/);
        assert.match(await page.locator('#sampling-list').innerText(), /아카이브 ID 35.*보존 전시/);
        assert.doesNotMatch(await page.locator('#sampling-list').innerText(), /해시 null/);
        assert.equal(await page.locator('.page-row[data-id="99999999999999999999"]').count(), 1);
        assert.equal(await page.locator('#overview-title').innerText(), '이번 공개 표본의 렌더링 검사 통과');
        const anonymous = page.locator(`.page-row[data-id="${'d'.repeat(20)}"]`);
        await anonymous.locator('summary').click();
        assert.match(await anonymous.innerText(), /공개 경로 식별자 비공개/);
        assert.equal(await anonymous.locator('a').count(), 0);
        assert.equal(await page.locator('a[href$="/null"]').count(), 0);
        const unavailable = sourceReport(); unavailable.discovery.sampling.unavailable = [{ type: 'viewer', family: 'archive-viewer', reason: 'route-family-not-verified' }];
        await writeFile(path.join(siteDir, 'status.json'), JSON.stringify(publicSummary(unavailable)));
        await page.reload(); await page.waitForFunction(() => document.querySelector('#coverage-badge').textContent === '표본 선택 미확인');
        await page.locator('#sampling-details summary').click();
        assert.match(await page.locator('#sampling-list').innerText(), /아카이브 관람.*미확인/);
        assert.notEqual(await page.locator('#overview-title').innerText(), '이번 공개 표본의 렌더링 검사 통과');
        assert.doesNotMatch(await page.locator('body').innerText(), /점검한 모든 페이지가 정상|SECRET_/);
        assert.deepEqual(errors, []);
      } finally { await context.close(); await new Promise(resolve => reportServer.close(resolve)); }
    });
  });
});
