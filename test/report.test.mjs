import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { aggregatePageStatus, BUSINESS_ROLE_REGISTRY, CAPABILITY_LABELS, normalizedBusiness, normalizedLayer, verificationCounts } from '../public/app.js';
import { exportReport, publicSummary } from '../export-report.mjs';
import { BUSINESS_CONTRACTS } from '../business-contracts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const now = () => new Date().toISOString();
const secret = 'SYNTHETIC_PRIVATE_VALUE_84f7';
const testCase = (patch = {}) => ({ id: 'fixture-case', name: 'Synthetic case', status: 'pass', required: true, role: 'creator', mode: 'read-only', viewport: 'desktop', evidenceScope: 'isolated-app', checkedAt: now(), checks: [{ name: 'Synthetic check', passed: true }], ...patch });
const business = (casePatch = {}, reportPatch = {}) => ({ status: 'pass', checkedAt: now(), cases: BUSINESS_CONTRACTS.map(contract => testCase({ ...casePatch, id: contract.id, role: contract.role })), ...reportPatch });
const page = (patch = {}) => ({
  id: 'fixture-page', name: 'Synthetic public page', url: 'https://fixture.invalid/public', status: 'pass', checkedAt: now(),
  layers: { render: { required: true, status: 'pass', checks: [{ name: 'Synthetic render', passed: true }] }, navigation: { required: true, status: 'pass', cases: [testCase()] }, business: { required: false, status: 'not-run', reason: '인증된 업무는 별도 시나리오에서 점검' } },
  ...patch,
});
const report = (patch = {}) => ({ schemaVersion: 2, scope: 'required-layers', status: 'completed', startedAt: now(), completedAt: now(), intervalMinutes: 60, discovery: { complete: true, totalTargets: 1, totalExhibitions: 1 }, results: [page()], ...patch });

test('legacy pass is explicitly render-only and cannot imply navigation or business pass', () => {
  const legacy = { status: 'pass', checkedAt: now() };
  assert.equal(normalizedLayer(legacy, 'render').status, 'pass');
  assert.equal(normalizedLayer(legacy, 'navigation').status, 'unregistered');
  assert.equal(normalizedLayer(legacy, 'business').status, 'unregistered');
  assert.equal(aggregatePageStatus(legacy), 'unknown');
  const summary = publicSummary(report({ results: [legacy] }));
  assert.equal(summary.results[0].scope, 'render-only');
  assert.match(summary.results[0].layers.navigation.reason, /렌더링 전용/);
  assert.equal(summary.verification.status, 'unknown');
});

test('every required layer and required case must pass; excluded work is not a pass', () => {
  assert.equal(aggregatePageStatus(page()), 'pass');
  for (const state of ['blocked', 'unregistered', 'not-run']) {
    const fixture = page(); fixture.layers.navigation.status = state;
    assert.equal(aggregatePageStatus(fixture), 'unknown', state);
  }
  const failedCase = page(); failedCase.layers.navigation.cases[0].status = 'fail';
  assert.equal(aggregatePageStatus(failedCase), 'fail');
  const missingCases = page(); missingCases.layers.navigation.cases = [];
  assert.equal(aggregatePageStatus(missingCases), 'unknown');
  const counts = verificationCounts([page()], business({ status: 'blocked' }, { status: 'blocked' }));
  assert.equal(counts.business.excluded, 1);
  assert.equal(counts.business.total, 11);
  assert.equal(counts.business.pass, 0);
  assert.equal(counts.business.blocked, 11);
});

test('fixture/component evidence cannot turn actual business verification green', () => {
  const fixtureOnly = business({ evidenceScope: 'fixture' });
  assert.equal(normalizedBusiness(fixtureOnly).status, 'blocked');
  const summary = publicSummary(report({ businessVerification: fixtureOnly, fixtureEvidence: { secret } }));
  assert.equal(summary.businessVerification.status, 'blocked');
  assert.equal(summary.verification.status, 'unknown');
  assert.equal(Object.hasOwn(summary, 'fixtureEvidence'), false);
  const realApp = publicSummary(report({ businessVerification: business() }));
  assert.equal(realApp.verification.status, 'pass');
  assert.equal(realApp.businessVerification.cases.length, 11);
  assert.equal(realApp.verification.business.pass, 11);
  assert.deepEqual(realApp.businessVerification.cases.map(item => item.role), BUSINESS_CONTRACTS.map(contract => contract.role));
  const unclocked = publicSummary(report({ businessVerification: business({ checkedAt: undefined }, { checkedAt: undefined }) }));
  assert.equal(unclocked.verification.status, 'unknown');
});

test('browser business registry matches reviewed contract IDs and roles exactly', () => {
  assert.deepEqual(BUSINESS_ROLE_REGISTRY, Object.fromEntries(BUSINESS_CONTRACTS.map(contract => [contract.id, contract.role])));
});

test('missing, duplicate, unknown and wrong-role business cases cannot produce a green summary', () => {
  const missing = business(); missing.cases.pop();
  const duplicate = business(); duplicate.cases.push({ ...duplicate.cases[0] });
  const unknown = business(); unknown.cases.push(testCase({ id: secret }));
  const wrongRole = business(); wrongRole.cases[0].role = 'payer';
  for (const [name, fixture] of [['missing', missing], ['duplicate', duplicate], ['unknown', unknown], ['role', wrongRole]]) {
    const normalized = normalizedBusiness(fixture);
    assert.notEqual(normalized.status, 'pass', name);
    const summary = publicSummary(report({ businessVerification: fixture }));
    assert.notEqual(summary.businessVerification.status, 'pass', name);
    assert.notEqual(summary.verification.status, 'pass', name);
    assert.equal(JSON.stringify(summary).includes(secret), false);
  }
  assert.equal(normalizedBusiness(missing).cases.at(-1).status, 'not-run');
  assert.equal(normalizedBusiness(duplicate).cases[0].status, 'fail');
  assert.equal(normalizedBusiness(wrongRole).cases[0].status, 'fail');
});

test('a fresh report timestamp cannot freshen a stale required business case', () => {
  const fixture = business();
  fixture.cases[0].checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const summary = publicSummary(report({ businessVerification: fixture }));
  assert.equal(summary.businessVerification.status, 'not-run');
  assert.equal(summary.businessVerification.cases[0].status, 'not-run');
  assert.equal(summary.verification.business.pass, 10);
  assert.notEqual(summary.verification.status, 'pass');
  for (const patch of [{ checkedAt: undefined }, { checks: [] }, { checks: [{ passed: false }] }]) {
    const incomplete = business(); Object.assign(incomplete.cases[0], patch);
    assert.notEqual(normalizedBusiness(incomplete).status, 'pass');
    assert.notEqual(publicSummary(report({ businessVerification: incomplete })).verification.status, 'pass');
  }
});

test('capabilities distinguish helper implementation, UI/server adapter validation and fixture proof without leaking blocker text', () => {
  const source = business({ status: 'blocked' }, { status: 'blocked' });
  source.cases[0].capabilities = { contractRegistered: true, executorImplemented: true, adapterImplemented: false, fixtureValidated: false, actualAppAdapterImplemented: false, actualAppValidated: false, adapterBlocker: `/private/${secret}`, observed: secret };
  source.cases[1].capabilities = { contractRegistered: true, executorImplemented: true, adapterImplemented: true, fixtureValidated: true, actualAppAdapterImplemented: false, actualAppValidated: false };
  source.cases[1].actualAppValidated = true;
  const local = normalizedBusiness(source);
  assert.equal(local.cases[0].capabilities.executorImplemented, true);
  assert.equal(local.cases[0].capabilities.adapterImplemented, false);
  assert.equal(local.cases[0].adapterBlocker, `/private/${secret}`);
  assert.equal(local.cases[1].capabilities.fixtureValidated, true);
  assert.equal(local.cases[1].capabilities.actualAppValidated, false);
  const summary = publicSummary(report({ businessVerification: source }));
  const first = summary.businessVerification.cases[0];
  assert.deepEqual(Object.keys(first.capabilities), Object.keys(CAPABILITY_LABELS));
  assert.ok(Object.values(first.capabilities).every(value => typeof value === 'boolean'));
  assert.equal(first.capabilities.executorImplemented, true);
  assert.equal(first.capabilities.adapterImplemented, false);
  assert.match(first.reason, /UI·서버 연결 검증이 완료되지/);
  assert.equal(summary.businessVerification.cases[1].capabilities.actualAppValidated, false);
  assert.ok(Object.values(summary.businessVerification.cases[2].capabilities).every(value => value === false));
  assert.equal(summary.businessVerification.status, 'blocked');
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('adapterBlocker'), false);
});

test('strict public allowlist withholds URLs, identities, observer objects, captures and raw failure text', () => {
  const fixture = page({ id: secret, name: `customer@example.test ${secret}`, url: `https://fixture.invalid/private?token=${secret}`, screenshot: `/screenshots/${secret}.png`, finalUrl: secret, observed: { secret }, payload: { password: secret }, issues: [{ kind: 'javascript', message: secret }, { kind: secret, message: secret }] });
  fixture.layers.navigation.status = 'fail';
  fixture.layers.navigation.cases = [testCase({ id: secret, name: secret, status: 'fail', reason: secret, role: secret, mode: secret, viewport: { name: secret, width: 1280, height: 720, token: secret }, observed: { token: secret }, request: { password: secret }, checks: [{ name: secret, passed: false, detail: secret, payload: secret }] })];
  const source = report({ runId: secret, watcherError: secret, results: [fixture], fixtureEvidence: secret, verification: { secret }, businessVerification: business({ status: 'blocked', name: secret, reason: secret, observed: { secret } }, { status: 'blocked', reason: secret, observed: { secret } }), discovery: { complete: false, source: secret, errors: [secret] }, history: [{ runId: secret, name: secret, completedAt: now(), pass: 1, fail: 0, unknown: 0, total: 1, observed: secret }] });
  const summary = publicSummary(source, { mode: 'after-deploy', errors: [secret] }, { workflowUrl: `https://github.com/example/monitor/actions?token=${secret}` });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('customer@example.test'), false);
  for (const rawField of ['observed', 'payload', 'finalUrl', 'fixtureEvidence']) assert.equal(serialized.includes(`"${rawField}":`), false, rawField);
  assert.equal(summary.results[0].status, 'fail');
  assert.equal(summary.results[0].layers.navigation.cases[0].status, 'fail');
  assert.match(summary.results[0].layers.navigation.cases[0].reason, /검사가 실패/);
  assert.equal(summary.results[0].layers.navigation.cases[0].checks[0].passed, false);
  assert.equal(summary.businessVerification.status, 'blocked');
  assert.equal(summary.results[0].url, null);
  assert.equal(summary.results[0].screenshot, null);
  assert.match(summary.results[0].screenshotOmittedReason, /고객 정보 보호/);
  assert.equal(summary.evidence.copiedScreenshots, 0);
  assert.equal(summary.history[0].scope, 'render-only');
  assert.equal(summary.workflowUrl, 'https://github.com/example/monitor/actions');
  assert.equal(source.results[0].screenshot, `/screenshots/${secret}.png`);
});

async function syntheticDirectory(run) {
  const base = path.resolve(root, 'data');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'report-synthetic-test-'));
  try { await run(directory); }
  finally { assert.equal(path.dirname(path.resolve(directory)), base); assert.ok(path.basename(directory).startsWith('report-synthetic-test-')); await rm(directory, { recursive: true, force: true }); }
}

test('export writes only safe summary assets, clears old customer exports, and never copies local evidence', async () => {
  await syntheticDirectory(async directory => {
    const dataDir = path.join(directory, 'data'), siteDir = path.join(directory, 'site');
    await mkdir(path.join(dataDir, 'screenshots'), { recursive: true });
    await mkdir(path.join(siteDir, 'screenshots'), { recursive: true });
    const capture = Buffer.from(`SYNTHETIC_CAPTURE_${secret}`);
    await writeFile(path.join(dataDir, 'screenshots', 'fixture.png'), capture);
    await writeFile(path.join(siteDir, 'screenshots', 'old.png'), 'old synthetic capture');
    await writeFile(path.join(siteDir, 'old-sensitive.json'), secret);
    const source = report({ results: [page({ screenshot: '/screenshots/fixture.png', name: secret })] });
    const original = JSON.stringify(source);
    await writeFile(path.join(dataDir, 'status.json'), original);
    const output = await exportReport({ dataDir, siteDir, workflowUrl: 'https://github.com/example/monitor/actions' });
    assert.deepEqual((await readdir(siteDir)).sort(), ['.monitor-ci.json', '.nojekyll', 'app.js', 'index.html', 'status.json', 'style.css']);
    assert.equal(output.evidence.copiedScreenshots, 0);
    assert.equal(output.results[0].screenshot, null);
    assert.match(await readFile(path.join(siteDir, 'index.html'), 'utf8'), /name="monitor-report" content="\.\/status.json"/);
    assert.equal((await readFile(path.join(siteDir, 'status.json'), 'utf8')).includes(secret), false);
    assert.deepEqual(await readFile(path.join(dataDir, 'screenshots', 'fixture.png')), capture);
    assert.equal(await readFile(path.join(dataDir, 'status.json'), 'utf8'), original);
    await assert.rejects(() => exportReport({ dataDir, siteDir, maxSiteBytes: 1 }), /용량 제한/);
  });
});

test('resumed invocation freshness is retained; absent new attempt invalidates all required passes', async () => {
  await syntheticDirectory(async directory => {
    const dataDir = path.join(directory, 'data'), siteDir = path.join(directory, 'site'); await mkdir(dataDir);
    const scanStartedAt = now();
    const source = report({ startedAt: '2026-01-01T00:00:00Z', attemptStartedAt: scanStartedAt, businessVerification: business() });
    await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(source));
    const resumed = await exportReport({ dataDir, siteDir, scanStartedAt });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.results[0].status, 'pass');
    source.attemptStartedAt = '2026-01-01T00:00:00Z';
    await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(source));
    const missing = await exportReport({ dataDir, siteDir, scanStartedAt });
    assert.equal(missing.status, 'failed'); assert.equal(missing.results[0].status, 'unknown');
    assert.equal(missing.results[0].layers.render.status, 'not-run'); assert.equal(missing.businessVerification.status, 'not-run');
    source.status = 'running'; source.attemptStartedAt = scanStartedAt;
    await writeFile(path.join(dataDir, 'status.json'), JSON.stringify(source));
    const partial = await exportReport({ dataDir, siteDir, scanStartedAt });
    assert.equal(partial.status, 'failed'); assert.equal(partial.discovery.complete, false);
    await writeFile(path.join(dataDir, 'status.json'), `{"token":"${secret}",`);
    await assert.rejects(() => exportReport({ dataDir, siteDir }), error => !error.message.includes(secret) && /원문은 출력하지/.test(error.message));
  });
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.value = ''; this.dataset = {}; this.style = {}; this.listeners = {}; this.classList = { toggle() {} }; this.text = ''; }
  get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children.flatMap(child => child?.tagName === 'fragment' ? child.children : [child]); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll(selector) { const all = this.children.flatMap(child => child && typeof child === 'object' ? [child, ...child.querySelectorAll('*')] : []); return selector === 'details[open]' ? all.filter(child => child.tagName === 'details' && child.open) : all; }
}

test('dashboard keeps headline gray when public checks pass but global business is blocked', async () => {
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const tabs = ['all', 'fail', 'pass', 'unknown'].map(filter => { const node = new Element('button'); node.dataset.filter = filter; return node; });
  const refreshLabel = new Element();
  const data = report({ publicSummary: true, readOnly: true, businessVerification: business({ status: 'blocked', reason: '격리된 업무 환경이 준비되지 않았습니다.' }, { status: 'blocked', reason: '인증 준비가 없어 실행하지 않았습니다.' }) });
  const context = { document: { baseURI: 'http://127.0.0.1/project/', getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createTextNode: text => text, createDocumentFragment: () => new Element('fragment'), querySelectorAll: () => tabs, querySelector: selector => selector === '.refresh-label' ? refreshLabel : null }, window: { location: { origin: 'http://127.0.0.1' }, open() {} }, URL, Intl, Date, Number, String, Math, Set, Object, AbortSignal, fetch: async () => ({ ok: true, json: async () => data }), setInterval() {} };
  const script = (await readFile(path.join(root, 'public', 'app.js'), 'utf8')).replace(/^export /gm, '');
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('pass-count').textContent, '1');
  assert.equal(nodes.get('overview-beacon').className, 'beacon unknown');
  assert.match(nodes.get('overview-title').textContent, /업무 검증 미완료/);
  assert.match(nodes.get('layer-summaries').textContent, /화면 렌더링/);
  assert.match(nodes.get('layer-summaries').textContent, /화면 이동/);
  assert.match(nodes.get('layer-summaries').textContent, /인증된 업무/);
  assert.match(nodes.get('layer-summaries').textContent, /차단 11/);
  assert.match(nodes.get('results').textContent, /별도 검사/);
});

test('real Chromium boots three cards with synthetic blocked, legacy and full-registry success reports', { skip: process.env.RUN_BROWSER_TESTS !== '1' }, async () => {
  const assets = Object.fromEntries(await Promise.all(['index.html', 'app.js', 'style.css'].map(async filename => [filename, await readFile(path.join(root, 'public', filename), 'utf8')])));
  let data = publicSummary(report({ businessVerification: business({ status: 'blocked' }, { status: 'blocked' }) }));
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/project/api/status') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); return; }
    const filename = pathname === '/project/' ? 'index.html' : pathname.slice('/project/'.length);
    if (!Object.hasOwn(assets, filename)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' }); response.end(assets[filename]);
  });
  let browser, context;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { launchBrowser } = await import('../probe.mjs');
    browser = await launchBrowser();
    context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const tab = await context.newPage();
    const errors = []; tab.on('pageerror', error => errors.push(error.message));
    const load = async () => { await tab.goto(origin + '/project/'); await tab.locator('#layer-summaries .layer-card').first().waitFor(); };
    await load();
    assert.equal(await tab.locator('#layer-summaries .layer-card').count(), 3);
    assert.match(await tab.locator('#overview-title').textContent(), /업무 검증 미완료/);
    assert.equal(await tab.locator('#overview-beacon').getAttribute('class'), 'beacon unknown');
    assert.match(await tab.locator('#layer-summaries .layer-card').nth(2).textContent(), /차단 11/);
    assert.equal(await tab.locator('img').count(), 0);
    await tab.locator('.page-summary').first().click();
    assert.equal(await tab.locator('.layer-details .layer-detail').count(), 3);
    data = publicSummary(report({ results: [{ status: 'pass', checkedAt: now() }] }));
    await load();
    assert.match(await tab.locator('#overview-title').textContent(), /렌더링 결과만/);
    assert.equal(await tab.locator('#pass-count').textContent(), '0');
    data = publicSummary(report({ businessVerification: business() }));
    await load();
    assert.equal(await tab.locator('#overview-beacon').getAttribute('class'), 'beacon pass');
    assert.match(await tab.locator('#layer-summaries .layer-card').nth(2).textContent(), /11 \/ 11 통과/);
    const stale = business(); stale.cases[0].checkedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    data = report({ businessVerification: stale });
    await load();
    assert.equal(await tab.locator('#overview-beacon').getAttribute('class'), 'beacon unknown');
    assert.match(await tab.locator('#layer-summaries .layer-card').nth(2).textContent(), /10 \/ 11 통과/);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close(); await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
