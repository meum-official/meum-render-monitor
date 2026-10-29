import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicSummary, exportReport } from '../export-report.mjs';
import { launchBrowser } from '../probe.mjs';

const id = 'a'.repeat(20);
const at = '2026-10-29T03:04:05.006Z';
const completedAt = '2026-10-29T03:04:05.456Z';
const sampling = () => ({ schemaVersion: 1, mode: 'representative-sample', selectedAt: new Date().toISOString(), selectionId: 'b'.repeat(20), seed: '12345678-1234-1234-1234-123456789abc', limits: { previews: 3, invitations: 3, viewers: 3 }, previews: [{ roomId: 4348, hash: 'SyntheticPublicHash', url: 'https://meum.me/exhibition/preview/4348', reason: 'public-active-guest-open', eligible: true }], invitations: [], viewers: [], unavailable: [] });
const request = (seq, extra = {}) => ({ seq, requestId: `${id}-${seq}`, at, completedAt, origin: 'https://meum.me', path: '/assets/main.0123456789.js', method: 'GET', resourceType: 'script', status: 404, blockedReason: null, policyCode: null, role: 'essential', contract: 'application-script', sourceEvidence: 'application-script', ...extra });
const diagnostic = () => ({ schemaVersion: 1, requests: [request(1), request(2, { origin: 'https://backend.meum.me', path: '/api/rooms/comment-settings/4348', resourceType: 'fetch', status: null, blockedReason: 'known-mutating-read', policyCode: 'comment-default-create', contract: 'viewer-comments', sourceEvidence: 'viewer-comments' }), request(3, { path: '/exhibition/preview/4348', resourceType: 'document', status: 200, contract: 'document', sourceEvidence: 'document' })], groups: [{ cause: 'readiness', severity: 'failure', count: 3, requestIds: [], derivedKinds: ['render-timeout', '3d-not-ready', 'loading'] }, { cause: 'http-resource', severity: 'failure', count: 1, requestIds: [`${id}-1`], derivedKinds: [] }, { cause: 'policy-block', severity: 'blocked', count: 1, requestIds: [`${id}-2`], derivedKinds: [] }], primaryCause: 'readiness', droppedRequests: 0, timeouts: { navigationMs: 30000, readinessMs: 90000 }, readiness: { state: 'failed', selectors: ['.meum-lite-viewer-container canvas#unity-canvas'], requiredGlobal: 'unityInstance', loading: ['.meum-lite-viewer-container .loading-overlay'], errorSelectors: [], elapsedMs: 90000 } });
const source = () => ({ schemaVersion: 1, status: 'completed', runId: 'run-1-abcdef', startedAt: new Date().toISOString(), attemptStartedAt: new Date().toISOString(), completedAt: new Date().toISOString(), intervalMinutes: 60, discovery: { complete: true, totalTargets: 1, totalExhibitions: 1, sampling: sampling(), errors: [] }, results: [{ id, name: 'SECRET_CUSTOMER', url: 'https://meum.me/exhibition/preview/4348', group: '전시 프리뷰', status: 'fail', checkedAt: new Date().toISOString(), checks: [{ name: 'HTTP 응답', passed: true }, { name: '브라우저 실행', passed: true }, { name: '필수 화면 요소', passed: false }, { name: '실제 화면 픽셀', passed: null }], issues: ['render-timeout', '3d-not-ready', 'loading'].map(kind => ({ kind, message: 'SECRET_RAW_ERROR' })), diagnostics: diagnostic() }] });

test('public diagnostic export preserves request identity/UTC/exact HTTP and block policy while removing arbitrary raw fields', () => {
  const raw = source();
  raw.results[0].diagnostics.headers = { Authorization: 'SECRET_AUTH' };
  raw.results[0].diagnostics.requests[0].body = 'SECRET_BODY';
  raw.results[0].diagnostics.requests[0].headers = { Cookie: 'SECRET_COOKIE' };
  raw.results[0].diagnostics.requests[0].url = 'https://private.invalid/?token=SECRET_QUERY';
  raw.results[0].diagnostics.readiness.selectors.push('.preview2 .hero__content h1', '[data-email="SECRET_CSS_PERSON"]');
  raw.results[0].diagnostics.requests.push(request(4, { origin: 'https://backend.meum.me', path: '/api/rooms/9999/viewer-entry?email=SECRET_EMAIL', resourceType: 'fetch', contract: 'viewer-room-bootstrap', sourceEvidence: 'viewer-room-bootstrap' }));
  const report = publicSummary(raw);
  const value = report.results[0].diagnostics;
  assert.equal(value.schemaVersion, 1);
  const first = value.requests.find(row => row.seq === 1);
  assert.equal(first.requestId, `${id}-1`); assert.equal(first.at, at); assert.equal(first.completedAt, completedAt);
  assert.equal(first.status, 404); assert.equal(first.method, 'GET'); assert.equal(first.resourceType, 'script');
  const blocked = value.requests.find(row => row.seq === 2);
  assert.equal(blocked.blockedReason, 'known-mutating-read'); assert.equal(blocked.policyCode, 'comment-default-create');
  assert.ok(value.requests.some(row => row.status === 200));
  assert.equal(value.primaryCause, 'readiness'); assert.equal(value.groups.filter(row => row.cause === 'readiness').length, 1);
  assert.deepEqual(value.readiness.selectors, ['.preview2 .hero__content h1']);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_|9999|Authorization|Cookie|headers|\bbody\b|HAR|token=/);
});

test('invalid diagnostic request IDs cannot cross page boundaries and truncation cannot leave a green page', () => {
  const raw = source(); raw.results[0].status = 'pass';
  raw.results[0].diagnostics.requests.push(request(4, { requestId: `${'f'.repeat(20)}-4`, path: '/PRIVATE_PERSON' }));
  const invalid = publicSummary(raw).results[0];
  assert.ok(!invalid.diagnostics?.requests.some(row => row.requestId.startsWith('f'.repeat(20))));
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_PERSON/);
  raw.results[0].diagnostics = diagnostic();
  raw.results[0].diagnostics.requests = Array.from({ length: 2001 }, (_, index) => request(index + 1, { status: 200 }));
  const truncated = publicSummary(raw).results[0];
  assert.ok(truncated.diagnostics.requests.length <= 2000); assert.ok(truncated.diagnostics.droppedRequests > 0);
  assert.equal(truncated.status, 'unknown');
  const legacy = source(); delete legacy.results[0].diagnostics;
  assert.equal(publicSummary(legacy).results[0].diagnostics, undefined);
});

async function reportFixture(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meum-diagnostic-report-'));
  const dataDir = path.join(directory, 'data'); const siteDir = path.join(directory, 'site');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(source()));
  await writeFile(path.join(dataDir, 'ci-state.json'), JSON.stringify({ schemaVersion: 1, fingerprints: {}, mode: 'after-deploy' }));
  const previous = process.env.MONITOR_DIAGNOSTIC_HOLD;
  process.env.MONITOR_DIAGNOSTIC_HOLD = 'true';
  try { const report = await exportReport({ dataDir, siteDir }); return await callback({ siteDir, report }); }
  finally { if (previous === undefined) delete process.env.MONITOR_DIAGNOSTIC_HOLD; else process.env.MONITOR_DIAGNOSTIC_HOLD = previous; assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
}

test('diagnostic hold exports an explicit paused schedule without enabling actual business execution or captures', async () => {
  await reportFixture(async ({ report }) => {
    assert.equal(report.automaticChecksPaused, true); assert.match(report.scheduleDescription, /자동 점검.*일시 중지/);
    assert.equal(report.businessVerification.status, 'blocked'); assert.equal(report.businessVerification.cases.length, 11);
    assert.equal(report.results[0].screenshot, null);
  });
});

test('synthetic dashboard groups readiness once and lazily shows UTC, request IDs, HTTP404 and exact safe block reason', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 60000 }, async () => {
  await reportFixture(async ({ siteDir }) => {
    const server = createServer(async (request, response) => {
      try { const filename = request.url === '/' ? 'index.html' : new URL(request.url, 'http://localhost').pathname.slice(1); response.setHeader('Content-Type', filename.endsWith('.json') ? 'application/json' : filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(path.join(siteDir, filename))); }
      catch { response.statusCode = 404; response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await launchBrowser(); const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => document.querySelector('#fail-count').textContent === '1');
      assert.equal(await page.locator('.request-table').count(), 0);
      const row = page.locator(`.page-row[data-id="${id}"]`); await row.locator('.page-summary').click();
      assert.equal(await row.locator('.diagnostic-group').filter({ hasText: '화면 준비 미완료' }).count(), 1);
      assert.match(await row.locator('.diagnostic-primary').innerText(), /주요 원인.*화면 준비 미완료/);
      assert.match(await row.locator('.diagnostic-readiness').innerText(), /unityInstance.*90.0초/);
      await row.locator('.request-log>summary').click();
      const table = row.locator('.request-table'); await table.waitFor();
      assert.match(await table.innerText(), /03:04:05.006 UTC/); assert.match(await table.innerText(), new RegExp(id + '-1'));
      assert.match(await table.innerText(), /HTTP 404/); assert.match(await table.innerText(), /부작용이 있는 GET\/HEAD 차단/);
      assert.match(await table.innerText(), /댓글 기본값 생성/);
      assert.match(await page.locator('#next-run').innerText(), /자동 점검.*일시 중지/);
      assert.match(await page.locator('.business-scope').innerText(), /11개.*차단/);
      assert.doesNotMatch(await page.locator('body').innerText(), /SECRET_|점검한 모든 페이지가 정상/);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
  });
});
