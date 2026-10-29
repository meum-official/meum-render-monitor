import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAutoInstallBusinessFixture } from '../fixtures/business/auto-install-server.mjs';
import { autoInstallObservation, businessRequestPermission, runBusinessScenarios, verifyBusinessEnvironment } from '../business.mjs';
import { businessContract } from '../business-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../..');
const sourcesPresent = await Promise.all([
  '8302_adminMeum-master/src/components/artwork/modal/AutoSettingBox.vue',
  '8302_adminMeum-master/src/components/common/modal/ConfirmSmallModal.vue',
  '8080_meum-backend-api-develop/meum-backend-api-develop/services/roomService.js',
  '8302_adminMeum-master/node_modules/vite/package.json',
].map(relative => access(path.join(workspace, relative)).then(() => true, () => false))).then(values => values.every(Boolean));
const skip = !sourcesPresent ? 'current approved Admin/backend source or local Vite dependencies are absent; no UI/HTTP pipeline claim' : process.env.RUN_BUSINESS_BROWSER_TESTS !== '1' ? 'opt in with RUN_BUSINESS_BROWSER_TESTS=1; no browser or fixture server started' : false;
const roleHeaders = { 'X-Meum-Monitor-Test-Role': 'owner' };
const selectedIds = [991002, 991003];
const layout = room => JSON.parse(room.data_json);

describe('actual AutoSettingBox -> approved local HTTP -> current DTO memory method', { skip, concurrency: false }, () => {
  let browser;
  before(async () => { const { launchBrowser } = await import('../probe.mjs'); browser = await launchBrowser(); });
  after(async () => { await browser?.close(); });

  async function fixtureRun(name, options, callback) {
    const directory = path.join(root, 'data/business-auto-install-validation');
    await mkdir(directory, { recursive: true });
    const testDirectory = path.join(directory, `test-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(testDirectory);
    const metadata = { name, runId: path.basename(testDirectory), startedAt: new Date().toISOString(), endedAt: null, exitCode: null, cases: 1, passed: 0, failed: 0, evidenceScope: 'actual-component-http-memory-fixture', actualAppValidated: false };
    const metadataPath = path.join(testDirectory, 'test-meta.json');
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    let fixture;
    let exitCode = 1;
    try { fixture = await createAutoInstallBusinessFixture(testDirectory, options); metadata.observed = await callback(fixture); metadata.passed = 1; exitCode = 0; }
    finally {
      metadata.endedAt = new Date().toISOString(); metadata.exitCode = exitCode; metadata.failed = exitCode ? 1 : 0; metadata.counts = fixture?.snapshot() || null;
      await fixture?.close(exitCode);
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    }
  }
  const read = async fixture => {
    const response = await fetch(`${fixture.origin}/user/room/detail?room_id=991001`, { headers: roleHeaders, redirect: 'error' });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const scenario = fixture => ({ manifestPath: fixture.manifestPath, manifestSha256: fixture.manifestSha256, scenarioIds: ['auto-install'] });
  const guardContext = async fixture => {
    const violations = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block', extraHTTPHeaders: roleHeaders });
    await context.route('**/*', async route => {
      const request = route.request(); let body = null;
      try { body = request.postDataJSON(); } catch {}
      const reason = businessRequestPermission(fixture.manifest, businessContract('auto-install'), request.method(), request.url(), body);
      if (reason) { violations.push(reason); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    await context.routeWebSocket('**/*', socket => { violations.push('unapproved websocket'); socket.close(); });
    return { context, violations };
  };
  const installFromUI = async (page, fixture, expectedStatus = 200) => {
    await page.locator('.auto-setting-box-button').waitFor();
    await page.locator('.auto-setting-box-button').click();
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms/991001/auto-install' && response.request().method() === 'POST');
    await page.locator('.modal-container .btn-primary:visible').click();
    const response = await pending;
    assert.equal(response.status(), expectedStatus);
    assert.deepEqual(response.request().postDataJSON(), { landId: 10, itemIds: selectedIds });
    await page.locator('.alert-modal__title:visible').waitFor();
    return read(fixture);
  };

  it('pins actual sources and server marker, and rejects out-of-dataset or unauthorized writes', async () => fixtureRun('source-marker-and-request-envelope', {}, async fixture => {
    const approved = await verifyBusinessEnvironment(scenario(fixture));
    assert.equal(approved.adapter, 'auto-install-component-v1');
    assert.equal(Object.keys(approved.sourceProof).length, 10);
    const marker = await (await fetch(`${fixture.origin}/.well-known/meum-monitor-isolation`)).json();
    assert.equal(marker.manifestSha256, fixture.manifestSha256);
    for (const body of [{ landId: 41, itemIds: selectedIds }, { landId: 10, itemIds: [991002, 991099] }]) {
      const result = await fetch(`${fixture.origin}/api/rooms/991001/auto-install`, { method: 'POST', headers: { ...roleHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(result.status, 403);
    }
    const denied = await fetch(`${fixture.origin}/api/rooms/991001/auto-install`, { method: 'POST', headers: { 'X-Meum-Monitor-Test-Role': 'read-only', 'Content-Type': 'application/json' }, body: JSON.stringify({ landId: 10, itemIds: selectedIds }) });
    assert.equal(denied.status, 403);
    assert.equal(fixture.snapshot().memory.saves, 0);
    assert.equal(fixture.snapshot().rejectedMutations, 3);
    return { sourcePins: 10, rejectedWrites: 3, actualAppValidated: false };
  }));

  it('actual UI POST persists item IDs/coordinates/land/startpoint/content through GET, reload and repeat', async () => fixtureRun('actual-ui-http-reload-repeat', {}, async fixture => {
    const before = await read(fixture);
    const originalInventory = await (await fetch(`${fixture.origin}/item/userItem-list?room_id=991001`, { headers: roleHeaders })).json();
    const result = await runBusinessScenarios(browser, { business: scenario(fixture) });
    const row = result.cases.find(item => item.id === 'auto-install');
    assert.equal(row.status, 'pass', row.reason);
    assert.equal(row.evidenceScope, 'fixture');
    assert.equal(row.capabilities.actualAppValidated, false);
    assert.notEqual(result.status, 'pass', 'memory UI/HTTP fixture must not claim actual app business success');
    const after = await read(fixture);
    assert.deepEqual(after.detail, before.detail);
    assert.equal(after.land_type, 10);
    assert.deepEqual(JSON.parse(after.startPoint_json), fixture.manifest.dataset.expectedStartPoint);
    const installed = layout(after).artworks.filter(item => [0, 2].includes(item.object_type_id));
    assert.deepEqual(installed.map(item => item.artwork_pk), selectedIds);
    const slots = fixture.template.artworks.filter(item => [0, 2].includes(item.object_type_id));
    for (let index = 0; index < installed.length; index++) {
      assert.deepEqual(installed[index].position, slots[index].position);
      assert.deepEqual(installed[index].eulerAngle, slots[index].eulerAngle);
      assert.equal(installed[index].scale.x, 1.5); assert.equal(installed[index].scale.z, 0.7);
    }
    assert.equal(new Set(layout(after).artworks.map(item => item.assetId)).size, layout(after).artworks.length);
    const savedInventory = await (await fetch(`${fixture.origin}/item/userItem-list?room_id=991001`, { headers: roleHeaders })).json();
    assert.deepEqual(savedInventory, originalInventory, 'independent HTTP inventory read proves original records unchanged');
    const stats = fixture.snapshot();
    assert.equal(stats.installsSucceeded, 2); assert.equal(stats.memory.saves, 2); assert.equal(stats.memory.transactions, 2);
    assert.ok(stats.independentReads >= 4);
    assert.equal(stats.productionMutations, 0); assert.equal(stats.databaseConnections, 0); assert.equal(stats.accountsCreated, 0);
    const history = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(history.filter(entry => entry.result === 'saved').length, 2);
    assert.ok(history.filter(entry => entry.result === 'ui-read').length >= 2, 'actual component reloaded and read saved server state');
    return { fixtureStatus: row.status, actualAppValidated: false, confirmedUiPosts: 2, persistedIds: 2, duplicatePlacements: 0, checksPassed: row.checks.length };
  }));

  it('success UI cannot hide an incorrect independent saved startpoint', async () => fixtureRun('optimistic-success-wrong-readback-counterexample', { readbackFault: 'wrong-startpoint' }, async fixture => {
    const result = await runBusinessScenarios(browser, { business: scenario(fixture) });
    const row = result.cases.find(item => item.id === 'auto-install');
    assert.equal(fixture.snapshot().installsSucceeded, 2, 'actual UI received two successful POST responses');
    assert.equal(row.status, 'fail');
    assert.equal(row.observed.startPointMatches, false);
    assert.ok(row.checks.some(check => check.passed === false));
    assert.equal(result.status, 'fail');
    return { expectedBusinessFailureDetected: true, actualAppValidated: false, successfulPosts: 2, independentReadbackRejected: true };
  }));

  it('retains an initial HTTP failure and proves retry/reload/repeat without duplicate placements', async () => fixtureRun('failure-history-followed-by-safe-retry', { failNextInstall: true }, async fixture => {
    const { context, violations } = await guardContext(fixture);
    try {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${fixture.origin}/artwork`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const before = await read(fixture);
      const failed = await installFromUI(page, fixture, 503);
      assert.deepEqual(failed, before);
      await page.locator('.alert-modal__btn .btn:visible').click();
      const first = await installFromUI(page, fixture);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const second = await installFromUI(page, fixture);
      const observed = autoInstallObservation(before, first, second, selectedIds, fixture.manifest.dataset.expectedStartPoint, 10);
      assert.ok(Object.values(observed).every(Boolean));
      const stats = fixture.snapshot();
      assert.equal(stats.installsAttempted, 3); assert.equal(stats.installsFailed, 1); assert.equal(stats.installsSucceeded, 2); assert.equal(stats.memory.saves, 2);
      const history = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(history.filter(entry => ['synthetic-failure', 'saved'].includes(entry.result)).map(entry => entry.result), ['synthetic-failure', 'saved', 'saved']);
      assert.deepEqual(violations, []); assert.deepEqual(errors, []);
      return { preservedFailures: 1, successfulRetries: 2, memorySaves: 2, duplicatePlacements: 0, actualAppValidated: false };
    } finally { await context.close(); }
  }));
});
