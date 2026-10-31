import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDiagnostics, safeLocation, validateDiagnostics } from '../diagnostic.mjs';
import { launchBrowser, probe } from '../probe.mjs';

const id = 'a'.repeat(20);
const target = { id, url: 'https://meum.me/meum-lite-viewer?r=ApprovedHash' };
const sampling = { previews: [{ roomId: 4348, hash: 'ApprovedHash', eligible: true }] };
const request = (url, type = 'fetch', method = 'GET') => ({ url: () => url, resourceType: () => type, method: () => method });
const ready = () => ({ state: 'ready', selectors: [], loading: [], errorSelectors: [], requiredGlobal: null, elapsedMs: 10 });
const limits = { navigationMs: 30000, readinessMs: 90000 };
const finishRequest = (trace, req, status) => { trace.response({ request: () => req, status: () => status }); trace.finished(req); };

test('visible media denied by the monitor stays blocked while HTTP and network errors remain failures', () => {
  for (const outcome of ['blocked', 'http', 'network', 'untracked']) {
    const trace = createDiagnostics(target, sampling), req = request('https://static.nid.naver.com/oauth/button_g.PNG', 'image');
    if (outcome === 'blocked') { trace.block(req, 'unreviewed-request'); trace.fail(req); }
    if (outcome === 'http') finishRequest(trace, req, 404);
    if (outcome === 'network') trace.fail(req);
    const failed = trace.visibleMedia(req.url());
    assert.equal(failed, outcome !== 'blocked');
    const diagnostic = trace.finish(failed ? [{ kind: 'broken-image' }] : [], ready(), limits);
    assert.equal(diagnostic.groups.some(group => group.severity === 'failure'), outcome !== 'blocked');
    if (outcome === 'blocked') assert.equal(diagnostic.groups[0].severity, 'blocked');
  }
});

test('browser distinguishes policy-denied images from actual image404 and permits login redirects', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 45000 }, async () => {
  let deniedHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/blocked.png') deniedHits++;
    if (req.url.endsWith('.png')) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<main style="padding:30px;background:linear-gradient(45deg,#abc,#fed)"><h1>Image diagnostics fixture</h1><p>Visible content and required controls are ready independently of the image request.</p><img width="100" height="100" src="${req.url === '/login' ? '/blocked.png' : '/missing.png'}"></main><script>if(location.pathname==='/login')history.replaceState({},'', '/login/info')</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    for (const [pathname, expected] of [['/login', 'unknown'], ['/broken', 'fail']]) {
      const value = await probe(browser, { ...target, url: origin + pathname, viewport: { width: 900, height: 600 }, rule: { selectors: ['main h1'] } }, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 500, settleMs: 100, publicObservationPolicy: { request: req => ({ allowed: req.url() !== origin + '/blocked.png' }) } }, 'unused');
      assert.equal(value.status, expected);
      assert.equal(value.issues.some(issue => issue.kind === 'broken-image'), expected === 'fail');
      assert.equal(value.issues.some(issue => issue.kind === 'redirect'), false);
      if (expected === 'unknown') assert.ok(value.diagnostics.groups.some(group => group.cause === 'policy-block' && group.severity === 'blocked'));
    }
    assert.equal(deniedHits, 0);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('diagnostic locations retain public build paths but never filename tails, query values or unselected identities', () => {
  for (const path of ['/assets/main-Da23N7sC.js', '/assets/main-LxnxBmbb.css', '/assets/runtime-core.esm-bundler-C5U2QBoc.js', '/unityMessage.js']) assert.equal(safeLocation('https://meum.me' + path + '?token=SECRET', { sampling }).path, path);
  for (const path of ['/uploads/photo.alice.smith.png', '/uploads/file.SECRETTOKEN123.json', '/uploads/art.alice.smith.wasm.br', '/assets/:asset-abcdef012345.SECRET.json', '/archive/PRIVATE_PERSON', '/creator/ws_PRIVATE_PERSON', '/webtoon/PRIVATE_EPISODE']) {
    const value = safeLocation('https://meum.me' + path + '?auth=SECRET', { sampling });
    assert.doesNotMatch(JSON.stringify(value), /alice|smith|SECRET|PRIVATE_|auth=/);
    assert.deepEqual(safeLocation(value.origin + value.path, { sampling }), value);
  }
  assert.equal(safeLocation('https://backend.meum.me/api/rooms/4348/password/status', { sampling }).path, '/api/rooms/4348/password/status');
  assert.equal(safeLocation('https://backend.meum.me/api/rooms/9999/password/status', { sampling }).path, '/api/rooms/:roomId/password/status');
  assert.equal(safeLocation('https://backend.meum.me/api/webtoon/episodes').path, '/api/webtoon/episodes');
  assert.equal(safeLocation('https://backend.meum.me/api/archive/rooms/4348', { sampling }).path, '/api/archive/rooms/4348');
});

test('separate retries have distinct UTC request IDs and an exact shared cause count', () => {
  const trace = createDiagnostics(target, sampling);
  const first = request('https://meum.me/assets/main-Da23N7sC.js', 'script');
  const second = request(first.url(), 'script');
  trace.ensure(first); finishRequest(trace, first, 404);
  trace.ensure(second); finishRequest(trace, second, 404);
  const value = trace.finish([], ready(), limits);
  assert.equal(value.groups.length, 1); assert.equal(value.groups[0].count, 2);
  assert.equal(new Set(value.groups[0].requestIds).size, 2);
  assert.deepEqual(value.requests.map(row => row.seq), [1, 2]);
  for (const row of value.requests) { assert.equal(row.status, 404); assert.ok(row.at.endsWith('Z') && row.responseAt.endsWith('Z') && row.completedAt.endsWith('Z')); }
});

test('HTTP200 headers followed by failed transfer retain both status and terminal network failure', () => {
  const trace = createDiagnostics(target, sampling), req = request('https://meum.me/assets/main-Da23N7sC.js', 'script');
  trace.response({ request: () => req, status: () => 200 });
  assert.equal(trace.requests[0].completedAt, null);
  trace.fail(req);
  const value = trace.finish([], ready(), limits);
  assert.equal(value.requests[0].status, 200); assert.equal(value.requests[0].blockedReason, 'network-failed');
  assert.ok(value.requests[0].responseAt && value.requests[0].completedAt);
  assert.equal(value.groups[0].cause, 'network'); assert.equal(value.groups[0].severity, 'failure');
  const rejected = request('https://meum.me/assets/main-Other123.js', 'script');
  trace.response({ request: () => rejected, status: () => 404 }); trace.fail(rejected);
  const httpGroups = trace.finish([], ready(), limits).groups;
  assert.equal(httpGroups.filter(group => group.cause === 'http-resource').length, 1);
  assert.equal(httpGroups.filter(group => group.cause === 'network').length, 1);
  const blocked = request('https://backend.meum.me/api/rooms/4348/password/status');
  trace.block(blocked, 'known-mutating-read', 'password-attempt-state'); trace.fail(blocked);
  assert.equal(trace.requests[2].blockedReason, 'known-mutating-read');
});

test('pending essential and unknown dependencies are never green; optional pending is a warning', () => {
  const trace = createDiagnostics(target, sampling);
  trace.ensure(request('https://meum.me/assets/main-Da23N7sC.js', 'script'));
  trace.ensure(request('https://backend.meum.me/unknown'));
  trace.ensure(request('https://www.google-analytics.com/g/collect', 'fetch', 'POST'));
  const value = trace.finish([], ready(), limits);
  assert.equal(value.groups.filter(row => row.severity === 'unknown').length, 2);
  assert.equal(value.groups.filter(row => row.severity === 'warning').length, 1);
});

test('a blocked required prerequisite groups readiness symptoms once while an independent script404 stays failed', () => {
  const trace = createDiagnostics(target, sampling), req = request('https://backend.meum.me/api/rooms/4348/password/status');
  trace.block(req, 'known-mutating-read', 'password-attempt-state');
  const issues = ['render-timeout', '3d-not-ready', 'loading', 'required-content'].map(kind => ({ kind }));
  let value = trace.finish(issues, ready(), limits);
  assert.equal(value.readiness.state, 'blocked'); assert.equal(value.groups.filter(row => row.cause === 'readiness').length, 1);
  assert.equal(value.groups.find(row => row.cause === 'readiness').count, 1);
  assert.equal(value.groups.some(row => row.severity === 'failure'), false);
  finishRequest(trace, request('https://meum.me/assets/main-Da23N7sC.js', 'script'), 404);
  value = trace.finish(issues, ready(), limits);
  assert.ok(value.groups.some(row => row.cause === 'http-resource' && row.severity === 'failure'));
});

test('public diagnostic validation rejects asset-tail, external path, CSS, secret-header and query injection', () => {
  const trace = createDiagnostics(target, sampling);
  finishRequest(trace, request('https://meum.me/assets/main-Da23N7sC.js', 'script'), 404);
  const value = trace.finish([], ready(), limits);
  Object.assign(value.requests[0], { origin: 'external:abcdef012345', path: '/uploads/photo.SECRET.alice.png', headers: { cookie: 'SECRET_COOKIE' }, body: 'SECRET_BODY' });
  value.readiness.selectors = ['[data-email="SECRET_PERSON"]'];
  const clean = validateDiagnostics(value, { sampling, rowId: id, targetUrl: target.url });
  assert.doesNotMatch(JSON.stringify(clean), /SECRET|alice|cookie|headers|body/);
  assert.deepEqual(clean.readiness.selectors, []);
});

test('real sendBeacon ping remains blocked and optional without hiding an independent script404', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 45000 }, async t => {
  let receivedPosts = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') { receivedPosts++; res.end('{}'); return; }
    if (req.url === '/missing-app.js') { res.writeHead(404, { 'Content-Type': 'text/javascript' }); res.end('/* missing synthetic script */'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><body style="background:linear-gradient(40deg,#cde,#edc)"><main style="padding:30px"><h1>Beacon fixture</h1><p>Visible synthetic content proves that blocked analytics do not initialize this application page.</p></main><script>navigator.sendBeacon('/analytics/ingest', '{"synthetic":true}')</script>${req.url === '/broken' ? '<script src="/missing-app.js"></script>' : ''}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    for (const [pathname, expectedStatus] of [['/healthy', 'pass'], ['/broken', 'fail']]) {
      const fixture = { ...target, url: origin + pathname, viewport: { name: 'desktop', width: 900, height: 600 }, rule: { selectors: ['main h1'] } };
      const result = await probe(browser, fixture, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 500, settleMs: 200, captureScreenshots: false }, 'unused');
      const beacon = result.diagnostics.requests.find(row => row.method === 'POST');
      assert.ok(beacon, 'the genuine navigator.sendBeacon request was observed');
      assert.equal(beacon.resourceType, 'ping');
      assert.equal(beacon.role, 'optional');
      assert.equal(beacon.contract, 'telemetry');
      assert.equal(beacon.blockedReason, 'mutating-method');
      assert.equal(beacon.status, null);
      assert.ok(result.diagnostics.groups.some(group => group.cause === 'policy-block' && group.severity === 'warning' && group.requestIds.includes(beacon.requestId)));
      const published = validateDiagnostics(result.diagnostics, { rowId: fixture.id, targetUrl: fixture.url });
      assert.equal(published.requests.find(row => row.requestId === beacon.requestId)?.resourceType, 'ping');
      assert.equal(result.status, expectedStatus, pathname);
      if (pathname === '/broken') assert.ok(result.diagnostics.groups.some(group => group.cause === 'http-resource' && group.severity === 'failure'));
      assert.equal(receivedPosts, 0, 'the server must never receive an analytics POST');
      t.diagnostic(JSON.stringify({ fixture: pathname, expectedStatus, actualStatus: result.status, resourceType: beacon.resourceType, role: beacon.role, blockedReason: beacon.blockedReason, httpStatus: beacon.status, publicResourceType: published.requests.find(row => row.requestId === beacon.requestId).resourceType, serverPostRequests: receivedPosts, independentHttpFailure: result.diagnostics.groups.some(group => group.cause === 'http-resource' && group.severity === 'failure') }));
    }
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('browser counterexamples distinguish optional warnings, unknown errors, core failures and policy-blocked readiness', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 45000 }, async () => {
  let forbiddenReads = 0;
  const healthy = '<main style="padding:30px"><h1>Diagnostic fixture</h1><p>A private synthetic screen with enough visible content to test request classification.</p></main>';
  const server = createServer((req, res) => {
    if (req.url === '/boards/list/check-new' || req.url === '/missing-app.js') { res.writeHead(404); res.end('synthetic'); return; }
    if (req.url === '/unknown-api') { res.writeHead(500); res.end('synthetic'); return; }
    if (req.url === '/api/rooms/4348/password/status') { forbiddenReads++; res.end('{}'); return; }
    if (req.url === '/cut.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Content-Length': '10000' }); res.write('/* synthetic incomplete script'); setTimeout(() => res.destroy(), 80); return; }
    const body = req.url === '/login' ? healthy + '<script>fetch("/boards/list/check-new").catch(()=>{})</script>' : req.url === '/unknown' ? healthy + '<script>fetch("/unknown-api").catch(()=>{})</script>' : req.url === '/broken' ? healthy + '<script src="/missing-app.js"></script>' : req.url === '/transport' ? healthy + '<script src="/cut.js"></script>' : healthy + '<div class="loading">Loading</div><script>fetch("/api/rooms/4348/password/status").catch(()=>{})</script>';
    res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="background:linear-gradient(40deg,#cde,#edc)">' + body + '</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser();
    const check = (path, rule = { selectors: ['main h1'] }) => probe(browser, { ...target, url: origin + path, viewport: { name: 'desktop', width: 900, height: 600 }, rule }, { origins: [origin], navigationTimeoutMs: 3000, renderTimeoutMs: 300, settleMs: 100, captureScreenshots: false, diagnosticSampling: sampling }, 'unused');
    const optional = await check('/login'); assert.equal(optional.status, 'pass');
    assert.ok(optional.diagnostics.requests.some(row => row.status === 404 && row.contract === 'optional-navigation-badge'));
    assert.ok(optional.diagnostics.groups.some(row => row.severity === 'warning'));
    const unknown = await check('/unknown'); assert.equal(unknown.status, 'unknown');
    const failed = await check('/broken'); assert.equal(failed.status, 'fail');
    const interrupted = await check('/transport'); assert.equal(interrupted.status, 'fail');
    assert.ok(interrupted.diagnostics.requests.some(row => row.status === 200 && row.blockedReason === 'network-failed'));
    const blocked = await check('/meum-lite-viewer', { selectors: ['canvas#unity-canvas'], requiredGlobal: 'unityInstance', loading: ['.loading'] });
    assert.equal(blocked.status, 'unknown'); assert.equal(forbiddenReads, 0);
    assert.equal(blocked.checks.find(row => row.name === '필수 화면 요소').passed, null);
    assert.equal(blocked.diagnostics.groups.filter(row => row.cause === 'readiness').length, 1);
    assert.equal(blocked.diagnostics.readiness.state, 'blocked');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('archive home owners dependency stays blocked without becoming a false service failure', () => {
  const archive = { id, url: 'https://archive.meum.me/' };
  const req = request('https://backend.meum.me/api/archive/owners?activeOnly=0&limit=50');
  const symptoms = [{ kind: 'required-content' }, { kind: 'error-screen' }];
  const blocked = createDiagnostics(archive);
  blocked.block(req, 'unreviewed-request');
  const diagnostic = blocked.finish(symptoms, ready(), limits);
  assert.equal(diagnostic.readiness.state, 'blocked');
  assert.equal(diagnostic.requests[0].contract, 'archive-owners');
  assert.equal(diagnostic.groups.some(group => group.severity === 'failure'), false);
  const publicValue = validateDiagnostics(diagnostic, { rowId: id, targetUrl: archive.url });
  assert.equal(publicValue.requests[0].role, 'essential');
  assert.equal(publicValue.requests[0].contract, 'archive-owners');
  const actualFailure = createDiagnostics(archive);
  finishRequest(actualFailure, req, 500);
  assert.ok(actualFailure.finish(symptoms, ready(), limits).groups.some(group => group.cause === 'http-resource' && group.severity === 'failure'));
  assert.ok(blocked.finish([...symptoms, { kind: 'javascript', message: 'independent defect' }], ready(), limits).groups.some(group => group.cause === 'javascript' && group.severity === 'failure'));
});

test('archive owner bootstrap remains blocked without hiding real failures', () => {
  const archive = { id, url: 'https://archive.meum.me/archive/synthetic?i=17' };
  for (const path of ['/api/archive/owners/17', '/api/archive/owners', '/api/archive/rooms?ownerId=17']) {
    const req = request('https://backend.meum.me' + path);
    const symptoms = [{ kind: 'required-content' }, { kind: 'error-screen' }];
    const blocked = createDiagnostics(archive); blocked.block(req, 'unreviewed-request');
    assert.equal(blocked.finish(symptoms, ready(), limits).groups.some(g => g.severity === 'failure'), false);
    const failed = createDiagnostics(archive); finishRequest(failed, req, 500);
    assert.equal(failed.finish(symptoms, ready(), limits).groups.some(g => g.cause === 'http-resource' && g.severity === 'failure'), true);
  }
});
